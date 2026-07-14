/**
 * broadcaster.js — Logique côté Diffuseur
 * WebRTC compatible tous navigateurs (Chrome, Opera, Firefox, Edge, Safari)
 * Trickle ICE + Buffering + TURN fallback
 */

'use strict';

// ─── Éléments DOM ─────────────────────────────────────────────────────────
const btnStart         = document.getElementById('btn-start');
const btnStop          = document.getElementById('btn-stop');
const statusMsg        = document.getElementById('bc-status-msg');
const listenerCountEl  = document.getElementById('listener-count');
const broadcastIcon    = document.getElementById('broadcast-status-icon');
const broadcastTimeEl  = document.getElementById('broadcast-time');
const liveBadge        = document.getElementById('bc-live-badge');
const liveLabel        = document.getElementById('bc-live-label');
const audioSourceSel   = document.getElementById('audio-source');
const fileDropZone     = document.getElementById('file-drop-zone');
const audioFileInput   = document.getElementById('audio-file-input');
const fileNameEl       = document.getElementById('file-name');
const localAudio       = document.getElementById('local-audio');
const meterFill        = document.getElementById('audio-meter-fill');
const meterWrapper     = document.getElementById('audio-meter-wrapper');
const toastEl          = document.getElementById('toast');
const yearEl           = document.getElementById('year');

let socket          = null;
let localStream     = null;
let peerConnections = {}; // { listenerId: RTCPeerConnection }
let pendingIce      = {}; // { listenerId: [ candidateObject ] }
let sdpSet          = {}; // { listenerId: boolean }

let audioContext    = null;
let analyserNode    = null;
let meterSourceNode = null;
let animFrameId     = null;
let broadcastStart  = null;
let timerInterval   = null;
let isBroadcasting  = false;
let fileAudioCtx    = null;

if (yearEl) yearEl.textContent = new Date().getFullYear();

// ─── Détection navigateur ─────────────────────────────────────────────────
const browserInfo = (() => {
  const ua = navigator.userAgent;
  if (ua.includes('OPR/') || ua.includes('Opera'))  return { name: 'Opera', isOpera: true };
  if (ua.includes('Firefox'))                        return { name: 'Firefox', isFirefox: true };
  if (ua.includes('Edg/'))                           return { name: 'Edge', isEdge: true };
  if (ua.includes('Safari') && !ua.includes('Chrome')) return { name: 'Safari', isSafari: true };
  return { name: 'Chrome', isChrome: true };
})();
console.log(`[Broadcaster] Navigateur détecté : ${browserInfo.name}`);

// ─── Config ICE ───────────────────────────────────────────────────────────
function getIceConfig() {
  const host = window.location.hostname;
  return {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      {
        urls: [
          `turn:${host}:3478?transport=udp`,
          `turn:${host}:3478?transport=tcp`
        ],
        username: 'radio',
        credential: 'radio'
      }
    ],
    iceTransportPolicy: 'all',
    iceCandidatePoolSize: 2,
    sdpSemantics: 'unified-plan'
  };
}

// ─── UI Helpers ───────────────────────────────────────────────────────────
function setStatus(msg, type = '') {
  statusMsg.textContent = msg;
  statusMsg.className = 'status-msg' + (type ? ` ${type}` : '');
}

function setLiveState(live) {
  isBroadcasting = live;
  liveBadge.className = 'live-badge ' + (live ? 'online' : 'offline');
  liveLabel.textContent = live ? 'EN DIRECT' : 'HORS LIGNE';
  broadcastIcon.textContent = live ? '🔴' : '⚪';
  btnStart.disabled = live;
  btnStop.disabled  = !live;
}

function showToast(msg, duration = 3000) {
  toastEl.textContent = msg;
  toastEl.classList.add('visible');
  setTimeout(() => toastEl.classList.remove('visible'), duration);
}

function updateTimer() {
  if (!broadcastStart) return;
  const e = Math.floor((Date.now() - broadcastStart) / 1000);
  broadcastTimeEl.textContent = `${String(Math.floor(e / 60)).padStart(2,'0')}:${String(e % 60).padStart(2,'0')}`;
}

// ─── Visu-mètre ────────────────────────────────────────────────────────────
function startAudioMeter(stream) {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioCtx();

    // Reprendre l'AudioContext s'il est suspendu (politique autoplay)
    if (audioContext.state === 'suspended') {
      audioContext.resume();
    }

    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 256;
    meterSourceNode = audioContext.createMediaStreamSource(stream);
    meterSourceNode.connect(analyserNode);

    const data = new Uint8Array(analyserNode.frequencyBinCount);
    function draw() {
      analyserNode.getByteFrequencyData(data);
      const pct = Math.min(100, (data.reduce((a,b) => a+b, 0) / data.length / 128) * 100);
      meterFill.style.width = pct + '%';
      meterWrapper.setAttribute('aria-valuenow', Math.round(pct));
      animFrameId = requestAnimationFrame(draw);
    }
    draw();
  } catch(e) { console.warn('[Broadcaster] Meter error:', e); }
}

function stopAudioMeter() {
  if (animFrameId) cancelAnimationFrame(animFrameId);
  if (meterSourceNode){ meterSourceNode.disconnect(); meterSourceNode = null; }
  if (analyserNode)   { analyserNode.disconnect();    analyserNode = null; }
  if (audioContext)   { audioContext.close(); audioContext = null; }
  meterFill.style.width = '0%';
}

// ─── Source Audio ─────────────────────────────────────────────────────────
audioSourceSel.addEventListener('change', () => {
  const isMic = audioSourceSel.value === 'mic';
  fileDropZone.style.display = isMic ? 'none' : 'block';
  localAudio.style.display   = isMic ? 'none' : 'block';
});

fileDropZone.addEventListener('dragover', e => { e.preventDefault(); fileDropZone.classList.add('drag-over'); });
fileDropZone.addEventListener('dragleave', () => fileDropZone.classList.remove('drag-over'));
fileDropZone.addEventListener('drop', e => {
  e.preventDefault(); fileDropZone.classList.remove('drag-over');
  if (e.dataTransfer?.files[0]) loadAudioFile(e.dataTransfer.files[0]);
});
audioFileInput.addEventListener('change', () => {
  if (audioFileInput.files[0]) loadAudioFile(audioFileInput.files[0]);
});

function loadAudioFile(file) {
  if (fileAudioCtx) { fileAudioCtx.close(); fileAudioCtx = null; }
  fileNameEl.textContent = `✅ ${file.name}`;
  localAudio.src  = URL.createObjectURL(file);
  localAudio.loop = true;
  localAudio.load();
  localAudio.style.display = 'block';
}

async function getSourceStream() {
  const source = audioSourceSel.value;

  if (source === 'mic') {
    // Contraintes audio compatibles tous navigateurs
    const constraints = {
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    };

    // Ajouter sampleRate seulement si supporté (évite erreur sur certains navigateurs)
    try {
      const supported = navigator.mediaDevices.getSupportedConstraints();
      if (supported.sampleRate) {
        constraints.audio.sampleRate = 48000;
      }
    } catch(e) { /* ignore */ }

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    console.log('[Broadcaster] Mic OK, tracks:', stream.getAudioTracks().length);
    return stream;
  }

  if (source === 'file') {
    if (!localAudio.src || localAudio.src === window.location.href) throw new Error('Veuillez sélectionner un fichier.');
    await localAudio.play();
    localAudio.loop = true;

    let stream;

    // Méthode 1 : captureStream natif
    if (typeof localAudio.captureStream === 'function') {
      stream = localAudio.captureStream();
      console.log('[Broadcaster] captureStream() utilisé');
    }
    // Méthode 2 : mozCaptureStream (Firefox)
    else if (typeof localAudio.mozCaptureStream === 'function') {
      stream = localAudio.mozCaptureStream();
      console.log('[Broadcaster] mozCaptureStream() utilisé');
    }
    // Méthode 3 : AudioContext fallback (pour navigateurs sans captureStream)
    else {
      console.log('[Broadcaster] Fallback AudioContext pour capture');
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      fileAudioCtx = new AudioCtx();
      await fileAudioCtx.resume();
      const src  = fileAudioCtx.createMediaElementSource(localAudio);
      const dest = fileAudioCtx.createMediaStreamDestination();
      src.connect(dest);
      src.connect(fileAudioCtx.destination); // Garder le son local
      stream = dest.stream;
    }

    if (!stream || stream.getAudioTracks().length === 0) throw new Error('Capture audio échouée.');
    console.log('[Broadcaster] File stream OK, tracks:', stream.getAudioTracks().length);
    return stream;
  }

  throw new Error('Source inconnue.');
}

// ─── WebRTC (Peer) ────────────────────────────────────────────────────────
async function createPeerForListener(listenerId) {
  // Nettoyer l'ancien peer si existant
  if (peerConnections[listenerId]) {
    try { peerConnections[listenerId].close(); } catch(e) {}
    delete peerConnections[listenerId];
  }

  const iceConfig = getIceConfig();
  const peer = new RTCPeerConnection(iceConfig);
  peerConnections[listenerId] = peer;
  pendingIce[listenerId] = [];
  sdpSet[listenerId] = false;

  // Ajouter les pistes audio
  if (localStream) {
    localStream.getAudioTracks().forEach(track => {
      peer.addTrack(track, localStream);
      console.log(`[Broadcaster] Track ajouté pour ${listenerId}: ${track.label}`);
    });
  }

  peer.onicecandidate = ({ candidate }) => {
    if (candidate) {
      console.log(`[Broadcaster] ICE pour ${listenerId}:`, candidate.type, candidate.protocol);
      socket.emit('broadcaster-ice', { listenerId, candidate });
    } else {
      console.log(`[Broadcaster] Fin ICE pour ${listenerId}`);
    }
  };

  peer.onconnectionstatechange = () => {
    const state = peer.connectionState;
    console.log(`[Broadcaster] Peer ${listenerId} state: ${state}`);

    if (state === 'connected') {
      console.log(`[Broadcaster] ✓ Connexion établie avec ${listenerId}`);
    }
    if (state === 'disconnected' || state === 'failed' || state === 'closed') {
      // Nettoyer proprement
      try { peer.close(); } catch(e) {}
      delete peerConnections[listenerId];
      delete pendingIce[listenerId];
      delete sdpSet[listenerId];
    }
  };

  peer.oniceconnectionstatechange = () => {
    console.log(`[Broadcaster] ICE state ${listenerId}: ${peer.iceConnectionState}`);
  };

  return peer;
}

// ─── Actions ──────────────────────────────────────────────────────────────
btnStart.addEventListener('click', async () => {
  btnStart.disabled = true;
  setStatus('Initialisation audio…', 'loading');
  try {
    localStream = await getSourceStream();
    if (!localStream.getAudioTracks().length) throw new Error('Aucune piste audio.');

    console.log('[Broadcaster] Stream prêt, tracks:', localStream.getAudioTracks().map(t => t.label));

    startAudioMeter(localStream);
    setLiveState(true);
    broadcastStart = Date.now();
    timerInterval  = setInterval(updateTimer, 1000);

    socket.emit('register-broadcaster');
    setStatus("Diffusion active. En attente d'auditeurs…", 'success');
    showToast('🎙️ Diffusion démarrée !');
  } catch (err) {
    console.error('[Broadcaster] Erreur démarrage:', err);
    setStatus(`Erreur : ${err.message}`, 'error');
    btnStart.disabled = false;
    setLiveState(false);
  }
});

btnStop.addEventListener('click', () => { stopBroadcast(); showToast('⏹ Diffusion arrêtée.'); });

function stopBroadcast() {
  // Fermer toutes les peer connections proprement
  Object.entries(peerConnections).forEach(([id, p]) => {
    try {
      p.onicecandidate = null;
      p.onconnectionstatechange = null;
      p.oniceconnectionstatechange = null;
      p.close();
    } catch(e) {}
  });
  peerConnections = {};
  pendingIce = {};
  sdpSet = {};

  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (localAudio) { localAudio.pause(); localAudio.currentTime = 0; }
  if (fileAudioCtx) { fileAudioCtx.close(); fileAudioCtx = null; }

  stopAudioMeter();
  clearInterval(timerInterval);
  broadcastStart = null;
  broadcastTimeEl.textContent = '--:--';
  listenerCountEl.textContent = '0';
  setLiveState(false);
  setStatus('Diffusion terminée.', '');
}

// ─── Socket.io ────────────────────────────────────────────────────────────
function connectSocket() {
  // Autoriser le fallback polling → websocket pour compatibilité maximale
  socket = io({
    transports: ['websocket', 'polling'],
    upgrade: true,
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    timeout: 10000
  });

  socket.on('connect', () => {
    console.log('[Broadcaster] Socket connecté:', socket.id);
    setStatus('Connecté au serveur. Prêt à diffuser.', 'success');
  });

  socket.on('connect_error', (err) => {
    console.warn('[Broadcaster] Erreur connexion socket:', err.message);
    setStatus('Impossible de se connecter au serveur.', 'error');
  });

  socket.on('disconnect', (reason) => {
    console.warn('[Broadcaster] Socket déconnecté:', reason);
    setStatus('Connexion perdue.', 'error');
    stopBroadcast();
  });

  socket.on('broadcaster-registered', ({ listenerCount }) => {
    listenerCountEl.textContent = listenerCount;
  });

  socket.on('error-broadcaster', (msg) => {
    setStatus(`⚠️ ${msg}`, 'error');
    stopBroadcast();
    showToast(`⚠️ ${msg}`, 5000);
  });

  socket.on('listener-count', count => { listenerCountEl.textContent = count; });

  // ── Réception de l'offre d'un listener ────────────────────────────────
  socket.on('listener-offer', async ({ listenerId, offer }) => {
    console.log(`[Broadcaster] Offer reçue de ${listenerId}`);
    try {
      const peer = await createPeerForListener(listenerId);

      // Compatibilité : recréer l'objet SDP proprement
      const desc = new RTCSessionDescription({ type: offer.type, sdp: offer.sdp });
      await peer.setRemoteDescription(desc);
      sdpSet[listenerId] = true;
      console.log(`[Broadcaster] remoteDescription OK pour ${listenerId}`);

      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);

      // Envoyer la localDescription (contient l'answer complète)
      socket.emit('broadcaster-answer', {
        listenerId,
        answer: { type: peer.localDescription.type, sdp: peer.localDescription.sdp }
      });
      console.log(`[Broadcaster] Answer envoyée à ${listenerId}`);

      // Appliquer les ICE en attente pour ce listener
      if (pendingIce[listenerId] && pendingIce[listenerId].length > 0) {
        console.log(`[Broadcaster] Application de ${pendingIce[listenerId].length} ICE en attente`);
        for (const c of pendingIce[listenerId]) {
          try { await peer.addIceCandidate(new RTCIceCandidate(c)); } catch(e) {
            console.warn('[Broadcaster] Erreur ICE en attente:', e.message);
          }
        }
        pendingIce[listenerId] = [];
      }
    } catch (e) {
      console.error(`[Broadcaster] Erreur pour ${listenerId}:`, e);
    }
  });

  // ── Réception ICE d'un listener ───────────────────────────────────────
  socket.on('listener-ice', async ({ listenerId, candidate }) => {
    if (!candidate) return;
    const peer = peerConnections[listenerId];
    if (peer && sdpSet[listenerId]) {
      try { await peer.addIceCandidate(new RTCIceCandidate(candidate)); } catch(e) {
        console.warn(`[Broadcaster] Erreur ajout ICE ${listenerId}:`, e.message);
      }
    } else {
      // Initialiser le buffer si nécessaire
      if (!pendingIce[listenerId]) pendingIce[listenerId] = [];
      pendingIce[listenerId].push(candidate);
    }
  });
}

connectSocket();
