const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const { OpenAI } = require('openai');
const Parser = require('rss-parser');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

app.use(express.static('public'));

// Initialize Groq (OpenAI-compatible)
const openai = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: 'https://api.groq.com/openai/v1',
});

// Initialize RSS parser
const rssParser = new Parser();

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

// News sources (you can add more)
const NEWS_FEEDS = {
    world: 'http://feeds.bbci.co.uk/news/world/rss.xml',
    tech: 'http://feeds.bbci.co.uk/news/technology/rss.xml',
    business: 'http://feeds.bbci.co.uk/news/business/rss.xml',
    sports: 'http://feeds.bbci.co.uk/sport/rss.xml',
};

client.on('message', async (message) => {
    const chatId = message.from;
    const userText = message.body.trim();

    // Ignore empty messages
    if (!userText) return;

    // Handle commands (starting with !)
    if (userText.startsWith('!')) {
        const command = userText.slice(1).toLowerCase();
        if (command.startsWith('news')) {
            await handleNewsCommand(message, command);
        } else {
            // Unknown command, maybe reply with help
            await message.reply('Unknown command. Try `!news` or `!news tech`.');
        }
        return; // stop here, don't send to AI
    }

    // AI conversation
    let history = conversationHistory.get(chatId) || [];
    history = history.slice(-9);
    history.push({ role: 'user', content: userText });
    conversationHistory.set(chatId, history);

    try {
        const completion = await openai.chat.completions.create({
            model: 'llama3-8b-8192',
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

// Function to handle news command
async function handleNewsCommand(message, command) {
    // command looks like "news" or "news tech" etc.
    const parts = command.split(' ');
    let category = 'world'; // default

    if (parts.length > 1 && parts[1] in NEWS_FEEDS) {
        category = parts[1];
    }

    const feedUrl = NEWS_FEEDS[category];
    if (!feedUrl) {
        await message.reply('Invalid category. Available: world, tech, business, sports');
        return;
    }

    try {
        const feed = await rssParser.parseURL(feedUrl);
        const items = feed.items.slice(0, 5); // top 5 headlines

        if (items.length === 0) {
            await message.reply('No news found at the moment.');
            return;
        }

        let reply = `📰 *Top ${category} news:*\n\n`;
        items.forEach((item, index) => {
            reply += `${index + 1}. ${item.title}\n${item.link}\n\n`;
        });

        await message.reply(reply);
    } catch (error) {
        console.error('News fetch error:', error.message);
        await message.reply('Sorry, could not fetch news. Please try again later.');
    }
}

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
