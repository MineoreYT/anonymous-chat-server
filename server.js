const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { nanoid } = require('nanoid');

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

// Online users - NOW TRACKS BY SOCKET ID WITH SERVER-ASSIGNED USERNAMES
const onlineUsers = {}; // { socketID: { userID, username, ip } }
const ipToUserIDs = {}; // { ip: [userIDs] } - track all userIDs per IP

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

function generateRandomName() {
  const adjectives = ["Swift","Silent","Brave","Lucky","Clever","Mighty","Happy","Cosmic","Frosty","Shadow"];
  const animals = ["Tiger","Falcon","Wolf","Panda","Eagle","Lion","Otter","Hawk","Bear","Dragon"];
  return adjectives[Math.floor(Math.random() * adjectives.length)] +
         animals[Math.floor(Math.random() * animals.length)] + "-" +
         Math.floor(Math.random() * 9999);
}

app.get('/live-messages', (_, res) => res.json(liveChatMessages));

const trollMessages = [
  "🚨 Got IP BANNED DUMMASS 😎",
  "🛑 SORRY FOR NOT GIVING A FUCK ON YOUR RETIRED IP. 🏖️",
  "🔥 Boom! Retarded detected. You've unlocked the permanent ban achievement! 🏆",
  "🎉 Congratulations Dumbass You've spammed your way into a permanent ban. ! 👋",
];

// Socket connection
io.on('connection', (socket) => {
  const ip = getClientIP(socket);
  
  // Check if IP is banned
  if (ipBans[ip]) { 
    socket.emit('warning', { message: 'Your IP is permanently banned.' }); 
    return socket.disconnect(true); 
  }

  // Check connection limit per IP
  ipConnections[ip] = (ipConnections[ip] || 0) + 1;
  if (ipConnections[ip] > MAX_CONNECTIONS_PER_IP) {
    socket.emit('error', { message: 'Too many connections from your IP' });
    socket.disconnect(true);
    ipConnections[ip]--;
    return;
  }

  // SERVER ASSIGNS USERNAME - CLIENT CANNOT CONTROL THIS
  const userID = nanoid(10);
  const username = generateRandomName();
  
  // Store user info by socket ID
  onlineUsers[socket.id] = { userID, username, ip };
  
  // Track userIDs per IP
  if (!ipToUserIDs[ip]) ipToUserIDs[ip] = [];
  ipToUserIDs[ip].push(userID);

  // Send the assigned username back to the client
  socket.emit('username_assigned', { username, userID });

  // Broadcast updated online users list
  const usersList = Object.values(onlineUsers).map(u => u.username);
  io.emit('online_users', usersList);

  rateLimitState[socket.id] = { count: 0, windowStart: Date.now() };
  lastMessageText[socket.id] = '';

  // PRIVATE MESSAGE
  socket.on("private_message", ({ toName, text, time }) => {
    const sender = onlineUsers[socket.id];
    if (!sender) return;

    text = sanitizeText(text);
    if (!toName || !text || text.length > MAX_MESSAGE_LENGTH) return;
    if (isBase64Image(text) && text.length > MAX_IMAGE_SIZE_BASE64) return;

    // Spam detection
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

    // Spam detection
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

  // CALL SIGNALING
  socket.on("call-user", ({ to, offer, isVideo }) => {
    const sender = onlineUsers[socket.id];
    if (!sender) return;

    // Find recipient by username
    const recipientSocket = Object.entries(onlineUsers).find(([sid, u]) => u.username === to);
    if (recipientSocket) {
      io.to(recipientSocket[0]).emit("incoming-call", {
        from: sender.username,
        offer: offer,
        isVideo: isVideo
      });
    }
  });

  socket.on("answer-call", ({ to, answer }) => {
    const sender = onlineUsers[socket.id];
    if (!sender) return;

    // Find recipient by username
    const recipientSocket = Object.entries(onlineUsers).find(([sid, u]) => u.username === to);
    if (recipientSocket) {
      io.to(recipientSocket[0]).emit("call-answered", {
        answer: answer
      });
    }
  });

  socket.on("ice-candidate", ({ to, candidate }) => {
    // Find recipient by username
    const recipientSocket = Object.entries(onlineUsers).find(([sid, u]) => u.username === to);
    if (recipientSocket) {
      io.to(recipientSocket[0]).emit("ice-candidate", {
        candidate: candidate
      });
    }
  });

  socket.on("end-call", ({ to }) => {
    // Find recipient by username
    const recipientSocket = Object.entries(onlineUsers).find(([sid, u]) => u.username === to);
    if (recipientSocket) {
      io.to(recipientSocket[0]).emit("call-ended");
    }
  });

  socket.on("reject-call", ({ to }) => {
    // Find recipient by username
    const recipientSocket = Object.entries(onlineUsers).find(([sid, u]) => u.username === to);
    if (recipientSocket) {
      io.to(recipientSocket[0]).emit("call-rejected");
    }
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
    
    const usersList = Object.values(onlineUsers).map(u => u.username);
    io.emit('online_users', usersList);

    if (ip && ipConnections[ip]) { 
      ipConnections[ip]--; 
      if (ipConnections[ip] <= 0) delete ipConnections[ip]; 
    }
    delete rateLimitState[socket.id];
    delete lastMessageText[socket.id];
  });
});

app.get("/", (_, res) => res.send("Server OK"));

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log("Server running on " + PORT));
