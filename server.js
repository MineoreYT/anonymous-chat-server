// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Create HTTP server
const server = http.createServer(app);

// Socket.IO server
const io = new Server(server, {
  cors: { origin: '*' },
  path: '/socket.io', // explicitly define path
});

// Online users map: userID -> [socketIDs]
let onlineUsers = {};

// Rooms: roomID -> [socketIDs]
let rooms = {};

// --- REST endpoint to create rooms ---
app.get('/create-room', (req, res) => {
  const roomID = 'room-' + Math.random().toString(36).substring(2, 10);
  rooms[roomID] = [];
  res.json({ roomID });
});

// --- Socket.IO connection ---
io.on('connection', (socket) => {
  const userID = socket.handshake.auth?.userID;
  if (!userID) {
    console.log('Connection without userID — disconnecting', socket.id);
    socket.disconnect();
    return;
  }




  // Add socket to onlineUsers
  if (!onlineUsers[userID]) onlineUsers[userID] = [];
  onlineUsers[userID].push(socket.id);

  console.log(`User connected: ${userID} -> ${socket.id}`);
  io.emit('online_users', Object.keys(onlineUsers));

  // --- Private messaging ---
  socket.on('private_message', ({ to, from, text, time }) => {
    const targets = onlineUsers[to] || [];
    targets.forEach(sid => io.to(sid).emit('receive_private', { from, text, time }));
  });

  // --- WebRTC calls ---
  socket.on('call-user', ({ to, offer }) => {
    const targets = onlineUsers[to] || [];
    if (!targets.length) {
      socket.emit('call-error', { message: 'User not available' });
      return;
    }
    io.to(targets[0]).emit('incoming-call', {
      from: userID,
      fromSocketId: socket.id,
      offer,
    });
  });

  socket.on('answer-call', ({ toSocketId, answer }) => {
    io.to(toSocketId).emit('call-answered', { from: userID, answer, fromSocketId: socket.id });
  });

  socket.on('ice-candidate', ({ toSocketId, candidate }) => {
    if (toSocketId && candidate) io.to(toSocketId).emit('ice-candidate', { fromSocketId: socket.id, candidate });
  });

  socket.on('end-call', ({ toSocketId }) => {
    if (toSocketId) io.to(toSocketId).emit('call-ended', { fromSocketId: socket.id });
  });

  // --- Rooms ---
  socket.on('join-room', (roomID) => {
    if (!rooms[roomID]) rooms[roomID] = [];
    rooms[roomID].push(socket.id);
    socket.join(roomID);
    console.log(`${socket.id} joined room ${roomID}`);
  });

  socket.on('room-message', ({ roomID, from, text, time }) => {
    io.to(roomID).emit('room-message', { from, text, time });
  });

  // --- Disconnect ---
  socket.on('disconnect', () => {
    console.log(`Disconnected: ${userID} -> ${socket.id}`);

    if (onlineUsers[userID]) {
      onlineUsers[userID] = onlineUsers[userID].filter(sid => sid !== socket.id);
      if (!onlineUsers[userID].length) delete onlineUsers[userID];
    }
    io.emit('online_users', Object.keys(onlineUsers));

    for (const roomID in rooms) {
      rooms[roomID] = rooms[roomID].filter(sid => sid !== socket.id);
      if (!rooms[roomID].length) delete rooms[roomID];
    }
  });
});

// --- Simple health check ---
app.get('/', (req, res) => res.send('Server running with Socket.IO'));

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Server listening on ${PORT}`));

