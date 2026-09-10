const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const { Client, RemoteAuth } = require('whatsapp-web.js');
const { createClient } = require('@supabase/supabase-js');
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

// ---------- DATABASE SETUP ----------
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_settings (id TEXT PRIMARY KEY, value JSONB, updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS bot_schedules (id SERIAL PRIMARY KEY, chat_id TEXT NOT NULL, cron_expression TEXT NOT NULL, message TEXT NOT NULL, active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT NOW());
  `);
  console.log('✅ Database ready');
}
initDb().catch(err => console.error('❌ DB init error:', err));

// ---------- CUSTOM SESSION STORE ----------
class CustomSupabaseStore {
  constructor(supabaseClient) {
    this.supabase = supabaseClient;
    this.table = 'whatsapp_sessions';
  }
  async sessionExists({ session }) {
    const { data } = await this.supabase.from(this.table).select('session_id').eq('session_id', session).maybeSingle();
    return !!data;
  }
  async save({ session, data }) {
    const { error } = await this.supabase.from(this.table).upsert({ session_id: session, data: data, updated_at: new Date().toISOString() });
    if (error) throw error;
  }
  async extract({ session }) {
    const { data } = await this.supabase.from(this.table).select('data').eq('session_id', session).maybeSingle();
    return data ? data.data : null;
  }
  async delete({ session }) {
    const { error } = await this.supabase.from(this.table).delete().eq('session_id', session);
    if (error) throw error;
  }
}

// ---------- AI SETUP ----------
const OWNER_NUMBER = process.env.OWNER_NUMBER;
const openai = new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: 'https://api.groq.com/openai/v1' });
const rssParser = new Parser();
let currentMode = 'normal';

// MODE-BASED SYSTEM PROMPTS (These make the AI behave differently)
const MODE_PROMPTS = {
  normal: 'You are a friendly and helpful WhatsApp bot. You chat naturally, understand context, and reply intelligently.',
  hungry: 'You are a food-loving bot. You ALWAYS bring up food, snacks, or eating. When someone asks anything, you find a way to mention how hungry you are. Be playful and funny about it.',
  happy: 'You are a super cheerful and optimistic bot. You are always smiling, cracking positive jokes, and spreading good vibes. You reply with enthusiasm and joy.',
  sleepy: 'You are a sleepy, tired bot. You yawn, you talk slowly, you reply with lazy, drowsy messages. You often mention how much you want to sleep.',
  pickupline: 'You are a flirty, romantic bot. You use clever, charming pickup lines as part of your replies. Be playful and respectful.'
};

// ---------- WHATSAPP CLIENT ----------
const client = new Client({
  authStrategy: new RemoteAuth({
    clientId: 'whatsapp-bot',
    store: new CustomSupabaseStore(supabase),
    backupSyncIntervalMs: 60000,
    dataPath: '/tmp'
  }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--no-zygote', '--single-process']
  }
});

let latestQr = null;

client.on('loading_screen', (percent, message) => console.log(`📥 Loading Chrome: ${percent}% - ${message}`));
client.on('qr', async (qr) => {
  console.log('\n📱 QR Code generated - Scan within 10 minutes');
  console.log(qr);
  const qrImage = await qrcode.toDataURL(qr);
  latestQr = qrImage;
  io.emit('qr', qrImage);
});

client.on('ready', async () => {
  console.log('✅ WhatsApp client is ready!');
  io.emit('ready');
  // Load mode from DB
  try {
    const res = await pool.query('SELECT value FROM bot_settings WHERE id=$1', ['ai_mode']);
    if (res.rows.length > 0 && res.rows[0].value?.mode in MODE_PROMPTS) {
      currentMode = res.rows[0].value.mode;
      console.log('✅ Mode loaded:', currentMode);
    }
  } catch (err) { console.error('Load mode error:', err.message); }
  if (OWNER_NUMBER) {
    try {
      await client.sendMessage(`${OWNER_NUMBER}@c.us`, '🤖 Bot is online! Current mode: *' + currentMode + '*');
    } catch (err) { console.error('Welcome message error:', err.message); }
  }
});

client.on('auth_failure', (msg) => { console.error('❌ Auth failed:', msg); io.emit('auth_failure', msg); });
client.on('disconnected', (reason) => { console.warn('⚠️ Disconnected:', reason); io.emit('disconnected', reason); });

// ---------- DASHBOARD ----------
async function sendDashboardData() {
  try {
    const chats = await client.getChats();
    const chatList = chats.map(chat => ({ id: chat.id._serialized, name: chat.name || chat.id.user, isGroup: chat.isGroup }));
    io.emit('dashboard_data', { connectedNumber: client.info.wid.user, chats: chatList, currentMode });
  } catch (error) { console.error('Error getting chats:', error.message); }
}

// ---------- SOCKET EVENTS ----------
io.on('connection', (socket) => {
  if (client.info && client.info.wid) {
    socket.emit('ready');
    sendDashboardData();
  } else if (latestQr) {
    socket.emit('qr', latestQr);
  }

  // Receive mode change from control center
  socket.on('set_mode', async (mode) => {
    if (MODE_PROMPTS[mode]) {
      currentMode = mode;
      // Save to DB
      await pool.query('INSERT INTO bot_settings (id, value) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET value=$2, updated_at=NOW()', ['ai_mode', { mode }]);
      io.emit('mode_updated', mode);
      console.log('✅ Mode changed to:', mode);
    }
  });

  // Send to specific chats
  socket.on('send_to_chats', async (data) => {
    const { chatIds, message } = data;
    if (!chatIds || !message) return;
    try {
      for (const id of chatIds) await client.sendMessage(id, message);
      socket.emit('send_result', { success: true });
    } catch (error) {
      socket.emit('send_result', { success: false, error: error.message });
    }
  });
});

// ---------- AI GENERATION WITH CONTEXT ----------
async function generateAIReply(chatId, userText) {
  try {
    // Get last 10 messages from this chat for context
    const chat = await client.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 10 });
    const history = messages.map(m => ({
      role: m.fromMe ? 'assistant' : 'user',
      content: m.body
    })).filter(m => m.content && m.content.length > 0);

    // Add the current message
    history.push({ role: 'user', content: userText });

    const systemPrompt = MODE_PROMPTS[currentMode] || MODE_PROMPTS.normal;
    const completion = await openai.chat.completions.create({
      model: 'llama3-8b-8192',
      messages: [{ role: 'system', content: systemPrompt }, ...history],
      max_tokens: 200,
      temperature: 0.8,
    });
    return completion.choices[0].message.content.trim();
  } catch (error) {
    console.error('AI Error:', error.message);
    return '😅 Sorry, I had a glitch. Please try again later.';
  }
}

// ---------- MAIN MESSAGE HANDLER ----------
client.on('message', async (message) => {
  if (message.fromMe) return;
  const chatId = message.from;
  const isOwner = OWNER_NUMBER && chatId === `${OWNER_NUMBER}@c.us`;

  if (isOwner) {
    const text = message.body.trim();
    if (text.startsWith('!')) {
      const command = text.slice(1).toLowerCase();
      try {
        if (command.startsWith('help')) {
          await message.reply('Commands:\n!setmode <mode>\n!send <phone> <msg>\n!broadcast <msg>\n\nModes: normal, hungry, happy, sleepy, pickupline');
        }
        else if (command.startsWith('setmode')) {
          const mode = command.split(' ')[1];
          if (MODE_PROMPTS[mode]) {
            currentMode = mode;
            await pool.query('INSERT INTO bot_settings (id, value) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET value=$2, updated_at=NOW()', ['ai_mode', { mode }]);
            await message.reply(`✅ Mode changed to *${mode}*`);
          } else {
            await message.reply('Invalid mode. Use: normal, hungry, happy, sleepy, pickupline');
          }
        }
        else if (command.startsWith('send')) {
          const parts = command.split(' ');
          await client.sendMessage(`${parts[1]}@c.us`, parts.slice(2).join(' '));
          await message.reply('✅ Sent!');
        }
        else await message.reply('Unknown command. Use !help');
      } catch (err) { await message.reply(`❌ Error: ${err.message}`); }
      return;
    }
    // Owner chats with AI
    const reply = await generateAIReply(chatId, text);
    await message.reply(reply);
    return;
  }

  // NON-OWNER: Auto-reply with context + forward to owner
  if (OWNER_NUMBER) {
    try {
      const ownerChat = await client.getChatById(`${OWNER_NUMBER}@c.us`);
      await ownerChat.sendMessage(`📩 Message from ${message.from}: ${message.body}`);
    } catch (err) { console.error('Forward failed:', err.message); }
  }

  const reply = await generateAIReply(chatId, message.body);
  await message.reply(reply);
});

// ---------- START ----------
console.log('🚀 Initializing WhatsApp Client...');
client.initialize().catch(err => console.error("❌ CRITICAL: Failed to initialize WhatsApp Client", err));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));
