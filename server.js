// server.js
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

// Detect Render environment: use /tmp folder for live_messages.json
const LIVE_CHAT_FILE = process.env.RENDER
  ? path.join("/tmp", "live_messages.json")
  : path.join(__dirname, "live_messages.json");

// Load messages on server start
let liveChatMessages = [];
try {
  if (fs.existsSync(LIVE_CHAT_FILE)) {
    liveChatMessages = JSON.parse(fs.readFileSync(LIVE_CHAT_FILE, "utf8"));
  } else {
    fs.writeFileSync(LIVE_CHAT_FILE, "[]");
  }
} catch (err) {
  console.error("Error loading messages:", err);
}

// Save messages to file
function saveMessages() {
  try {
    fs.writeFileSync(LIVE_CHAT_FILE, JSON.stringify(liveChatMessages, null, 2));
  } catch (err) {
    console.error("Error saving messages:", err);
  }
}

// Online users
const onlineUsers = {};

// REST route to load history
app.get('/live-messages', (req, res) => {
  res.json(liveChatMessages);
});

// Socket setup
io.on('connection', (socket) => {
  const userID = socket.handshake.auth?.userID;
  if (!userID) return socket.disconnect();

  if (!onlineUsers[userID]) onlineUsers[userID] = [];
  onlineUsers[userID].push(socket.id);

  io.emit('online_users', Object.keys(onlineUsers));

  // PRIVATE MESSAGE
  socket.on("private_message", ({ to, from, text, time }) => {
    (onlineUsers[to] || []).forEach(sid =>
      io.to(sid).emit("receive_private", { from, text, time })
    );
  });

  // LIVE CHAT MESSAGE
  socket.on("live_message", (msg) => {
    liveChatMessages.push(msg);

    // Limit to last 200 messages
    if (liveChatMessages.length > 200) liveChatMessages.shift();

    saveMessages(); // persist messages
    io.emit("live_message", msg); // broadcast
  });

  // Disconnect
  socket.on("disconnect", () => {
    if (onlineUsers[userID]) {
      onlineUsers[userID] = onlineUsers[userID].filter(id => id !== socket.id);
      if (!onlineUsers[userID].length) delete onlineUsers[userID];
    }
    io.emit('online_users', Object.keys(onlineUsers));
  });
});

// Health check
app.get("/", (_, res) => res.send("Server OK"));

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log("Server running on " + PORT));
