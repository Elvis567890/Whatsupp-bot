const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const { Client, RemoteAuth } = require('whatsapp-web.js');
const { createClient } = require('@supabase/supabase-js');
const qrcode = require('qrcode');
const { OpenAI } = require('openai');
const Parser = require('rss-parser');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIO(server);
app.use(express.static('public'));

// ---------- DATABASE ----------
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_settings (
      id TEXT PRIMARY KEY,
      value JSONB,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✅ Database ready');
}
initDb().catch(err => console.error('❌ DB init error:', err));

// ---------- SESSION STORE ----------
class CustomSupabaseStore {
  constructor(c) { this.s = c; this.t = 'whatsapp_sessions'; }
  async sessionExists({ session }) {
    const { data } = await this.s.from(this.t).select('session_id').eq('session_id', session).maybeSingle();
    return !!data;
  }
  async save({ session, data }) {
    const { error } = await this.s.from(this.t).upsert({
      session_id: session,
      data,
      updated_at: new Date().toISOString()
    });
    if (error) { console.error('❌ Save failed:', error.message); throw error; }
    console.log('💾 Session saved to Supabase');
  }
  async extract({ session }) {
    const { data } = await this.s.from(this.t).select('data').eq('session_id', session).maybeSingle();
    return data ? data.data : null;
  }
  async delete({ session }) {
    await this.s.from(this.t).delete().eq('session_id', session);
  }
}

// ---------- AI ----------
const OWNER_NUMBER = process.env.OWNER_NUMBER;
const openai = new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: 'https://api.groq.com/openai/v1' });
const rssParser = new Parser();
let currentMode = 'normal';

const MODE_PROMPTS = {
  normal: 'You are a friendly and helpful WhatsApp bot. You chat naturally, tell jokes, and answer questions.',
  hungry: 'You are a food-loving bot. You ALWAYS bring up food, snacks, or eating. Be playful and funny about it.',
  happy: 'You are a super cheerful and optimistic bot. You spread good vibes and always reply with joy.',
  sleepy: 'You are a sleepy, tired bot. You yawn, reply slowly, and often mention wanting to sleep.',
  pickupline: 'You are a flirty, romantic bot. You use clever, charming pickup lines in your replies.'
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
let isAuthenticating = false;
let isReady = false;

client.on('qr', async (qr) => {
  if (isAuthenticating || isReady) {
    console.log('⏭️  Ignoring new QR — already authenticating or ready');
    return;
  }
  console.log('\n📱 QR Code generated — scan within 20 seconds');
  const qrImage = await qrcode.toDataURL(qr);
  latestQr = qrImage;
  io.emit('qr', qrImage);
});

client.on('authenticated', () => {
  console.log('🔐 Authenticated! Waiting for full session load...');
  isAuthenticating = true;
  latestQr = null;
  io.emit('authenticated');
});

client.on('auth_failure', (msg) => {
  console.error('❌ Auth failed:', msg);
  isAuthenticating = false;
  io.emit('auth_failure', msg);
});

client.on('ready', async () => {
  console.log('✅ WhatsApp client is ready!');
  isAuthenticating = false;
  isReady = true;
  io.emit('ready');

  try {
    const res = await pool.query('SELECT value FROM bot_settings WHERE id=$1', ['ai_mode']);
    if (res.rows.length > 0 && res.rows[0].value?.mode in MODE_PROMPTS) {
      currentMode = res.rows[0].value.mode;
    }
  } catch (err) { console.error('Load mode error:', err.message); }

  if (OWNER_NUMBER) {
    try {
      await client.sendMessage(`${OWNER_NUMBER}@c.us`, '🤖 Bot is online! Mode: ' + currentMode);
    } catch (err) { console.error('Welcome message error:', err.message); }
  }
});

client.on('disconnected', (reason) => {
  console.warn('⚠️ Disconnected:', reason);
  isReady = false;
  isAuthenticating = false;
  io.emit('disconnected', reason);
});

// ---------- DASHBOARD DATA ----------
async function sendDashboardData() {
  try {
    const chats = await client.getChats();
    const chatList = chats.map(c => ({
      id: c.id._serialized,
      name: c.name || c.id.user,
      isGroup: c.isGroup
    }));
    io.emit('dashboard_data', {
      connectedNumber: client.info.wid.user,
      chats: chatList,
      currentMode
    });
  } catch (e) { console.error('Dashboard error:', e.message); }
}

// ---------- SOCKET EVENTS ----------
io.on('connection', (socket) => {
  if (isReady && client.info?.wid) {
    socket.emit('ready');
    sendDashboardData();
  } else if (isAuthenticating) {
    socket.emit('authenticated');
  } else if (latestQr) {
    socket.emit('qr', latestQr);
  }

  socket.on('set_mode', async (mode) => {
    if (MODE_PROMPTS[mode]) {
      currentMode = mode;
      await pool.query(
        'INSERT INTO bot_settings (id,value) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET value=$2',
        ['ai_mode', { mode }]
      );
      io.emit('mode_updated', mode);
      console.log('✅ Mode changed to:', mode);
    }
  });

  socket.on('send_to_chats', async ({ chatIds, message }) => {
    if (!chatIds || !message) return;
    try {
      for (const id of chatIds) await client.sendMessage(id, message);
      socket.emit('send_result', { success: true });
    } catch (e) {
      socket.emit('send_result', { success: false, error: e.message });
    }
  });
});

// ---------- AI REPLY ----------
async function generateAIReply(chatId, userText) {
  try {
    const chat = await client.getChatById(chatId);
    const msgs = await chat.fetchMessages({ limit: 10 });
    const history = msgs
      .map(m => ({ role: m.fromMe ? 'assistant' : 'user', content: m.body }))
      .filter(m => m.content && m.content.length > 0);
    history.push({ role: 'user', content: userText });

    const completion = await openai.chat.completions.create({
      model: 'llama3-8b-8192',
      messages: [{ role: 'system', content: MODE_PROMPTS[currentMode] }, ...history],
      max_tokens: 200,
      temperature: 0.8
    });
    return completion.choices[0].message.content.trim();
  } catch (e) {
    console.error('AI Error:', e.message);
    return '😅 Sorry, I had a glitch. Please try again.';
  }
}

// ---------- MESSAGE HANDLER ----------
client.on('message', async (message) => {
  if (message.fromMe) return;
  const chatId = message.from;
  const isOwner = OWNER_NUMBER && chatId === `${OWNER_NUMBER}@c.us`;

  if (isOwner) {
    const t = message.body.trim();
    if (t.startsWith('!')) {
      const cmd = t.slice(1).toLowerCase();
      try {
        if (cmd.startsWith('help')) {
          return message.reply(
            'Commands:\n' +
            '!help - show this\n' +
            '!setmode <mode> - change AI mode\n' +
            '!send <phone> <msg> - send to a number\n\n' +
            'Modes: normal, hungry, happy, sleepy, pickupline'
          );
        }
        if (cmd.startsWith('setmode')) {
          const m = cmd.split(' ')[1];
          if (MODE_PROMPTS[m]) {
            currentMode = m;
            await pool.query(
              'INSERT INTO bot_settings (id,value) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET value=$2',
              ['ai_mode', { mode: m }]
            );
            return message.reply(`✅ Mode changed to *${m}*`);
          }
          return message.reply('Invalid mode.');
        }
        if (cmd.startsWith('send')) {
          const p = cmd.split(' ');
          if (p.length < 3) return message.reply('Usage: !send <phone> <msg>');
          await client.sendMessage(`${p[1]}@c.us`, p.slice(2).join(' '));
          return message.reply('✅ Sent!');
        }
        return message.reply('Unknown command. Use !help');
      } catch (err) {
        return message.reply(`❌ Error: ${err.message}`);
      }
    }
    return message.reply(await generateAIReply(chatId, t));
  }

  // Non-owner: forward to owner + auto-reply
  if (OWNER_NUMBER) {
    try {
      const oc = await client.getChatById(`${OWNER_NUMBER}@c.us`);
      await oc.sendMessage(`📩 From ${message.from}: ${message.body}`);
    } catch (err) { console.error('Forward failed:', err.message); }
  }
  await message.reply(await generateAIReply(chatId, message.body));
});

// ---------- START ----------
console.log('🚀 Initializing WhatsApp Client...');
client.initialize().catch(err => console.error('❌ CRITICAL:', err));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
