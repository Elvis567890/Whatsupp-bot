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

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: '/tmp/.wwebjs_auth' }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

client.on('qr', async (qr) => {
  const qrImage = await qrcode.toDataURL(qr);
  latestQr = qrImage;
  io.emit('qr', qrImage);
});

client.on('ready', () => {
  console.log('WhatsApp client is ready!');
  io.emit('ready');
});

client.on('message', async (message) => {
  if (message.body === '!ping') {
    await message.reply('pong');
  }
});

io.on('connection', (socket) => {
  if (client.info && client.info.wid) {
    socket.emit('ready');
  } else if (latestQr) {
    socket.emit('qr', latestQr);
  }
});

client.initialize();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
