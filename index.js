const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const { OpenAI } = require('openai');
const Parser = require('rss-parser');
const fs = require('fs');
const path = require('path');
const ytdl = require('ytdl-core');
const ytSearch = require('yt-search');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
require('dotenv').config();

// Set ffmpeg path
ffmpeg.setFfmpegPath(ffmpegStatic);

// System Chromium path (installed via pre-deploy)
const CHROME_PATH = '/usr/bin/chromium-browser';
console.log(`✅ Using Chromium at: ${CHROME_PATH}`);

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

app.use(express.static('public'));

const openai = new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: 'https://api.groq.com/openai/v1',
});

const rssParser = new Parser();

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        executablePath: CHROME_PATH,
    }
});

client.on('qr', async (qr) => {
    const qrImage = await qrcode.toDataURL(qr);
    io.emit('qr', qrImage);
});

client.on('ready', () => {
    console.log('WhatsApp client is ready!');
    io.emit('ready');
});

const conversationHistory = new Map();

const NEWS_FEEDS = {
    world: 'http://feeds.bbci.co.uk/news/world/rss.xml',
    tech: 'http://feeds.bbci.co.uk/news/technology/rss.xml',
    business: 'http://feeds.bbci.co.uk/news/business/rss.xml',
    sports: 'http://feeds.bbci.co.uk/sport/rss.xml',
};

client.on('message', async (message) => {
    const chatId = message.from;
    const userText = message.body.trim();

    if (!userText) return;

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
        console.error('Groq API error:', error.message);
        await message.reply('😅 Sorry, I had a small glitch. Could you repeat that?');
    }
});

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

async function handleDownloadCommand(message, command) {
    const parts = command.split(' ');
    const type = parts[0];
    const query = parts.slice(1).join(' ').trim();

    if (!query) {
        await message.reply(`Please provide a YouTube link or search term.\nExample: !${type} never gonna give you up`);
        return;
    }

    await message.reply(`⏳ Searching for "${query}"...`);

    let videoUrl;
    if (ytdl.validateURL(query)) {
        videoUrl = query;
    } else {
        const searchResults = await ytSearch(query);
        if (!searchResults.videos.length) {
            await message.reply('❌ No videos found for that search term.');
            return;
        }
        videoUrl = searchResults.videos[0].url;
        await message.reply(`🎬 Found: *${searchResults.videos[0].title}*\nDownloading ${type}...`);
    }

    const tmpDir = '/tmp';
    const ext = type === 'music' ? 'mp3' : 'mp4';
    const outputFile = path.join(tmpDir, `download_${Date.now()}.${ext}`);

    try {
        if (type === 'music') {
            const audioStream = ytdl(videoUrl, { filter: 'audioonly', quality: 'highestaudio' });
            await new Promise((resolve, reject) => {
                ffmpeg(audioStream)
                    .audioBitrate(192)
                    .audioCodec('libmp3lame')
                    .format('mp3')
                    .on('end', resolve)
                    .on('error', reject)
                    .save(outputFile);
            });
        } else {
            const videoStream = ytdl(videoUrl, {
                filter: format => format.container === 'mp4' && format.hasAudio && format.hasVideo,
                quality: 'highest'
            });
            const writeStream = fs.createWriteStream(outputFile);
            await new Promise((resolve, reject) => {
                videoStream.pipe(writeStream)
                    .on('finish', resolve)
                    .on('error', reject);
            });
        }

        const media = MessageMedia.fromFilePath(outputFile);
        await message.reply(media);
        fs.unlinkSync(outputFile);
    } catch (error) {
        console.error('Download error:', error.message);
        await message.reply('❌ Download failed. Make sure the link is correct or the video is not too long.');
        if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
    }
}

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
