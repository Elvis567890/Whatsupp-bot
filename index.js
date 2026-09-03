const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

// Serve static files from the "public" folder
app.use(express.static('public'));

// Create WhatsApp client with local authentication (saves session so you don't need to scan QR every time)
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { headless: true }
});

// When QR code is generated, send it to the browser
client.on('qr', async (qr) => {
    console.log('QR Code received, sending to browser');
    const qrImage = await qrcode.toDataURL(qr);
    io.emit('qr', qrImage);
});

// When client is ready, notify browser
client.on('ready', () => {
    console.log('WhatsApp client is ready!');
    io.emit('ready');
});

// Simple auto-reply (will be enhanced later with AI)
client.on('message', async (message) => {
    const text = message.body.toLowerCase();
    if (text.includes('hi') || text.includes('hello')) {
        await message.reply('Hello! I am your bot. How can I help you?');
    } else if (text.includes('how are you')) {
        await message.reply('I am doing great, thank you for asking!');
    }
    // You can add more keyword responses here
});

// Initialize WhatsApp client
client.initialize();

// Socket.IO connection
io.on('connection', (socket) => {
    console.log('Browser connected');
    // If client already ready, inform the new browser
    if (client.info && client.info.wid) {
        socket.emit('ready');
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
