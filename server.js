/**
 * Serveur de signalisation WebRTC pour Webradio
 * Architecture : 1 Broadcaster → N Listeners via WebRTC
 * Compatible tous navigateurs + hébergement cloud (Render, Railway…)
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  // Compatibilité maximale : polling + websocket
  transports: ['websocket', 'polling'],
  allowUpgrades: true,
  pingTimeout: 30000,
  pingInterval: 10000
});

// Servir les fichiers statiques depuis /public
app.use(express.static(path.join(__dirname, 'public')));

// ─── Endpoint de diagnostic ───────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({
    broadcaster: !!broadcasterSocketId,
    listeners: listeners.size,
    uptime: process.uptime()
  });
});

// ─── État du serveur ───────────────────────────────────────────────────────
let broadcasterSocketId = null;      // Socket ID du diffuseur actif
const listeners = new Map();          // Map<socketId, socket>

// ─── Connexions Socket.io ──────────────────────────────────────────────────
io.on('connection', (socket) => {
  const transport = socket.conn.transport.name;
  console.log(`[+] Connexion : ${socket.id} (transport: ${transport})`);

  // Log quand le transport s'upgrade
  socket.conn.on('upgrade', (transport) => {
    console.log(`[↑] Upgrade ${socket.id} → ${transport.name}`);
  });

  // ── Enregistrement du Broadcaster ──────────────────────────────────────
  socket.on('register-broadcaster', () => {
    if (broadcasterSocketId && io.sockets.sockets.get(broadcasterSocketId)) {
      socket.emit('error-broadcaster', 'Un diffuseur est déjà connecté.');
      return;
    }
    broadcasterSocketId = socket.id;
    console.log(`[🎙️] Broadcaster enregistré : ${socket.id}`);

    // Notifier le broadcaster du nombre d'auditeurs actuels
    socket.emit('broadcaster-registered', { listenerCount: listeners.size });

    // Notifier tous les auditeurs qu'un direct est disponible
    listeners.forEach((listenerSocket) => {
      listenerSocket.emit('broadcaster-available');
    });
  });

  // ── Enregistrement d'un Listener ──────────────────────────────────────
  socket.on('register-listener', () => {
    listeners.set(socket.id, socket);
    console.log(`[👂] Auditeur #${listeners.size} : ${socket.id}`);

    // Notifier le broadcaster du nouveau count
    if (broadcasterSocketId) {
      const broadcaster = io.sockets.sockets.get(broadcasterSocketId);
      if (broadcaster) {
        broadcaster.emit('listener-count', listeners.size);
      }
      // Informer le listener qu'un direct est disponible
      socket.emit('broadcaster-available');
    } else {
      socket.emit('no-broadcaster');
    }
  });

  // ── Signalisation WebRTC : Listener → Broadcaster ──────────────────────
  socket.on('listener-offer', ({ offer }) => {
    if (!broadcasterSocketId) {
      socket.emit('no-broadcaster');
      return;
    }
    const broadcaster = io.sockets.sockets.get(broadcasterSocketId);
    if (broadcaster) {
      console.log(`[→] Offer de ${socket.id} vers broadcaster`);
      broadcaster.emit('listener-offer', { listenerId: socket.id, offer });
    }
  });

  // ── Signalisation WebRTC : Broadcaster → Listener ──────────────────────
  socket.on('broadcaster-answer', ({ listenerId, answer }) => {
    const listener = listeners.get(listenerId);
    if (listener) {
      console.log(`[←] Answer du broadcaster vers ${listenerId}`);
      listener.emit('broadcaster-answer', { answer });
    }
  });

  // ── Échange ICE Candidates : Listener → Broadcaster ────────────────────
  socket.on('listener-ice', ({ candidate }) => {
    if (!candidate) return;
    const broadcaster = io.sockets.sockets.get(broadcasterSocketId);
    if (broadcaster) {
      broadcaster.emit('listener-ice', { listenerId: socket.id, candidate });
    }
  });

  // ── Échange ICE Candidates : Broadcaster → Listener ────────────────────
  socket.on('broadcaster-ice', ({ listenerId, candidate }) => {
    if (!candidate) return;
    const listener = listeners.get(listenerId);
    if (listener) {
      listener.emit('broadcaster-ice', { candidate });
    }
  });

  // ── Demande de connexion explicite (listener → broadcaster) ─────────────
  socket.on('request-stream', () => {
    const broadcaster = io.sockets.sockets.get(broadcasterSocketId);
    if (broadcaster) {
      broadcaster.emit('new-listener', { listenerId: socket.id });
    } else {
      socket.emit('no-broadcaster');
    }
  });

  // ── Déconnexion ──────────────────────────────────────────────────────────
  socket.on('disconnect', (reason) => {
    console.log(`[-] Déconnexion : ${socket.id} (${reason})`);

    if (socket.id === broadcasterSocketId) {
      broadcasterSocketId = null;
      console.log('[🎙️] Broadcaster déconnecté');
      listeners.forEach((listenerSocket) => {
        listenerSocket.emit('broadcaster-disconnected');
      });
    } else if (listeners.has(socket.id)) {
      listeners.delete(socket.id);
      console.log(`[👂] Auditeurs restants : ${listeners.size}`);
      if (broadcasterSocketId) {
        const broadcaster = io.sockets.sockets.get(broadcasterSocketId);
        if (broadcaster) {
          broadcaster.emit('listener-count', listeners.size);
        }
      }
    }
  });
});

// ─── Démarrage ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎶 Serveur Webradio démarré sur le port ${PORT}`);
  console.log(`   Diffuseur  → http://localhost:${PORT}/broadcaster.html`);
  console.log(`   Auditeurs  → http://localhost:${PORT}/\n`);
});
