const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { nanoid } = require('nanoid'); // for unique server-side IDs

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  path: '/socket.io',
});

// File paths
const LIVE_CHAT_FILE = process.env.RENDER
  ? path.join("/tmp", "live_messages.json")
  : path.join(__dirname, "live_messages.json");

const BAN_LIST_FILE = process.env.RENDER
  ? path.join("/tmp", "banned_ips.json")
  : path.join(__dirname, "banned_ips.json");

// Load live messages
let liveChatMessages = [];
try {
  if (fs.existsSync(LIVE_CHAT_FILE)) {
    liveChatMessages = JSON.parse(fs.readFileSync(LIVE_CHAT_FILE, "utf8"));
  } else fs.writeFileSync(LIVE_CHAT_FILE, "[]");
} catch (err) { console.error("Error loading messages:", err); }

// Load banned IPs
let ipBans = {};
try {
  if (fs.existsSync(BAN_LIST_FILE)) {
    ipBans = JSON.parse(fs.readFileSync(BAN_LIST_FILE, "utf8"));
  } else fs.writeFileSync(BAN_LIST_FILE, "{}");
} catch (err) { console.error("Error loading ban list:", err); }

function saveMessages() { try { fs.writeFileSync(LIVE_CHAT_FILE, JSON.stringify(liveChatMessages, null, 2)); } catch (err) { console.error(err); } }
function saveBanList() { try { fs.writeFileSync(BAN_LIST_FILE, JSON.stringify(ipBans, null, 2)); } catch (err) { console.error(err); } }

// Online users
const onlineUsers = {}; // { userID: { name, sockets: Set() } }

// Anti-abuse
const MAX_CONNECTIONS_PER_IP = 2;
const ipConnections = {};
const RATE_LIMIT_WINDOW_MS = 5000;
const RATE_LIMIT_MAX_MESSAGES = 5;
const rateLimitState = {};
const MAX_MESSAGE_LENGTH = 100;
const MAX_IMAGE_SIZE_BASE64 = 150000;
const ipSpamCount = {};
let lastMessageText = {};

function getClientIP(socket) {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return socket.handshake.address;
}

function sanitizeText(s) { return String(s || '').replace(/[<>]/g, '').trim(); }
function isBase64Image(text) { return typeof text === 'string' && text.startsWith('data:image/'); }

app.get('/live-messages', (_, res) => res.json(liveChatMessages));

const trollMessages = [
  "🚨 Got IP BANNED DUMMASS 😎",
  "🛑 SORRY FOR NOT GIVING A FUCK ON YOUR RETIRED IP. 🏖️",
  "🔥 Boom! Retarded detected. You've unlocked the permanent ban achievement! 🏆",
  "🎉 Congratulations Dumbass You've spammed your way into a permanent ban. ! 👋",
];

// Socket connection
io.on('connection', (socket) => {
  const { username } = socket.handshake.auth;
  if (!username) return socket.disconnect();

  const ip = getClientIP(socket);
  if (ipBans[ip]) { socket.emit('warning', { message: 'Your IP is permanently banned.' }); return socket.disconnect(true); }

  ipConnections[ip] = (ipConnections[ip] || 0) + 1;
  if (ipConnections[ip] > MAX_CONNECTIONS_PER_IP) {
    socket.emit('error', { message: 'Too many connections from your IP' });
    socket.disconnect(true);
    ipConnections[ip]--;
    return;
  }

  // Assign server-side userID
  const userID = nanoid();

  if (!onlineUsers[userID]) onlineUsers[userID] = { name: username, sockets: new Set() };
  onlineUsers[userID].sockets.add(socket.id);

  io.emit('online_users', Object.values(onlineUsers).map(u => u.name));

  rateLimitState[socket.id] = { count: 0, windowStart: Date.now() };
  lastMessageText[socket.id] = '';

  // PRIVATE MESSAGE
  socket.on("private_message", ({ toName, text, time }) => {
    text = sanitizeText(text);
    if (!toName || !text || text.length > MAX_MESSAGE_LENGTH) return;
    if (isBase64Image(text) && text.length > MAX_IMAGE_SIZE_BASE64) return;

    if (text === lastMessageText[socket.id]) {
      ipSpamCount[ip] = (ipSpamCount[ip] || 0) + 1;
      if (ipSpamCount[ip] >= 3) {
        ipBans[ip] = 'permanent';
        saveBanList();
        const trollMessage = trollMessages[Math.floor(Math.random() * trollMessages.length)];
        socket.emit('warning', { message: trollMessage });
        return socket.disconnect(true);
      }
    } else ipSpamCount[ip] = 0;
    lastMessageText[socket.id] = text;

    // Find recipient by name
    const recipient = Object.entries(onlineUsers).find(([id, u]) => u.name === toName);
    if (recipient) {
      for (let sid of recipient[1].sockets) {
        io.to(sid).emit("receive_private", { from: username, text, time });
      }
    }
  });

  // LIVE CHAT MESSAGE
  socket.on("live_message", (msg) => {
    const now = Date.now();
    let rl = rateLimitState[socket.id];
    if (now - rl.windowStart > RATE_LIMIT_WINDOW_MS) { rl.windowStart = now; rl.count = 0; }
    rl.count++;
    rateLimitState[socket.id] = rl;
    if (rl.count > RATE_LIMIT_MAX_MESSAGES) {
      if (rl.count === RATE_LIMIT_MAX_MESSAGES + 1) socket.emit('warning', { message: 'You are sending messages too fast. Slow down.' });
      return;
    }

    msg.text = sanitizeText(msg.text);
    if (!msg.text || msg.text.length > MAX_MESSAGE_LENGTH) return;
    if (isBase64Image(msg.text) && msg.text.length > MAX_IMAGE_SIZE_BASE64) return;

    if (msg.text === lastMessageText[socket.id]) {
      ipSpamCount[ip] = (ipSpamCount[ip] || 0) + 1;
      if (ipSpamCount[ip] >= 3) {
        ipBans[ip] = 'permanent';
        saveBanList();
        const trollMessage = trollMessages[Math.floor(Math.random() * trollMessages.length)];
        socket.emit('warning', { message: trollMessage });
        return socket.disconnect(true);
      }
    } else ipSpamCount[ip] = 0;
    lastMessageText[socket.id] = msg.text;

    liveChatMessages.push({ userID: username, text: msg.text, time: msg.time });
    if (liveChatMessages.length > 200) liveChatMessages.shift();
    saveMessages();
    io.emit("live_message", { userID: username, text: msg.text, time: msg.time });
  });

  // Disconnect
  socket.on("disconnect", () => {
    if (onlineUsers[userID]) {
      onlineUsers[userID].sockets.delete(socket.id);
      if (!onlineUsers[userID].sockets.size) delete onlineUsers[userID];
    }
    io.emit('online_users', Object.values(onlineUsers).map(u => u.name));

    if (ip && ipConnections[ip]) { ipConnections[ip]--; if (ipConnections[ip] <= 0) delete ipConnections[ip]; }
    delete rateLimitState[socket.id];
    delete lastMessageText[socket.id];
  });
});

app.get("/", (_, res) => res.send("Server OK"));

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log("Server running on " + PORT));
