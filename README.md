# WhatsApp Multibot

A feature-rich WhatsApp bot with web dashboard, AI chat, media downloading, and more.

## Features (Planned)
- [x] Connect via QR code (WhatsApp Web)
- [x] Basic auto-replies
- [ ] AI conversation (OpenAI)
- [ ] Download music and videos from YouTube
- [ ] Dashboard to select groups and send messages
- [ ] Fetch and post news
- [ ] Play text games
- [ ] Scheduled messages when offline

## Setup

1. Install [Node.js](https://nodejs.org/) (version 18+ recommended).
2. Clone this repository and navigate to the project folder.
3. Run `npm install` to install dependencies.
4. Run `node index.js` to start the server.
5. Open `http://localhost:3000` in your browser.
6. Scan the QR code with WhatsApp (Linked Devices → Link a Device).
7. The dashboard will show "WhatsApp connected!" once ready.

## Usage

- Send a message to any chat with the bot's number. If the message contains "hi" or "hello", the bot replies with a greeting. If it contains "how are you", it replies accordingly. More advanced replies will be added soon.

## Project Structure

- `index.js` – main server and bot logic
- `public/` – dashboard files (HTML, CSS, JS)
- `.env` – (future) for API keys

## License

MIT
