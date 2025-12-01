const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Online users (multiple sockets per userID)
let onlineUsers = {}; // userID -> [socketIDs]

// Rooms (roomID -> array of socketIDs)
let rooms = {}; 

// --- Create private room endpoint ---
app.get('/create-room', (req, res) => {
  const roomID = 'room-' + Math.random().toString(36).substring(2, 10);
  rooms[roomID] = [];
  res.json({ roomID });
});

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

  console.log('Connected:', userID, '->', socket.id);
  io.emit('online_users', Object.keys(onlineUsers));

  // --- Private messaging ---
  socket.on('private_message', ({ to, from, text, time }) => {
    const targetSockets = onlineUsers[to] || [];
    targetSockets.forEach(sid => io.to(sid).emit('receive_private', { from, text, time }));
  });

  // --- WebRTC calls ---
  socket.on('call-user', ({ to, offer }) => {
    const targetSockets = onlineUsers[to] || [];
    if (!targetSockets.length) {
      socket.emit('call-error', { message: 'User not available' });
      return;
    }
    io.to(targetSockets[0]).emit('incoming-call', {
      from: userID,
      fromSocketId: socket.id,
      offer
    });
  });

  socket.on('answer-call', ({ toSocketId, answer }) => {
    io.to(toSocketId).emit('call-answered', { from: userID, answer, fromSocketId: socket.id });
  });

  socket.on('ice-candidate', ({ toSocketId, candidate }) => {
    if (!toSocketId || !candidate) return;
    io.to(toSocketId).emit('ice-candidate', { fromSocketId: socket.id, candidate });
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
    console.log('Disconnected:', userID, socket.id);

    // Remove from onlineUsers
    if (onlineUsers[userID]) {
      onlineUsers[userID] = onlineUsers[userID].filter(sid => sid !== socket.id);
      if (!onlineUsers[userID].length) delete onlineUsers[userID];
    }
    io.emit('online_users', Object.keys(onlineUsers));

    // Remove from rooms
    for (const roomID in rooms) {
      rooms[roomID] = rooms[roomID].filter(sid => sid !== socket.id);
      if (!rooms[roomID].length) delete rooms[roomID];
    }
  });
});

app.get('/', (req, res) => res.send('Server running'));
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Server listening on ${PORT}`));
