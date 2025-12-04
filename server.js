const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

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
  } else {
    fs.writeFileSync(LIVE_CHAT_FILE, "[]");
  }
} catch (err) { console.error("Error loading messages:", err); }

// Load banned IPs
let ipBans = {};
try {
  if (fs.existsSync(BAN_LIST_FILE)) {
    ipBans = JSON.parse(fs.readFileSync(BAN_LIST_FILE, "utf8"));
  } else {
    fs.writeFileSync(BAN_LIST_FILE, "{}");
  }
} catch (err) { console.error("Error loading ban list:", err); }

function saveMessages() {
  try { fs.writeFileSync(LIVE_CHAT_FILE, JSON.stringify(liveChatMessages, null, 2)); }
  catch (err) { console.error("Error saving messages:", err); }
}

function saveBanList() {
  try { fs.writeFileSync(BAN_LIST_FILE, JSON.stringify(ipBans, null, 2)); }
  catch (err) { console.error("Error saving ban list:", err); }
}

// Online users
const onlineUsers = {}; // { userID: Set(socket.id) }

// Anti-abuse
const MAX_CONNECTIONS_PER_IP = 1;
const ipConnections = {}; // { ip: count }
const RATE_LIMIT_WINDOW_MS = 5000; // 5s
const RATE_LIMIT_MAX_MESSAGES = 5; // per socket
const rateLimitState = {}; // { socket.id: { count, windowStart } }
const MAX_MESSAGE_LENGTH = 300;
const MAX_IMAGE_SIZE_BASE64 = 150000;
const ipSpamCount = {}; // { ip: count }
let lastMessageText = {}; // { socket.id: lastText }

function getClientIP(socket) {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return socket.handshake.address;
}

function sanitizeText(s) {
  return String(s || '').replace(/[<>]/g, '').trim();
}

function isBase64Image(text) {
  return typeof text === 'string' && text.startsWith('data:image/');
}

// REST route for chat history
app.get('/live-messages', (_, res) => res.json(liveChatMessages));

// Troll messages
const trollMessages = [
  "🚨 Got IP BANNED DUMMASS 😎",
  "🛑 SORRY FOR NOT GIVING A FUCK ON YOUR RETIRED IP. 🏖️",
  "🔥 Boom! Retarded detected. You've unlocked the permanent ban achievement! 🏆",
  "🎉 Congratulations Dumbass You've spammed your way into a permanent ban. ! 👋",
];

// Socket connection
io.on('connection', (socket) => {
  const userID = socket.handshake.auth?.userID;
  if (!userID) return socket.disconnect();

  const ip = getClientIP(socket);

  // Permanent ban check
  if (ipBans[ip]) {
    socket.emit('warning', { message: 'Your IP is permanently banned.' });
    return socket.disconnect(true);
  }

  ipConnections[ip] = (ipConnections[ip] || 0) + 1;
  if (ipConnections[ip] > MAX_CONNECTIONS_PER_IP) {
    socket.emit('error', { message: 'Too many connections from your IP' });
    socket.disconnect(true);
    ipConnections[ip]--;
    return;
  }

  // Online users
  if (!onlineUsers[userID]) onlineUsers[userID] = new Set();
  onlineUsers[userID].add(socket.id);
  io.emit('online_users', Object.keys(onlineUsers));

  // Rate limit & spam
  rateLimitState[socket.id] = { count: 0, windowStart: Date.now() };
  lastMessageText[socket.id] = '';

  // PRIVATE MESSAGE
  socket.on("private_message", ({ to, from, text, time }) => {
    text = sanitizeText(text);
    if (!to || !text || text.length > MAX_MESSAGE_LENGTH) return;
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
    } else {
      ipSpamCount[ip] = 0;
    }
    lastMessageText[socket.id] = text;

    (onlineUsers[to] || []).forEach(sid =>
      io.to(sid).emit("receive_private", { from, text, time })
    );
  });

  // LIVE CHAT MESSAGE
  socket.on("live_message", (msg) => {
    const now = Date.now();
    let rl = rateLimitState[socket.id];
    if (now - rl.windowStart > RATE_LIMIT_WINDOW_MS) {
      rl.windowStart = now;
      rl.count = 0;
    }
    rl.count++;
    rateLimitState[socket.id] = rl;

    if (rl.count > RATE_LIMIT_MAX_MESSAGES) {
      if (rl.count === RATE_LIMIT_MAX_MESSAGES + 1) {
        socket.emit('warning', { message: 'You are sending messages too fast. Slow down.' });
      }
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
    } else {
      ipSpamCount[ip] = 0;
    }
    lastMessageText[socket.id] = msg.text;

    liveChatMessages.push(msg);
    if (liveChatMessages.length > 200) liveChatMessages.shift();
    saveMessages();
    io.emit("live_message", msg);
  });

  // Disconnect
  socket.on("disconnect", () => {
    if (onlineUsers[userID]) {
      onlineUsers[userID].delete(socket.id);
      if (!onlineUsers[userID].size) delete onlineUsers[userID];
    }
    io.emit('online_users', Object.keys(onlineUsers));

    if (ip && ipConnections[ip]) {
      ipConnections[ip]--;
      if (ipConnections[ip] <= 0) delete ipConnections[ip];
    }
    delete rateLimitState[socket.id];
    delete lastMessageText[socket.id];
  });
});

// Health check
app.get("/", (_, res) => res.send("Server OK"));

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log("Server running on " + PORT));

