/**
 * app.js — Logique côté Auditeur (Listener)
 * WebRTC compatible tous navigateurs (Chrome, Opera, Firefox, Edge, Safari)
 * Trickle ICE + Buffering + TURN fallback + Retry automatique
 */

'use strict';

// ─── Éléments DOM ─────────────────────────────────────────────────────────
const playerCard   = document.getElementById('player-card');
const btnPlay      = document.getElementById('btn-play');
const liveBadge    = document.getElementById('live-badge');
const liveLabel    = document.getElementById('live-label');
const statusMsg    = document.getElementById('status-msg');
const audioPlayer  = document.getElementById('audio-player');
const volumeSlider = document.getElementById('volume-slider');
const volumePct    = document.getElementById('volume-pct');
const volumeIcon   = document.getElementById('volume-icon');
const artworkRing  = document.getElementById('artwork-ring');
const equalizer    = document.getElementById('equalizer');
const trackTitle   = document.getElementById('track-title');
const trackSub     = document.getElementById('track-subtitle');
const toastEl      = document.getElementById('toast');
const yearEl       = document.getElementById('year');

let socket         = null;
let peerConn       = null;
let isPlaying      = false;
let isBroadcasting = false;
let prevVolume     = 80;
let pendingIce     = [];     // Candidats ICE mis en attente avant SDP
let sdpSet         = false;  // Vrai quand setRemoteDescription a réussi
let connectTimeout = null;   // Timeout de connexion WebRTC
let retryCount     = 0;
const MAX_RETRIES  = 3;

if (yearEl) yearEl.textContent = new Date().getFullYear();
audioPlayer.volume = 0.8;

// ─── Détection navigateur ─────────────────────────────────────────────────
const browserInfo = (() => {
  const ua = navigator.userAgent;
  if (ua.includes('OPR/') || ua.includes('Opera'))  return { name: 'Opera', isOpera: true };
  if (ua.includes('Firefox'))                        return { name: 'Firefox', isFirefox: true };
  if (ua.includes('Edg/'))                           return { name: 'Edge', isEdge: true };
  if (ua.includes('Safari') && !ua.includes('Chrome')) return { name: 'Safari', isSafari: true };
  return { name: 'Chrome', isChrome: true };
})();
console.log(`[Listener] Navigateur détecté : ${browserInfo.name}`);

// ─── Config ICE dynamique (avec TURN local) ───────────────────────────────
function getIceConfig(forceRelay = false) {
  const host = window.location.hostname;
  const config = {
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
    // Forcer le relais TURN si la connexion directe échoue
    iceTransportPolicy: forceRelay ? 'relay' : 'all',
    // Collecter tous les candidats plus agressivement
    iceCandidatePoolSize: 2,
    // Compatibilité : plan unifié (standard moderne)
    sdpSemantics: 'unified-plan'
  };
  return config;
}

// ─── UI Helpers ───────────────────────────────────────────────────────────
function setStatus(msg, type = '') {
  statusMsg.textContent = msg;
  statusMsg.className = 'status-msg' + (type ? ` ${type}` : '');
}

function setLive(online) {
  isBroadcasting = online;
  liveBadge.className = 'live-badge ' + (online ? 'online' : 'offline');
  liveLabel.textContent = online ? 'EN DIRECT' : 'HORS LIGNE';
  btnPlay.disabled = !online;
}

function setPlaying(playing) {
  isPlaying = playing;
  btnPlay.textContent = playing ? '⏸' : '▶';
  btnPlay.classList.toggle('playing', playing);
  artworkRing.classList.toggle('active', playing);
  equalizer.classList.toggle('active', playing);
  playerCard.classList.toggle('live', playing);

  if (playing) {
    trackTitle.textContent = '🔴 En direct';
    trackSub.textContent   = 'Diffusion en temps réel';
  } else {
    trackTitle.textContent = 'En attente du direct…';
    trackSub.textContent   = 'Cliquez sur Écouter pour rejoindre';
  }
}

function showToast(msg, duration = 3000) {
  toastEl.textContent = msg;
  toastEl.classList.add('visible');
  setTimeout(() => toastEl.classList.remove('visible'), duration);
}

// ─── Connexion Socket.io ───────────────────────────────────────────────────
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
    console.log('[Listener] Socket connecté:', socket.id);
    setStatus('Connecté au serveur.', 'success');
    socket.emit('register-listener');
  });

  socket.on('connect_error', (err) => {
    console.warn('[Listener] Erreur connexion socket:', err.message);
    setStatus('Erreur de connexion au serveur.', 'error');
    setLive(false);
  });

  socket.on('disconnect', (reason) => {
    console.warn('[Listener] Socket déconnecté:', reason);
    setStatus('Déconnecté du serveur.', 'error');
    setLive(false);
    setPlaying(false);
    cleanupPeer();
  });

  socket.on('broadcaster-available', () => {
    setLive(true);
    setStatus('Direct disponible ! Appuyez sur ▶ pour écouter.', 'success');
    showToast('🔴 Le direct est disponible !');
  });

  socket.on('no-broadcaster', () => {
    setLive(false);
    setStatus('Aucun diffuseur actif pour le moment.', '');
  });

  socket.on('broadcaster-disconnected', () => {
    setLive(false);
    setPlaying(false);
    setStatus("Le direct s'est terminé.", '');
    showToast("📴 La diffusion s'est arrêtée.");
    cleanupPeer();
  });

  // Answer du diffuseur
  socket.on('broadcaster-answer', async ({ answer }) => {
    if (!peerConn) return;
    try {
      console.log('[Listener] Answer reçue, type:', answer.type);
      // Compatibilité : utiliser un objet simple si le constructeur pose problème
      const desc = new RTCSessionDescription({ type: answer.type, sdp: answer.sdp });
      await peerConn.setRemoteDescription(desc);
      console.log('[Listener] remoteDescription OK, signalingState:', peerConn.signalingState);
      sdpSet = true;

      // Appliquer les ICE en attente
      for (const c of pendingIce) {
        try {
          await peerConn.addIceCandidate(new RTCIceCandidate(c));
          console.log('[Listener] ICE en attente appliqué');
        } catch(e) {
          console.warn('[Listener] Erreur ICE en attente:', e.message);
        }
      }
      pendingIce = [];
    } catch (e) {
      console.error('[Listener] Erreur SDP:', e);
      setStatus('Erreur WebRTC (SDP).', 'error');
    }
  });

  // ICE du diffuseur
  socket.on('broadcaster-ice', async ({ candidate }) => {
    if (!candidate) return;
    if (sdpSet && peerConn) {
      try {
        await peerConn.addIceCandidate(new RTCIceCandidate(candidate));
      } catch(e) {
        console.warn('[Listener] Erreur ajout ICE:', e.message);
      }
    } else {
      pendingIce.push(candidate); // Attente du SDP
    }
  });
}

// ─── WebRTC ───────────────────────────────────────────────────────────────
async function startListening(forceRelay = false) {
  cleanupPeer();
  setStatus('Préparation de la connexion…', 'loading');
  btnPlay.disabled = true;

  try {
    const iceConfig = getIceConfig(forceRelay);
    console.log('[Listener] ICE config:', JSON.stringify(iceConfig.iceServers.map(s => s.urls)));
    console.log('[Listener] Transport policy:', iceConfig.iceTransportPolicy);

    peerConn = new RTCPeerConnection(iceConfig);

    // Ajouter un transceiver audio en réception seule
    peerConn.addTransceiver('audio', { direction: 'recvonly' });

    // ── Réception audio ──────────────────────────────────────────────────
    peerConn.ontrack = (event) => {
      console.log('[Listener] ontrack déclenché, kind:', event.track.kind);
      if (event.track.kind !== 'audio') return;

      const stream = event.streams[0] || new MediaStream([event.track]);
      audioPlayer.srcObject = stream;

      // S'assurer que l'AudioContext est actif (politique autoplay)
      ensureAudioContext();

      audioPlayer.play()
        .then(() => {
          console.log('[Listener] Lecture audio démarrée');
          clearTimeout(connectTimeout);
          setPlaying(true);
          setStatus('Vous écoutez le direct.', 'success');
          btnPlay.disabled = false;
          retryCount = 0; // Reset retry on success
        })
        .catch(err => {
          console.warn('[Listener] Autoplay bloqué:', err.message);
          setStatus('▶ Cliquez pour forcer la lecture', 'error');
          btnPlay.disabled = false;
          // Tenter de relancer au prochain clic utilisateur
          document.addEventListener('click', resumePlay, { once: true });
        });
    };

    // ── ICE Candidates ───────────────────────────────────────────────────
    peerConn.onicecandidate = ({ candidate }) => {
      if (candidate) {
        console.log('[Listener] ICE candidate local:', candidate.type, candidate.protocol, candidate.address || '');
        socket.emit('listener-ice', { candidate });
      } else {
        console.log('[Listener] Fin de la collecte ICE');
      }
    };

    // ── Monitoring connexion ─────────────────────────────────────────────
    peerConn.onconnectionstatechange = () => {
      const state = peerConn ? peerConn.connectionState : 'null';
      console.log('[Listener] connectionState:', state);

      switch(state) {
        case 'connected':
          clearTimeout(connectTimeout);
          setStatus('Vous écoutez le direct.', 'success');
          retryCount = 0;
          break;
        case 'failed':
          handleConnectionFailure();
          break;
        case 'disconnected':
          // Attendre un peu avant de considérer comme perdu
          setTimeout(() => {
            if (peerConn && peerConn.connectionState === 'disconnected') {
              handleConnectionFailure();
            }
          }, 5000);
          break;
      }
    };

    peerConn.oniceconnectionstatechange = () => {
      const state = peerConn ? peerConn.iceConnectionState : 'null';
      console.log('[Listener] iceConnectionState:', state);

      if (state === 'failed') {
        // Tenter un ICE restart si possible
        if (peerConn && retryCount < MAX_RETRIES) {
          console.log('[Listener] Tentative ICE restart…');
          peerConn.restartIce();
        }
      }
    };

    peerConn.onicegatheringstatechange = () => {
      console.log('[Listener] iceGatheringState:', peerConn ? peerConn.iceGatheringState : 'null');
    };

    // ── Créer et envoyer l'offre ─────────────────────────────────────────
    socket.emit('request-stream');
    const offer = await peerConn.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: false
    });

    // S'assurer que l'offre utilise Opus (compatibilité maximale)
    console.log('[Listener] Offer SDP créée');
    await peerConn.setLocalDescription(offer);
    socket.emit('listener-offer', { offer: peerConn.localDescription });
    setStatus('Connexion en cours…', 'loading');

    // ── Timeout de connexion ─────────────────────────────────────────────
    connectTimeout = setTimeout(() => {
      if (peerConn && peerConn.connectionState !== 'connected') {
        console.warn('[Listener] Timeout connexion WebRTC');
        handleConnectionFailure();
      }
    }, 15000); // 15 secondes max

  } catch (e) {
    console.error('[Listener] Erreur:', e);
    setStatus('Erreur de démarrage WebRTC', 'error');
    btnPlay.disabled = false;
  }
}

function handleConnectionFailure() {
  clearTimeout(connectTimeout);
  retryCount++;

  if (retryCount <= MAX_RETRIES) {
    const useRelay = retryCount >= 2; // Forcer TURN après 2 échecs
    console.log(`[Listener] Retry ${retryCount}/${MAX_RETRIES}, forceRelay=${useRelay}`);
    setStatus(`Reconnexion… (tentative ${retryCount}/${MAX_RETRIES})`, 'loading');
    cleanupPeer();
    setTimeout(() => startListening(useRelay), 1000);
  } else {
    setStatus('Connexion impossible. Vérifiez votre réseau.', 'error');
    setPlaying(false);
    cleanupPeer();
    btnPlay.disabled = false;
    retryCount = 0;
  }
}

// Résoudre le problème d'autoplay sur certains navigateurs
function ensureAudioContext() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) {
      const ctx = new AudioCtx();
      if (ctx.state === 'suspended') {
        ctx.resume().then(() => ctx.close());
      } else {
        ctx.close();
      }
    }
  } catch(e) { /* ignore */ }
}

function resumePlay() {
  if (audioPlayer.srcObject) {
    ensureAudioContext();
    audioPlayer.play()
      .then(() => {
        setPlaying(true);
        setStatus('Vous écoutez le direct.', 'success');
      })
      .catch(() => {});
  }
}

function stopListening() {
  audioPlayer.pause();
  audioPlayer.srcObject = null;
  setPlaying(false);
  cleanupPeer();
  setStatus('Lecture en pause', '');
  retryCount = 0;
}

function cleanupPeer() {
  clearTimeout(connectTimeout);
  if (peerConn) {
    peerConn.ontrack = null;
    peerConn.onicecandidate = null;
    peerConn.onconnectionstatechange = null;
    peerConn.oniceconnectionstatechange = null;
    peerConn.onicegatheringstatechange = null;
    peerConn.close();
    peerConn = null;
  }
  pendingIce = [];
  sdpSet = false;
}

// ─── Contrôles ────────────────────────────────────────────────────────────
btnPlay.addEventListener('click', () => { isPlaying ? stopListening() : startListening(); });

volumeSlider.addEventListener('input', () => {
  const val = parseInt(volumeSlider.value, 10);
  audioPlayer.volume = val / 100;
  volumePct.textContent = val + '%';
  volumeSlider.style.setProperty('--vol', val + '%');
  if (val === 0)     volumeIcon.textContent = '🔇';
  else if (val < 40) volumeIcon.textContent = '🔈';
  else if (val < 70) volumeIcon.textContent = '🔉';
  else               volumeIcon.textContent = '🔊';
  if (val > 0) prevVolume = val;
});

volumeIcon.addEventListener('click', () => {
  if (audioPlayer.volume > 0) {
    prevVolume = parseInt(volumeSlider.value, 10);
    audioPlayer.volume = 0;
    volumeSlider.value = 0;
    volumeSlider.style.setProperty('--vol', '0%');
    volumePct.textContent = '0%';
    volumeIcon.textContent = '🔇';
  } else {
    const r = prevVolume || 80;
    audioPlayer.volume = r / 100;
    volumeSlider.value = r;
    volumeSlider.style.setProperty('--vol', r + '%');
    volumePct.textContent = r + '%';
    volumeIcon.textContent = '🔊';
  }
});
volumeIcon.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); volumeIcon.click(); } });

connectSocket();
