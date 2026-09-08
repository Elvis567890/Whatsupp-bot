const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const { Client, RemoteAuth } = require('whatsapp-web.js');
const { SupabaseStore } = require('wwebjs-supabase');
const { createClient } = require('@supabase/supabase-js');
const qrcode = require('qrcode');
const { OpenAI } = require('openai');
const Parser = require('rss-parser');
const fs = require('fs');
const fsExtra = require('fs-extra');
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
const pool = new Pool({ 
  connectionString: process.env.DATABASE_URL, 
  ssl: { rejectUnauthorized: false } 
});

async function initDb() {
  await pool.query(`
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
  console.log('✅ Database ready');
}
initDb().catch(err => console.error('❌ DB init error:', err));

// ---------- AI SETUP ----------
const OWNER_NUMBER = process.env.OWNER_NUMBER;
const openai = new OpenAI({ 
  apiKey: process.env.GROQ_API_KEY, 
  baseURL: 'https://api.groq.com/openai/v1' 
});
const rssParser = new Parser();
let currentMode = 'normal';

const MODE_PROMPTS = {
  normal: 'You are a friendly and helpful WhatsApp bot. You can chat naturally, tell jokes, and answer questions.',
  angry: 'You are an angry and irritated WhatsApp bot. Respond with frustration and use CAPS or short, sharp sentences. Be rude but not overly offensive.',
  flirty: 'You are a charming and flirty WhatsApp bot. Use pickup lines, compliments, and playful teasing. Keep it light and fun.',
  professional: 'You are a professional business assistant bot. Be formal, polite, and concise. Use proper grammar and avoid slang.'
};

// ---------- TRUSTED SESSION STORE (wwebjs-supabase) ----------
console.log('🚀 Attempting to start WhatsApp Client...');

const client = new Client({
  authStrategy: new RemoteAuth({
    clientId: 'whatsapp-bot',
    store: new SupabaseStore({ 
      supabase, 
      tableName: 'whatsapp_sessions' 
    }),
    backupSyncIntervalMs: 60000,
    dataPath: '/tmp'
  }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox', 
      '--disable-setuid-sandbox', 
      '--disable-dev-shm-usage', 
      '--no-zygote', 
      '--single-process'
    ]
  }
});

let latestQr = null;

client.on('loading_screen', (percent, message) => {
  console.log(`📥 Loading Chrome: ${percent}% - ${message}`);
});

client.on('qr', async (qr) => {
  console.log('\n📱 QR Code generated (New) - Scan this within 10 minutes');
  console.log(qr);
  console.log('----------------------------------------\n');

  const qrImage = await qrcode.toDataURL(qr);
  latestQr = qrImage;
  io.emit('qr', qrImage);
});

client.on('ready', async () => {
  console.log('✅ WhatsApp client is ready!');
  io.emit('ready');

  if (OWNER_NUMBER) {
    try {
      const helpText = `🤖 *Bot is online!*\n\n` +
        `Commands:\n` +
        `!help – show this menu\n` +
        `!setmode <flirty|angry|professional|normal>\n` +
        `!send <phone> <message> – send to a contact\n` +
        `!news – top world news\n` +
        `!music <query> – download audio\n` +
        `!video <query> – download video\n` +
        `!broadcast <message> – send to all chats`;
      await client.sendMessage(`${OWNER_NUMBER}@c.us`, helpText);
    } catch (err) {
      console.error('Welcome message error:', err.message);
    }
  }
});

client.on('auth_failure', (msg) => {
  console.error('❌ Auth failed:', msg);
  io.emit('auth_failure', msg);
});

client.on('disconnected', (reason) => {
  console.warn('⚠️ Disconnected:', reason);
  io.emit('disconnected', reason);
});

// ---------- DASHBOARD DATA ----------
async function sendDashboardData() {
  try {
    const chats = await client.getChats();
    const chatList = chats.map(chat => ({
      id: chat.id._serialized,
      name: chat.name || chat.id.user,
      isGroup: chat.isGroup
    }));
    io.emit('dashboard_data', { 
      connectedNumber: client.info.wid.user, 
      chats: chatList 
    });
  } catch (error) { 
    console.error('Error getting chats:', error.message); 
  }
}

// ---------- SOCKET EVENTS ----------
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

// ---------- AI CHAT HISTORY ----------
const conversationHistory = new Map();

async function generateAIReply(chatId, userText) {
  let history = conversationHistory.get(chatId) || [];
  history = history.slice(-9);
  history.push({ role: 'user', content: userText });
  conversationHistory.set(chatId, history);

  try {
    const completion = await openai.chat.completions.create({
      model: 'llama3-8b-8192',
      messages: [{ 
        role: 'system', 
        content: MODE_PROMPTS[currentMode] || MODE_PROMPTS.normal 
      }, ...history],
      max_tokens: 150,
      temperature: 0.7,
    });
    const reply = completion.choices[0].message.content.trim();
    history.push({ role: 'assistant', content: reply });
    conversationHistory.set(chatId, history);
    return reply;
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

  // Handle owner commands
  if (isOwner) {
    const text = message.body.trim();
    if (text.startsWith('!')) {
      const command = text.slice(1).toLowerCase();
      try {
        if (command.startsWith('help')) {
          await message.reply(
            '🤖 *Commands:*\n\n' +
            '!help – this menu\n' +
            '!setmode <flirty|angry|professional|normal>\n' +
            '!send <phone> <message> – send to a contact\n' +
            '!news – top world news\n' +
            '!music <query> – download audio\n' +
            '!video <query> – download video\n' +
            '!broadcast <message> – send to all chats'
          );
        }
        else if (command.startsWith('setmode')) {
          const mode = command.split(' ')[1];
          if (MODE_PROMPTS[mode]) {
            currentMode = mode;
            await message.reply(`✅ Mode changed to *${mode}*.`);
          } else {
            await message.reply('Valid modes: angry, flirty, professional, normal');
          }
        }
        else if (command.startsWith('send')) {
          const parts = command.split(' ');
          if (parts.length < 3) return message.reply('Usage: !send <phone> <message>');
          const phone = parts[1];
          const msg = parts.slice(2).join(' ');
          await client.sendMessage(`${phone}@c.us`, msg);
          await message.reply(`✅ Message sent to ${phone}`);
        }
        else if (command.startsWith('news')) {
          await message.reply('📰 News feature coming soon!');
        }
        else if (command.startsWith('broadcast')) {
          const msg = command.slice('broadcast'.length).trim();
          if (!msg) return message.reply('Usage: !broadcast <message>');
          const chats = await client.getChats();
          let count = 0;
          for (const chat of chats) {
            await chat.sendMessage(msg);
            count++;
          }
          await message.reply(`✅ Broadcast sent to ${count} chats.`);
        }
        else {
          await message.reply('❓ Unknown command. Type `!help` for list.');
        }
      } catch (err) {
        console.error('Command error:', err);
        await message.reply(`❌ Error: ${err.message}`);
      }
      return;
    }

    // Owner chats with AI
    const reply = await generateAIReply(chatId, text);
    await message.reply(reply);
    return;
  }

  // Non-owner messages: auto-reply + forward to owner
  if (OWNER_NUMBER) {
    try {
      const ownerChat = await client.getChatById(`${OWNER_NUMBER}@c.us`);
      await ownerChat.sendMessage(
        `📩 *Message from* ${message.from}\n` +
        `*Message:* ${message.body}`
      );
    } catch (err) { 
      console.error('Forward to owner failed:', err.message); 
    }
  }

  const reply = await generateAIReply(chatId, message.body);
  await message.reply(reply);
});

// ---------- START BOT ----------
console.log('🚀 Initializing WhatsApp Client...');
client.initialize().catch(err => {
  console.error("❌ CRITICAL: Failed to initialize WhatsApp Client", err);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
