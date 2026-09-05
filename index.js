const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

app.use(express.static('public'));

let latestQr = null;

// Create client with LocalAuth (session stored in /tmp)
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: '/tmp/.wwebjs_auth' }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

// QR code event
client.on('qr', async (qr) => {
    console.log('✅ QR code generated');
    const qrImage = await qrcode.toDataURL(qr);
    latestQr = qrImage;
    io.emit('qr', qrImage);
});

// Ready event
client.on('ready', () => {
    console.log('🎉 WhatsApp client is ready!');
    io.emit('ready');
});

// Auth failure
client.on('auth_failure', (msg) => {
    console.error('❌ Authentication failure:', msg);
});

// Disconnected
client.on('disconnected', (reason) => {
    console.log('🔄 Disconnected:', reason);
});

// Message handler
client.on('message', async (message) => {
    if (message.body === '!ping') {
        await message.reply('pong');
    }
});

// Socket connection
io.on('connection', (socket) => {
    console.log('🖥️ Browser connected');
    if (client.info && client.info.wid) {
        socket.emit('ready');
    } else if (latestQr) {
        socket.emit('qr', latestQr);
    }
});

// Initialize
client.initialize();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});
