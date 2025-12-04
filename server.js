const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { nanoid } = require('nanoid');
const crypto = require('crypto');

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

const FINGERPRINT_BAN_FILE = process.env.RENDER
  ? path.join("/tmp", "banned_fingerprints.json")
  : path.join(__dirname, "banned_fingerprints.json");

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

// Load banned fingerprints
let fingerprintBans = {};
try {
  if (fs.existsSync(FINGERPRINT_BAN_FILE)) {
    fingerprintBans = JSON.parse(fs.readFileSync(FINGERPRINT_BAN_FILE, "utf8"));
  } else fs.writeFileSync(FINGERPRINT_BAN_FILE, "{}");
} catch (err) { console.error("Error loading fingerprint bans:", err); }

function saveMessages() { try { fs.writeFileSync(LIVE_CHAT_FILE, JSON.stringify(liveChatMessages, null, 2)); } catch (err) { console.error(err); } }
function saveBanList() { try { fs.writeFileSync(BAN_LIST_FILE, JSON.stringify(ipBans, null, 2)); } catch (err) { console.error(err); } }
function saveFingerprintBans() { try { fs.writeFileSync(FINGERPRINT_BAN_FILE, JSON.stringify(fingerprintBans, null, 2)); } catch (err) { console.error(err); } }

// Online users
const onlineUsers = {}; // { socketID: { userID, username, ip, fingerprint } }
const ipToUserIDs = {};

// Enhanced anti-abuse
const MAX_CONNECTIONS_PER_IP = 2;
const ipConnections = {};
const RATE_LIMIT_WINDOW_MS = 5000;
const RATE_LIMIT_MAX_MESSAGES = 5;
const GLOBAL_RATE_LIMIT_WINDOW_MS = 2000; // Stricter: 2 seconds between messages globally
const rateLimitState = {};
const globalMessageTimes = {}; // Track last message time per socket
const MAX_MESSAGE_LENGTH = 100;
const MAX_IMAGE_SIZE_BASE64 = 150000;
const ipSpamCount = {};
const fingerprintSpamCount = {};
let lastMessageText = {};

// Behavioral tracking
const suspiciousActivity = {}; // Track suspicious patterns
const connectionAttempts = {}; // Track rapid reconnection attempts

function getClientIP(socket) {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return socket.handshake.address;
}

function sanitizeText(s) { return String(s || '').replace(/[<>]/g, '').trim(); }
function isBase64Image(text) { return typeof text === 'string' && text.startsWith('data:image/'); }

function generateRandomName() {
  const adjectives = ["Swift","Silent","Brave","Lucky","Clever","Mighty","Happy","Cosmic","Frosty","Shadow"];
  const animals = ["Tiger","Falcon","Wolf","Panda","Eagle","Lion","Otter","Hawk","Bear","Dragon"];
  return adjectives[Math.floor(Math.random() * adjectives.length)] +
         animals[Math.floor(Math.random() * animals.length)] + "-" +
         Math.floor(Math.random() * 9999);
}

// Generate server-side fingerprint from browser data
function generateFingerprint(data) {
  const components = [
    data.userAgent || '',
    data.language || '',
    data.platform || '',
    data.screenResolution || '',
    data.timezone || '',
    data.canvas || ''
  ].join('|');
  return crypto.createHash('sha256').update(components).digest('hex');
}

// Check if behavior is suspicious
function isSuspiciousBehavior(ip, fingerprint) {
  const now = Date.now();
  
  // Track connection attempts
  if (!connectionAttempts[ip]) connectionAttempts[ip] = [];
  connectionAttempts[ip].push(now);
  
  // Clean old attempts (older than 1 minute)
  connectionAttempts[ip] = connectionAttempts[ip].filter(t => now - t < 60000);
  
  // More than 5 connection attempts in 1 minute = suspicious
  if (connectionAttempts[ip].length > 5) {
    return true;
  }
  
  return false;
}

app.get('/live-messages', (_, res) => res.json(liveChatMessages));

const trollMessages = [
  "🚨 Got IP BANNED DUMMASS 😎",
  "🛑 SORRY FOR NOT GIVING A FUCK ON YOUR RETIRED IP. 🏖️",
  "🔥 Boom! Retarded detected. You've unlocked the permanent ban achievement! 🏆",
  "🎉 Congratulations Dumbass You've spammed your way into a permanent ban! 👋",
  "🤖 Nice try with the VPN, but we remember you. Banned again! 💀",
  "⚡ Your device fingerprint is BANNED. VPN won't save you now! 🔒",
];

// Socket connection
io.on('connection', (socket) => {
  const { fingerprint: clientFingerprint } = socket.handshake.auth;
  const ip = getClientIP(socket);
  
  // Generate server-side fingerprint
  const fingerprint = clientFingerprint ? generateFingerprint(clientFingerprint) : null;
  
  // Check fingerprint ban (bypasses VPN)
  if (fingerprint && fingerprintBans[fingerprint]) {
    socket.emit('warning', { message: '🤖 Your device is permanently banned. VPN won\'t help! 🔒' });
    return socket.disconnect(true);
  }
  
  // Check IP ban
  if (ipBans[ip]) { 
    socket.emit('warning', { message: 'Your IP is permanently banned.' }); 
    return socket.disconnect(true); 
  }
  
  // Check suspicious behavior
  if (isSuspiciousBehavior(ip, fingerprint)) {
    socket.emit('warning', { message: '⚠️ Masyado kang mabilis boi ligo muna' });
    socket.disconnect(true);
    return;
  }

  // Check connection limit per IP
  ipConnections[ip] = (ipConnections[ip] || 0) + 1;
  if (ipConnections[ip] > MAX_CONNECTIONS_PER_IP) {
    socket.emit('error', { message: 'Too many connections from your IP' });
    socket.disconnect(true);
    ipConnections[ip]--;
    return;
  }

  // SERVER ASSIGNS USERNAME
  const userID = nanoid(10);
  const username = generateRandomName();
  
  // Store user info by socket ID
  onlineUsers[socket.id] = { userID, username, ip, fingerprint };
  
  // Track userIDs per IP
  if (!ipToUserIDs[ip]) ipToUserIDs[ip] = [];
  ipToUserIDs[ip].push(userID);

  // Send the assigned username back to the client
  socket.emit('username_assigned', { username, userID });

  // Broadcast updated online users list (excluding the sender)
  const getUsersListExcept = (excludeSocketId) => {
    return Object.entries(onlineUsers)
      .filter(([sid]) => sid !== excludeSocketId)
      .map(([_, u]) => u.username);
  };

  // Send list to all users
  Object.keys(onlineUsers).forEach(sid => {
    io.to(sid).emit('online_users', getUsersListExcept(sid));
  });

  rateLimitState[socket.id] = { count: 0, windowStart: Date.now() };
  globalMessageTimes[socket.id] = 0;
  lastMessageText[socket.id] = '';

  // Ban helper function
  function banUser(reason) {
    const user = onlineUsers[socket.id];
    if (!user) return;
    
    // Ban IP
    ipBans[ip] = 'permanent';
    
    // Ban fingerprint if available (this bypasses VPN)
    if (user.fingerprint) {
      fingerprintBans[user.fingerprint] = {
        bannedAt: new Date().toISOString(),
        reason: reason
      };
      saveFingerprintBans();
    }
    
    saveBanList();
    const trollMessage = trollMessages[Math.floor(Math.random() * trollMessages.length)];
    socket.emit('warning', { message: trollMessage });
    socket.disconnect(true);
  }

  // PRIVATE MESSAGE
  socket.on("private_message", ({ toName, text, time }) => {
    const sender = onlineUsers[socket.id];
    if (!sender) return;

    // Global rate limit check (stricter)
    const now = Date.now();
    if (now - globalMessageTimes[socket.id] < GLOBAL_RATE_LIMIT_WINDOW_MS) {
      socket.emit('warning', { message: '⚠️ Slow down! Wait 2 seconds between messages.' });
      return;
    }
    globalMessageTimes[socket.id] = now;

    text = sanitizeText(text);
    if (!toName || !text || text.length > MAX_MESSAGE_LENGTH) return;
    if (isBase64Image(text) && text.length > MAX_IMAGE_SIZE_BASE64) return;

    // Spam detection (both IP and fingerprint)
    if (text === lastMessageText[socket.id]) {
      ipSpamCount[ip] = (ipSpamCount[ip] || 0) + 1;
      if (sender.fingerprint) {
        fingerprintSpamCount[sender.fingerprint] = (fingerprintSpamCount[sender.fingerprint] || 0) + 1;
      }
      
      if (ipSpamCount[ip] >= 3 || (sender.fingerprint && fingerprintSpamCount[sender.fingerprint] >= 3)) {
        banUser('spam');
        return;
      }
    } else {
      ipSpamCount[ip] = 0;
      if (sender.fingerprint) fingerprintSpamCount[sender.fingerprint] = 0;
    }
    lastMessageText[socket.id] = text;

    const message = { from: sender.username, text, time };

    // Find recipient by username and send to them
    const recipientSocket = Object.entries(onlineUsers).find(([sid, u]) => u.username === toName);
    if (recipientSocket) {
      io.to(recipientSocket[0]).emit("receive_private", message);
      // Also send back to sender so they see their own message
      socket.emit("receive_private", message);
    }
  });

  // LIVE CHAT MESSAGE
  socket.on("live_message", (msg) => {
    const sender = onlineUsers[socket.id];
    if (!sender) return;

    // Global rate limit check (stricter)
    const nowGlobal = Date.now();
    if (nowGlobal - globalMessageTimes[socket.id] < GLOBAL_RATE_LIMIT_WINDOW_MS) {
      socket.emit('warning', { message: '⚠️ Slow down! Wait 2 seconds between messages.' });
      return;
    }
    globalMessageTimes[socket.id] = nowGlobal;

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

    // Spam detection (both IP and fingerprint)
    if (msg.text === lastMessageText[socket.id]) {
      ipSpamCount[ip] = (ipSpamCount[ip] || 0) + 1;
      if (sender.fingerprint) {
        fingerprintSpamCount[sender.fingerprint] = (fingerprintSpamCount[sender.fingerprint] || 0) + 1;
      }
      
      if (ipSpamCount[ip] >= 3 || (sender.fingerprint && fingerprintSpamCount[sender.fingerprint] >= 3)) {
        banUser('spam');
        return;
      }
    } else {
      ipSpamCount[ip] = 0;
      if (sender.fingerprint) fingerprintSpamCount[sender.fingerprint] = 0;
    }
    lastMessageText[socket.id] = msg.text;

    // Use server-side username, not client-provided
    const message = { 
      userID: sender.username, 
      text: msg.text, 
      time: msg.time 
    };
    
    liveChatMessages.push(message);
    if (liveChatMessages.length > 200) liveChatMessages.shift();
    saveMessages();
    io.emit("live_message", message);
  });

  // Disconnect
  socket.on("disconnect", () => {
    const user = onlineUsers[socket.id];
    if (user) {
      // Remove from IP tracking
      if (ipToUserIDs[ip]) {
        ipToUserIDs[ip] = ipToUserIDs[ip].filter(id => id !== user.userID);
        if (ipToUserIDs[ip].length === 0) delete ipToUserIDs[ip];
      }
      
      delete onlineUsers[socket.id];
    }
    
    // Send updated list to each remaining user (excluding themselves)
    const getUsersListExcept = (excludeSocketId) => {
      return Object.entries(onlineUsers)
        .filter(([sid]) => sid !== excludeSocketId)
        .map(([_, u]) => u.username);
    };
    
    Object.keys(onlineUsers).forEach(sid => {
      io.to(sid).emit('online_users', getUsersListExcept(sid));
    });

    if (ip && ipConnections[ip]) { 
      ipConnections[ip]--; 
      if (ipConnections[ip] <= 0) delete ipConnections[ip]; 
    }
    delete rateLimitState[socket.id];
    delete globalMessageTimes[socket.id];
    delete lastMessageText[socket.id];
  });
});

app.get("/", (_, res) => res.send("Server OK"));

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log("Server running on " + PORT));
