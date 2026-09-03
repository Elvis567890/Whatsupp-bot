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

// Initialize OpenAI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
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

// Simple in-memory store for conversation history (keyed by chat ID)
const conversationHistory = new Map();

client.on('message', async (message) => {
    const chatId = message.from;
    const userText = message.body;

    // Skip non-text messages or commands
    if (!userText || userText.startsWith('!')) return;

    // Get or initialize history for this chat
    let history = conversationHistory.get(chatId) || [];
    // Keep only last 10 messages to avoid huge prompts
    history = history.slice(-9);

    // Add user message to history
    history.push({ role: 'user', content: userText });
    conversationHistory.set(chatId, history);

    try {
        // Ask OpenAI for a reply
        const completion = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [
                { role: 'system', content: 'You are a friendly and helpful WhatsApp bot. You can chat naturally, tell jokes, and answer questions.' },
                ...history,
            ],
            max_tokens: 150,
            temperature: 0.7,
        });

        const reply = completion.choices[0].message.content.trim();
        await message.reply(reply);

        // Add assistant reply to history
        history.push({ role: 'assistant', content: reply });
        conversationHistory.set(chatId, history);
    } catch (error) {
        console.error('OpenAI error:', error.message);
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
