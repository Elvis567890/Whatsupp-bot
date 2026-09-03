const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const { OpenAI } = require('openai');
const Parser = require('rss-parser');
const fs = require('fs');
const path = require('path');
const ytDlp = require('yt-dlp-exec');
const ffmpegPath = require('ffmpeg-static');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

app.use(express.static('public'));

// ---------- Groq AI Setup (FREE) ----------
const openai = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: 'https://api.groq.com/openai/v1',
});

// ---------- RSS Parser ----------
const rssParser = new Parser();

// ---------- WhatsApp Client (with Puppeteer fix) ----------
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

client.on('qr', async (qr) => {
    console.log('QR Code received');
    const qrImage = await qrcode.toDataURL(qr);
    io.emit('qr', qrImage);
});

client.on('ready', () => {
    console.log('WhatsApp client is ready!');
    io.emit('ready');
});

// ---------- Conversation History ----------
const conversationHistory = new Map();

// ---------- News Feeds ----------
const NEWS_FEEDS = {
    world: 'http://feeds.bbci.co.uk/news/world/rss.xml',
    tech: 'http://feeds.bbci.co.uk/news/technology/rss.xml',
    business: 'http://feeds.bbci.co.uk/news/business/rss.xml',
    sports: 'http://feeds.bbci.co.uk/sport/rss.xml',
};

// ---------- Main Message Handler ----------
client.on('message', async (message) => {
    const chatId = message.from;
    const userText = message.body.trim();

    if (!userText) return;

    // Commands (prefix: !)
    if (userText.startsWith('!')) {
        const command = userText.slice(1).toLowerCase();

        if (command.startsWith('news')) {
            await handleNewsCommand(message, command);
        } else if (command.startsWith('music') || command.startsWith('video')) {
            await handleDownloadCommand(message, command);
        } else {
            await message.reply('❓ Unknown command. Try:\n`!news`\n`!news tech`\n`!music <YouTube link or search>`\n`!video <YouTube link or search>`');
        }
        return;
    }

    // AI Conversation (Groq)
    let history = conversationHistory.get(chatId) || [];
    history = history.slice(-9); // keep last 10 messages
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
        console.error('Groq API error:', error.message);
        await message.reply('😅 Sorry, I had a small glitch. Could you repeat that?');
    }
});

// ---------- News Command ----------
async function handleNewsCommand(message, command) {
    const parts = command.split(' ');
    let category = 'world';
    if (parts.length > 1 && parts[1] in NEWS_FEEDS) {
        category = parts[1];
    }

    const feedUrl = NEWS_FEEDS[category];
    try {
        const feed = await rssParser.parseURL(feedUrl);
        const items = feed.items.slice(0, 5);
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

// ---------- Download Command (Music/Video) ----------
async function handleDownloadCommand(message, command) {
    const parts = command.split(' ');
    const type = parts[0];
    const query = parts.slice(1).join(' ').trim();

    if (!query) {
        await message.reply(`Please provide a YouTube link or search term.\nExample: !${type} never gonna give you up`);
        return;
    }

    await message.reply(`⏳ Downloading ${type}... Please wait.`);

    const tmpDir = '/tmp';
    const ext = type === 'music' ? 'mp3' : 'mp4';
    const outputFile = path.join(tmpDir, `download_${Date.now()}.${ext}`);

    try {
        if (type === 'music') {
            await ytDlp(query, {
                output: outputFile,
                extractAudio: true,
                audioFormat: 'mp3',
                audioQuality: 192,
                noPlaylist: true,
                ffmpegLocation: ffmpegPath,
            });
        } else {
            await ytDlp(query, {
                output: outputFile,
                format: 'best[height<=720]',
                mergeOutputFormat: 'mp4',
                noPlaylist: true,
                ffmpegLocation: ffmpegPath,
            });
        }

        const media = MessageMedia.fromFilePath(outputFile);
        await message.reply(media);
        fs.unlinkSync(outputFile);
    } catch (error) {
        console.error('Download error:', error.message);
        await message.reply('❌ Download failed. Make sure the link is correct or the video is not too long.');
    }
}

// ---------- Initialize ----------
client.initialize();

io.on('connection', (socket) => {
    console.log('Browser connected');
    if (client.info && client.info.wid) {
        socket.emit('ready');
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
