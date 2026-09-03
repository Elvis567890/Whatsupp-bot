const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const { OpenAI } = require('openai');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

app.use(express.static('public'));

// Initialize Groq (OpenAI-compatible)
const openai = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,   // <-- Changed to GROQ_API_KEY
    baseURL: 'https://api.groq.com/openai/v1',  // <-- Groq endpoint
});

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { headless: true }
});

client.on('qr', async (qr) => {
    const qrImage = await qrcode.toDataURL(qr);
    io.emit('qr', qrImage);
});

client.on('ready', () => {
    console.log('WhatsApp client is ready!');
    io.emit('ready');
});

// In-memory conversation history
const conversationHistory = new Map();

client.on('message', async (message) => {
    const chatId = message.from;
    const userText = message.body;

    // Skip non-text messages or commands
    if (!userText || userText.startsWith('!')) return;

    let history = conversationHistory.get(chatId) || [];
    history = history.slice(-9); // keep last 10 messages

    history.push({ role: 'user', content: userText });
    conversationHistory.set(chatId, history);

    try {
        const completion = await openai.chat.completions.create({
            model: 'llama3-8b-8192',   // You can also use 'mixtral-8x7b-32768'
            messages: [
                { role: 'system', content: 'You are a friendly and helpful WhatsApp bot. You can chat naturally, tell jokes, and answer questions.' },
                ...history,
            ],
            max_tokens: 150,
            temperature: 0.7,
        });

        const reply = completion.choices[0].message.content.trim();
        await message.reply(reply);

        history.push({ role: 'assistant', content: reply });
        conversationHistory.set(chatId, history);
    } catch (error) {
        console.error('Groq error:', error.message);
        await message.reply('Sorry, I had a small glitch. Could you repeat that?');
    }
});

client.initialize();

io.on('connection', (socket) => {
    if (client.info && client.info.wid) {
        socket.emit('ready');
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
