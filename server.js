// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*' },
  path: '/socket.io',
});

// Online users map: userID -> [socketIDs]
const onlineUsers = {};

// --- REST endpoint to create rooms (optional, you can remove if not used) ---
app.get('/create-room', (req, res) => {
  const roomID = 'room-' + Math.random().toString(36).substring(2, 10);
  res.json({ roomID });
});

// --- Socket.IO ---
io.on('connection', (socket) => {
  const userID = socket.handshake.auth?.userID;
  if (!userID) return socket.disconnect();

  if (!onlineUsers[userID]) onlineUsers[userID] = [];
  onlineUsers[userID].push(socket.id);

  console.log(`User connected: ${userID} -> ${socket.id}`);
  io.emit('online_users', Object.keys(onlineUsers));

  // --- Private messaging ---
  socket.on('private_message', ({ to, from, text, time }) => {
    (onlineUsers[to] || []).forEach(sid => io.to(sid).emit('receive_private', { from, text, time }));
  });

  // --- Disconnect ---
  socket.on('disconnect', () => {
    console.log(`Disconnected: ${userID} -> ${socket.id}`);

    if (onlineUsers[userID]) {
      onlineUsers[userID] = onlineUsers[userID].filter(sid => sid !== socket.id);
      if (!onlineUsers[userID].length) delete onlineUsers[userID];
    }

    io.emit('online_users', Object.keys(onlineUsers));
  });
});

// --- Health check ---
app.get('/', (req, res) => res.send('Server running with Socket.IO'));

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Server listening on ${PORT}`));
