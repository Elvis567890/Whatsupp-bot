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
const { MongoClient } = require('mongodb');
require('dotenv').config();

// Set ffmpeg path
ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

app.use(express.static('public'));

// ---------- MongoDB Setup ----------
const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) {
    console.error('MONGODB_URI is not set. Please add it to Render environment variables.');
    process.exit(1);
}
const mongoClient = new MongoClient(mongoUri);
let sessionsCollection;
let settingsCollection;

async function connectMongo() {
    await mongoClient.connect();
    const db = mongoClient.db('whatsapp_bot');
    sessionsCollection = db.collection('sessions');
    settingsCollection = db.collection('settings');
    console.log('Connected to MongoDB');
    // Load current AI mode from DB (if exists)
    const setting = await settingsCollection.findOne({ _id: 'ai_mode' });
    if (setting && setting.value in MODE_PROMPTS) {
        currentMode = setting.value;
    }
}

// Custom auth strategy: store session in MongoDB
class MongoAuth {
    async getSession() {
        if (!sessionsCollection) return null;
        const session = await sessionsCollection.findOne({ _id: 'whatsapp_session' });
        return session ? session.data : null;
    }
    async saveSession(session) {
        if (!sessionsCollection) return;
        await sessionsCollection.updateOne(
            { _id: 'whatsapp_session' },
            { $set: { data: session } },
            { upsert: true }
        );
    }
    async removeSession() {
        if (!sessionsCollection) return;
        await sessionsCollection.deleteOne({ _id: 'whatsapp_session' });
    }
}

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

// WhatsApp client with MongoDB session
const client = new Client({
    authStrategy: new MongoAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
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

    // Send welcome message to the bot's own number (admin)
    const adminNumber = client.info.wid._serialized; // e.g., '123456789@c.us'
    try {
        const helpText = `🤖 *Your WhatsApp Bot is now online!*\n\n` +
            `Here are the commands you can use:\n` +
            `!help – show this menu\n` +
            `!news – world news\n` +
            `!news tech – tech news (also business, sports)\n` +
            `!music <song name / YouTube link> – download audio\n` +
            `!video <video name / YouTube link> – download video\n` +
            `!setmode flirty – flirty personality\n` +
            `!setmode angry – angry personality\n` +
            `!setmode professional – formal tone\n` +
            `!setmode normal – default friendly\n\n` +
            `You can also use the dashboard to send messages to any chat.`;
        await client.sendMessage(adminNumber, helpText);
        console.log('Welcome message sent to admin');
    } catch (error) {
        console.error('Error sending welcome message:', error.message);
    }
});

// ---------- Dashboard Data (all chats) ----------
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

// Socket connection
io.on('connection', (socket) => {
    console.log('Browser connected');
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
            console.error('Send error:', error.message);
            socket.emit('send_result', { success: false, error: error.message });
        }
    });
});

// Conversation history (for AI)
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

    if (userText.startsWith('!')) {
        const command = userText.slice(1).toLowerCase();
        if (command.startsWith('help')) {
            await handleHelpCommand(message);
        } else if (command.startsWith('news')) {
            await handleNewsCommand(message, command);
        } else if (command.startsWith('music') || command.startsWith('video')) {
            await handleDownloadCommand(message, command);
        } else if (command.startsWith('setmode')) {
            await handleSetModeCommand(message, command);
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
            messages: [
                { role: 'system', content: systemPrompt },
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

// Help command
async function handleHelpCommand(message) {
    const helpText = `🤖 *Available Commands:*\n\n` +
        `!help – show this menu\n` +
        `!news – world news\n` +
        `!news tech – tech news (also business, sports)\n` +
        `!music <song name / YouTube link> – download audio\n` +
        `!video <video name / YouTube link> – download video\n` +
        `!setmode flirty – flirty personality\n` +
        `!setmode angry – angry personality\n` +
        `!setmode professional – formal tone\n` +
        `!setmode normal – default friendly`;
    await message.reply(helpText);
}

// Set mode command (with persistence)
async function handleSetModeCommand(message, command) {
    const parts = command.split(' ');
    const mode = parts[1]?.toLowerCase();
    if (!mode || !(mode in MODE_PROMPTS)) {
        await message.reply('Valid modes: angry, flirty, professional, normal\nExample: !setmode flirty');
        return;
    }
    currentMode = mode;
    // Save to MongoDB
    try {
        await settingsCollection.updateOne(
            { _id: 'ai_mode' },
            { $set: { value: mode } },
            { upsert: true }
        );
    } catch (error) {
        console.error('Error saving mode:', error.message);
    }
    await message.reply(`✅ Mode changed to *${mode}*. I will now reply with that personality.`);
}

// News command
async function handleNewsCommand(message, command) {
    const parts = command.split(' ');
    let category = 'world';
    if (parts.length > 1 && parts[1] in NEWS_FEEDS) category = parts[1];
    const feedUrl = NEWS_FEEDS[category];
    try {
        const feed = await rssParser.parseURL(feedUrl);
        const items = feed.items.slice(0, 5);
        if (items.length === 0) {
            await message.reply('No news found.');
            return;
        }
        let reply = `📰 *Top ${category} news:*\n\n`;
        items.forEach((item, i) => {
            reply += `${i + 1}. ${item.title}\n${item.link}\n\n`;
        });
        await message.reply(reply);
    } catch (error) {
        console.error('News error:', error.message);
        await message.reply('Sorry, could not fetch news.');
    }
}

// Download handler
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
            await message.reply('❌ No videos found.');
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
        await message.reply('❌ Download failed.');
        if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
    }
}

// Initialize
connectMongo().then(() => {
    client.initialize();
}).catch(err => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
