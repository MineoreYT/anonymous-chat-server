// server.js -- Secure Chat Server
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// config
const PORT = process.env.PORT || 4000;
const IS_RENDER = !!process.env.RENDER;
const LIVE_CHAT_FILE = IS_RENDER ? path.join("/tmp", "live_messages.json") : path.join(__dirname, "live_messages.json");
const MAX_STORED_MESSAGES = 200;
const MAX_MESSAGE_LENGTH = 300; // characters
const MAX_IMAGE_SIZE_BASE64 = 150000; // approx characters limit for inline base64 (discouraged)
const MAX_CONNECTIONS_PER_IP = 6;
const RATE_LIMIT_WINDOW_MS = 3000; // window for rate limiting
const RATE_LIMIT_MAX_MESSAGES = 8; // allowed messages per window

// helpers
function generateUserID() {
  const adjectives = ["Swift","Silent","Brave","Lucky","Clever","Mighty","Happy","Cosmic","Frosty","Shadow"];
  const animals = ["Tiger","Falcon","Wolf","Panda","Eagle","Lion","Otter","Hawk","Bear","Dragon"];
  const adj = adjectives[Math.floor(Math.random()*adjectives.length)];
  const animal = animals[Math.floor(Math.random()*animals.length)];
  return `${adj}${animal}-${Math.floor(1000 + Math.random()*9000)}`;
}

function sanitizeText(s) {
  if (typeof s !== 'string') return '';
  // lightweight sanitization: remove angle-brackets and trim
  return s.replace(/[<>]/g, '').trim();
}

function isBase64Image(text) {
  return typeof text === 'string' && text.startsWith('data:image/');
}

// persistent storage load/save
let liveChatMessages = [];
try {
  if (fs.existsSync(LIVE_CHAT_FILE)) {
    const raw = fs.readFileSync(LIVE_CHAT_FILE, 'utf8');
    liveChatMessages = JSON.parse(raw || "[]");
  } else {
    fs.writeFileSync(LIVE_CHAT_FILE, "[]");
  }
} catch (err) {
  console.error('Failed to load live messages:', err);
  liveChatMessages = [];
}

function saveMessages() {
  try {
    fs.writeFileSync(LIVE_CHAT_FILE, JSON.stringify(liveChatMessages.slice(-MAX_STORED_MESSAGES), null, 2));
  } catch (err) {
    console.error('Failed to save live messages:', err);
  }
}

/* In-memory runtime state */
const onlineUsers = {}; // { userID: [socketId, ...] }
const socketToUser = {}; // { socket.id: userID }
const ipConnections = {}; // { ip: count }
const rateLimitState = {}; // { socket.id: { count, windowStart } }

// express route for history
app.get('/live-messages', (req, res) => {
  res.json(liveChatMessages.slice(-MAX_STORED_MESSAGES));
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  path: '/socket.io'
});


function getClientIP(socket) {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  // fallback to socket address
  return socket.handshake.address;
}

/* Socket handling */
io.on('connection', (socket) => {
  try {
    const ip = getClientIP(socket);
    ipConnections[ip] = (ipConnections[ip] || 0) + 1;

    if (ipConnections[ip] > MAX_CONNECTIONS_PER_IP) {
      console.warn(`IP ${ip} exceeded max connections (${ipConnections[ip]}). Disconnecting.`);
      socket.emit('error', { message: 'Too many connections from your IP' });
      socket.disconnect(true);
      ipConnections[ip]--;
      return;
    }

    // assign server-generated userID (client cannot choose)
    const userID = generateUserID();
    socket.userID = userID;
    socketToUser[socket.id] = userID;

    // store in onlineUsers
    if (!onlineUsers[userID]) onlineUsers[userID] = [];
    onlineUsers[userID].push(socket.id);

    // init rate-limit state
    rateLimitState[socket.id] = { count: 0, windowStart: Date.now() };

    // send welcome with assigned userID (client should accept this)
    socket.emit('welcome', { userID });

    // broadcast current online users list
    io.emit('online_users', Object.keys(onlineUsers));

    /* PRIVATE MESSAGE HANDLER */
    socket.on('private_message', (payload) => {
      try {
        // enforce structure & sanitize
        const to = String(payload?.to || '').trim();
        let text = sanitizeText(payload?.text || '');
        const time = payload?.time || new Date().toLocaleTimeString();

        // basic validation
        if (!to || !text) return;
        if (text.length > MAX_MESSAGE_LENGTH) return; // drop too long messages

        // prevent inline base64 image spam in private messages (optional: allow via upload endpoint)
        if (isBase64Image(text) && text.length > MAX_IMAGE_SIZE_BASE64) return;

        // force 'from' to server-assigned userid (prevent spoof)
        const from = socket.userID;

        // deliver to all sockets of recipient
        const destSockets = onlineUsers[to] || [];
        destSockets.forEach(sid => {
          io.to(sid).emit('receive_private', { from, text, time });
        });

        // optionally send ack to sender
        socket.emit('private_sent', { to, text, time });
      } catch (err) {
        console.error('private_message error', err);
      }
    });

    /* LIVE MESSAGE HANDLER */
    socket.on('live_message', (payload) => {
      try {
        // rate limit check
        const now = Date.now();
        const rl = rateLimitState[socket.id] || { count: 0, windowStart: now };
        if (now - rl.windowStart > RATE_LIMIT_WINDOW_MS) {
          rl.windowStart = now;
          rl.count = 0;
        }
        rl.count++;
        rateLimitState[socket.id] = rl;
        if (rl.count > RATE_LIMIT_MAX_MESSAGES) {
          // silently drop excess messages or notify
          if (rl.count === RATE_LIMIT_MAX_MESSAGES + 1) {
            socket.emit('warning', { message: 'You are sending messages too fast. Slow down.' });
          }
          return;
        }

        // validate payload
        let text = sanitizeText(payload?.text || '');
        if (!text) return;
        if (text.length > MAX_MESSAGE_LENGTH) return;

        // block huge base64 strings (disallow inline large images)
        if (isBase64Image(text)) {
          if (text.length > MAX_IMAGE_SIZE_BASE64) return;
          // optionally: reject inline images entirely:
          // return;
        }

        // force authoritative userID for message origin
        const msg = {
          userID: socket.userID,
          text,
          time: new Date().toLocaleTimeString()
        };

        // append & persist (cap size)
        liveChatMessages.push(msg);
        if (liveChatMessages.length > MAX_STORED_MESSAGES) liveChatMessages.shift();
        saveMessages();

        // broadcast
        io.emit('live_message', msg);
      } catch (err) {
        console.error('live_message error', err);
      }
    });

    

    /* disconnect handling */
    socket.on('disconnect', () => {
      // remove socket.id from onlineUsers mapping
      const sid = socket.id;
      const uid = socketToUser[sid];

      if (uid && onlineUsers[uid]) {
        onlineUsers[uid] = onlineUsers[uid].filter(x => x !== sid);
        if (onlineUsers[uid].length === 0) delete onlineUsers[uid];
      }

      delete socketToUser[sid];
      delete rateLimitState[sid];

      // reduce ipConnections
      if (ip && ipConnections[ip]) {
        ipConnections[ip]--;
        if (ipConnections[ip] <= 0) delete ipConnections[ip];
      }

      // broadcast updated online users
      io.emit('online_users', Object.keys(onlineUsers));
    });

    /* protect: catch-all error handler for this socket */
    socket.on('error', (err) => {
      console.warn('socket error', err);
    });
  } catch (err) {
    console.error('connection handler error', err);
    try { socket.disconnect(true); } catch(e) {}
  }
});

app.get('/', (_, res) => res.send('Secure chat server running'));

server.listen(PORT, () => console.log(`Secure chat server listening on ${PORT}`));
