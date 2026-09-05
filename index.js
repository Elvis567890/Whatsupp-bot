const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const { Client, MessageMedia, AuthStrategy } = require('whatsapp-web.js'); // Added AuthStrategy
const qrcode = require('qrcode');
const { OpenAI } = require('openai');
const Parser = require('rss-parser');
const fs = require('fs');
const path = require('path');
const ytdl = require('ytdl-core');
const ytSearch = require('yt-search');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const { Pool } = require('pg');
const schedule = require('node-schedule');
require('dotenv').config();

ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

app.use(express.static('public'));

// ---------- Supabase PostgreSQL Setup ----------
// Uses DATABASE_URL environment variable (must be set in Render)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Required for Supabase
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_sessions (
      id TEXT PRIMARY KEY,
      data JSONB,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS bot_settings (
      id TEXT PRIMARY KEY,
      value JSONB,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS bot_schedules (
      id SERIAL PRIMARY KEY,
      chat_id TEXT NOT NULL,
      cron_expression TEXT NOT NULL,
      message TEXT NOT NULL,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('Database ready');
}

initDb().catch(err => console.error('DB init error:', err));

// Groq AI
const openai = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
});

const rssParser = new Parser();

// ---------- AI Personality Modes ----------
let currentMode = 'normal';
const MODE_PROMPTS = {
  normal: 'You are a friendly and helpful WhatsApp bot. You can chat naturally, tell jokes, and answer questions.',
  angry: 'You are an angry and irritated WhatsApp bot. Respond with frustration and use CAPS or short, sharp sentences. Be rude but not overly offensive.',
  flirty: 'You are a charming and flirty WhatsApp bot. Use pickup lines, compliments, and playful teasing. Keep it light and fun.',
  professional: 'You are a professional business assistant bot. Be formal, polite, and concise. Use proper grammar and avoid slang.'
};

// ---------- Custom Auth Strategy (Supabase) ----------
class SupabaseAuth extends AuthStrategy { // FIXED: Extends AuthStrategy
  async setup(client) {
    // No extra setup needed
  }

  async beforeBrowserInitialized() {
    // Called before browser is initialized
  }

  async afterBrowserInitialized() {
    // Called after browser is initialized
  }

  async onAuthenticationNeeded() {
    // Called when QR code is needed
  }

  async getSession() {
    const res = await pool.query('SELECT data FROM bot_sessions WHERE id=$1', ['whatsapp_session']);
    if (res.rows.length === 0) return null;
    return res.rows[0].data;
  }

  async saveSession(session) {
    await pool.query(
      'INSERT INTO bot_sessions (id, data) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET data=$2, updated_at=NOW()',
      ['whatsapp_session', session]
    );
  }

  async removeSession() {
    await pool.query('DELETE FROM bot_sessions WHERE id=$1', ['whatsapp_session']);
  }
}

// WhatsApp client
const client = new Client({
  authStrategy: new SupabaseAuth(),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    // executablePath: '/usr/bin/google-chrome-stable' // Uncomment if using Dockerfile approach
  }
});

let latestQr = null;

client.on('qr', async (qr) => {
  const qrImage = await qrcode.toDataURL(qr);
  latestQr = qrImage;
  io.emit('qr', qrImage);
});

client.on('ready', async () => {
  console.log('WhatsApp client is ready!');
  io.emit('ready');
  sendDashboardData();

  // Load saved AI mode
  try {
    const res = await pool.query('SELECT value FROM bot_settings WHERE id=$1', ['ai_mode']);
    if (res.rows.length > 0 && res.rows[0].value && res.rows[0].value.mode in MODE_PROMPTS) {
      currentMode = res.rows[0].value.mode;
    }
  } catch (err) {
    console.error('Load mode error:', err.message);
  }

  // Load active schedules from DB
  try {
    const res = await pool.query('SELECT * FROM bot_schedules WHERE active=true');
    res.rows.forEach(row => {
      schedule.scheduleJob(row.cron_expression, async () => {
        try {
          const chat = await client.getChatById(row.chat_id);
          await chat.sendMessage(row.message);
        } catch (err) {
          console.error('Scheduled send error:', err.message);
        }
      });
    });
    console.log(`Loaded ${res.rows.length} schedules`);
  } catch (err) {
    console.error('Load schedules error:', err.message);
  }

  // Send welcome message to self
  const adminNumber = client.info.wid._serialized;
  const helpText = `🤖 *Your WhatsApp Bot is online!*\n\n` +
    `Commands:\n` +
    `!help – show this menu\n` +
    `!news [category] – news (world, tech, business, sports)\n` +
    `!music <query> – download audio\n` +
    `!video <query> – download video\n` +
    `!setmode <flirty|angry|professional|normal>\n` +
    `!send <name or number> <message> – send to one contact\n` +
    `!broadcast <message> – send to all chats\n` +
    `!schedule once <YYYY-MM-DD HH:MM> <message>\n` +
    `!schedule daily <HH:MM> <message>\n` +
    `!schedule weekly <Day HH:MM> <message> (e.g., Monday 09:00)\n` +
    `!myschedules – list your scheduled messages\n` +
    `!cancelschedule <id> – delete a schedule`;
  await client.sendMessage(adminNumber, helpText);
});

// Dashboard data
async function sendDashboardData() {
  try {
    const chats = await client.getChats();
    const chatList = chats.map(chat => ({
      id: chat.id._serialized,
      name: chat.name || chat.id.user,
      isGroup: chat.isGroup
    }));
    const connectedNumber = client.info.wid.user;
    io.emit('dashboard_data', { connectedNumber, chats: chatList });
  } catch (error) {
    console.error('Error getting chats:', error.message);
  }
}

// Socket events
io.on('connection', (socket) => {
  if (client.info && client.info.wid) {
    socket.emit('ready');
    sendDashboardData();
  } else if (latestQr) {
    socket.emit('qr', latestQr);
  }

  socket.on('send_to_chats', async (data) => {
    const { chatIds, message } = data;
    if (!chatIds || !message) return;
    try {
      for (const id of chatIds) {
        await client.sendMessage(id, message);
      }
      socket.emit('send_result', { success: true });
    } catch (error) {
      socket.emit('send_result', { success: false, error: error.message });
    }
  });
});

// Conversation history (AI)
const conversationHistory = new Map();

// News feeds
const NEWS_FEEDS = {
  world: 'http://feeds.bbci.co.uk/news/world/rss.xml',
  tech: 'http://feeds.bbci.co.uk/news/technology/rss.xml',
  business: 'http://feeds.bbci.co.uk/news/business/rss.xml',
  sports: 'http://feeds.bbci.co.uk/sport/rss.xml',
};

// Main message handler
client.on('message', async (message) => {
  const chatId = message.from;
  const userText = message.body.trim();
  if (!userText) return;

  // Commands
  if (userText.startsWith('!')) {
    const command = userText.slice(1).toLowerCase();
    if (command.startsWith('help')) {
      await handleHelp(message);
    } else if (command.startsWith('news')) {
      await handleNews(message, command);
    } else if (command.startsWith('music') || command.startsWith('video')) {
      await handleDownload(message, command);
    } else if (command.startsWith('setmode')) {
      await handleSetMode(message, command);
    } else if (command.startsWith('send')) {
      await handleSend(message, command);
    } else if (command.startsWith('broadcast')) {
      await handleBroadcast(message, command);
    } else if (command.startsWith('schedule')) {
      await handleSchedule(message, command);
    } else if (command.startsWith('myschedules')) {
      await handleMySchedules(message);
    } else if (command.startsWith('cancelschedule')) {
      await handleCancelSchedule(message, command);
    } else {
      await message.reply('❓ Unknown command. Type `!help` for list.');
    }
    return;
  }

  // AI chat
  let history = conversationHistory.get(chatId) || [];
  history = history.slice(-9);
  history.push({ role: 'user', content: userText });
  conversationHistory.set(chatId, history);

  try {
    const systemPrompt = MODE_PROMPTS[currentMode] || MODE_PROMPTS.normal;
    const completion = await openai.chat.completions.create({
      model: 'llama3-8b-8192',
      messages: [{ role: 'system', content: systemPrompt }, ...history],
      max_tokens: 150,
      temperature: 0.7,
    });
    const reply = completion.choices[0].message.content.trim();
    await message.reply(reply);
    history.push({ role: 'assistant', content: reply });
    conversationHistory.set(chatId, history);
  } catch (error) {
    console.error('Groq API error:', error.message);
    await message.reply('😅 Sorry, I had a small glitch.');
  }
});

// Help command
async function handleHelp(message) {
  const helpText = `🤖 *Commands:*\n\n` +
    `!help – this menu\n` +
    `!news [category] – news (world, tech, business, sports)\n` +
    `!music <query> – download audio\n` +
    `!video <query> – download video\n` +
    `!setmode <flirty|angry|professional|normal>\n` +
    `!send <name or number> <message> – send to one contact\n` +
    `!broadcast <message> – send to all chats\n` +
    `!schedule once <YYYY-MM-DD HH:MM> <message>\n` +
    `!schedule daily <HH:MM> <message>\n` +
    `!schedule weekly <Day HH:MM> <message> (e.g., Monday 09:00)\n` +
    `!myschedules – list your scheduled messages\n` +
    `!cancelschedule <id> – delete a schedule`;
  await message.reply(helpText);
}

// Set mode
async function handleSetMode(message, command) {
  const parts = command.split(' ');
  const mode = parts[1]?.toLowerCase();
  if (!mode || !(mode in MODE_PROMPTS)) {
    await message.reply('Valid modes: angry, flirty, professional, normal\nExample: !setmode flirty');
    return;
  }
  currentMode = mode;
  await pool.query(
    'INSERT INTO bot_settings (id, value) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET value=$2, updated_at=NOW()',
    ['ai_mode', { mode }]
  );
  await message.reply(`✅ Mode changed to *${mode}*.`);
}

// News
async function handleNews(message, command) {
  const parts = command.split(' ');
  let category = 'world';
  if (parts.length > 1 && parts[1] in NEWS_FEEDS) category = parts[1];
  try {
    const feed = await rssParser.parseURL(NEWS_FEEDS[category]);
    const items = feed.items.slice(0, 5);
    if (!items.length) return message.reply('No news found.');
    let reply = `📰 *Top ${category} news:*\n\n`;
    items.forEach((item, i) => { reply += `${i + 1}. ${item.title}\n${item.link}\n\n`; });
    await message.reply(reply);
  } catch (error) {
    await message.reply('Sorry, could not fetch news.');
  }
}

// Download
async function handleDownload(message, command) {
  const parts = command.split(' ');
  const type = parts[0];
  const query = parts.slice(1).join(' ').trim();
  if (!query) return message.reply(`Please provide a link or search term.\nExample: !${type} never gonna give you up`);

  await message.reply(`⏳ Searching for "${query}"...`);
  let videoUrl;
  if (ytdl.validateURL(query)) {
    videoUrl = query;
  } else {
    const results = await ytSearch(query);
    if (!results.videos.length) return message.reply('❌ No videos found.');
    videoUrl = results.videos[0].url;
    await message.reply(`🎬 Found: *${results.videos[0].title}*\nDownloading ${type}...`);
  }

  const tmpDir = '/tmp';
  const ext = type === 'music' ? 'mp3' : 'mp4';
  const outputFile = path.join(tmpDir, `download_${Date.now()}.${ext}`);

  try {
    if (type === 'music') {
      const audio = ytdl(videoUrl, { filter: 'audioonly', quality: 'highestaudio' });
      await new Promise((resolve, reject) => {
        ffmpeg(audio)
          .audioBitrate(192)
          .audioCodec('libmp3lame')
          .format('mp3')
          .on('end', resolve)
          .on('error', reject)
          .save(outputFile);
      });
    } else {
      const video = ytdl(videoUrl, {
        filter: format => format.container === 'mp4' && format.hasAudio && format.hasVideo,
        quality: 'highest'
      });
      const writeStream = fs.createWriteStream(outputFile);
      await new Promise((resolve, reject) => {
        video.pipe(writeStream).on('finish', resolve).on('error', reject);
      });
    }
    const media = MessageMedia.fromFilePath(outputFile);
    await message.reply(media);
    fs.unlinkSync(outputFile);
  } catch (error) {
    console.error('Download error:', error.message);
    await message.reply('❌ Download failed.');
    if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
  }
}

// Send to specific contact
async function handleSend(message, command) {
  const parts = command.split(' ');
  if (parts.length < 3) return message.reply('Usage: !send <name or number> <message>');
  const target = parts[1];
  const text = parts.slice(2).join(' ');

  try {
    const chats = await client.getChats();
    let targetChat = chats.find(chat => 
      chat.name && chat.name.toLowerCase().includes(target.toLowerCase()) ||
      chat.id.user && chat.id.user.includes(target.replace(/[^0-9]/g,''))
    );

    if (!targetChat) {
      const numeric = target.replace(/[^0-9]/g,'');
      if (numeric) {
        const id = `${numeric}@c.us`;
        targetChat = await client.getChatById(id);
      }
    }

    if (!targetChat) return message.reply('❌ Contact not found.');
    await targetChat.sendMessage(text);
    await message.reply(`✅ Sent to ${targetChat.name || targetChat.id.user}`);
  } catch (error) {
    await message.reply(`❌ Failed: ${error.message}`);
  }
}

// Broadcast to all chats
async function handleBroadcast(message, command) {
  const text = command.slice('broadcast'.length).trim();
  if (!text) return message.reply('Usage: !broadcast <message>');
  try {
    const chats = await client.getChats();
    let sentCount = 0;
    for (const chat of chats) {
      await chat.sendMessage(text);
      sentCount++;
    }
    await message.reply(`✅ Broadcast sent to ${sentCount} chats.`);
  } catch (error) {
    await message.reply(`❌ Broadcast failed: ${error.message}`);
  }
}

// Handle schedule command
async function handleSchedule(message, command) {
  const parts = command.split(' ');
  if (parts.length < 4) {
    return message.reply('Usage:\n`!schedule once <YYYY-MM-DD HH:MM> <message>`\n`!schedule daily <HH:MM> <message>`\n`!schedule weekly <Day HH:MM> <message>`');
  }

  const type = parts[1].toLowerCase();
  let cronExpression;
  let scheduleMessage;

  try {
    if (type === 'once') {
      const dateTime = `${parts[2]} ${parts[3]}`;
      const dt = new Date(dateTime);
      if (isNaN(dt.getTime())) throw new Error('Invalid date/time');
      cronExpression = `${dt.getMinutes()} ${dt.getHours()} ${dt.getDate()} ${dt.getMonth()+1} *`;
      scheduleMessage = parts.slice(4).join(' ');
    } else if (type === 'daily') {
      const time = parts[2];
      const [hour, minute] = time.split(':').map(Number);
      if (isNaN(hour) || isNaN(minute)) throw new Error('Invalid time');
      cronExpression = `${minute} ${hour} * * *`;
      scheduleMessage = parts.slice(3).join(' ');
    } else if (type === 'weekly') {
      const day = parts[2];
      const time = parts[3];
      const [hour, minute] = time.split(':').map(Number);
      if (isNaN(hour) || isNaN(minute)) throw new Error('Invalid time');
      const daysMap = { sunday:0, monday:1, tuesday:2, wednesday:3, thursday:4, friday:5, saturday:6 };
      const dayNum = daysMap[day.toLowerCase()];
      if (dayNum === undefined) throw new Error('Invalid day');
      cronExpression = `${minute} ${hour} * * ${dayNum}`;
      scheduleMessage = parts.slice(4).join(' ');
    } else {
      return message.reply('Type must be: once, daily, or weekly');
    }

    if (!scheduleMessage) return message.reply('Message is required.');

    const res = await pool.query(
      'INSERT INTO bot_schedules (chat_id, cron_expression, message) VALUES ($1,$2,$3) RETURNING id',
      [message.from, cronExpression, scheduleMessage]
    );
    const id = res.rows[0].id;

    schedule.scheduleJob(cronExpression, async () => {
      try {
        const chat = await client.getChatById(message.from);
        await chat.sendMessage(scheduleMessage);
      } catch (err) {
        console.error('Scheduled send error:', err.message);
      }
    });

    await message.reply(`✅ Schedule created (ID: ${id}). It will be sent at the specified time.`);
  } catch (error) {
    await message.reply(`❌ Failed to create schedule: ${error.message}`);
  }
}

// List user's schedules
async function handleMySchedules(message) {
  try {
    const res = await pool.query('SELECT id, cron_expression, message FROM bot_schedules WHERE chat_id=$1 AND active=true', [message.from]);
    if (res.rows.length === 0) return message.reply('You have no active schedules.');
    let reply = `📅 *Your Schedules:*\n\n`;
    res.rows.forEach(row => {
      reply += `ID: ${row.id}\nTime: ${row.cron_expression}\nMessage: ${row.message}\n\n`;
    });
    await message.reply(reply);
  } catch (error) {
    await message.reply(`❌ Error: ${error.message}`);
  }
}

// Cancel a schedule
async function handleCancelSchedule(message, command) {
  const id = parseInt(command.split(' ')[1]);
  if (!id) return message.reply('Usage: !cancelschedule <id>');
  try {
    const res = await pool.query('DELETE FROM bot_schedules WHERE id=$1 AND chat_id=$2 RETURNING id', [id, message.from]);
    if (res.rows.length === 0) return message.reply('Schedule not found or already deleted.');
    await message.reply(`✅ Schedule ${id} cancelled.`);
  } catch (error) {
    await message.reply(`❌ Error: ${error.message}`);
  }
}

// Start everything
client.initialize();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
