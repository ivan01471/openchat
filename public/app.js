/* OpenChat client — no framework, no build step.
 *
 * SECURITY RULE: user-provided data is ONLY ever written through textContent /
 * createElement. innerHTML is never used with dynamic data (XSS).
 */
'use strict';

const $ = (id) => document.getElementById(id);

const dom = {
  setupPanel: $('setupPanel'), chatPanel: $('chatPanel'),
  setupForm: $('setupForm'), setupError: $('setupError'),
  nick: $('nick'), age: $('age'), gender: $('gender'),
  lookingFor: $('lookingFor'), lang: $('lang'),
  acceptRules: $('acceptRules'), startBtn: $('startBtn'),
  messages: $('messages'), composerForm: $('composerForm'),
  msgInput: $('msgInput'), sendBtn: $('sendBtn'),
  peerNick: $('peerNick'), peerMeta: $('peerMeta'), peerAvatar: $('peerAvatar'),
  reportBtn: $('reportBtn'), blockBtn: $('blockBtn'),
  nextBtn: $('nextBtn'), stopBtn: $('stopBtn'),
  typing: $('typing'), onlineCount: $('onlineCount'),
  rulesBtn: $('rulesBtn'), rulesBtn2: $('rulesBtn2'),
  rulesDialog: $('rulesDialog'), themeBtn: $('themeBtn'),
};

const state = {
  ws: null,
  phase: 'idle',      // idle | searching | chatting | reconnecting
  joined: false,
  profile: null,
  everPaired: false,
  retry: 0,
  retryTimer: null,
  wantChat: false,    // user intends to be searching/chatting
  lastSent: 0,
};

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('oc-theme', t); } catch { /* private mode */ }
}
(function initTheme() {
  let stored = null;
  try { stored = localStorage.getItem('oc-theme'); } catch { /* ignore */ }
  const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  applyTheme(stored || (prefersLight ? 'light' : 'dark'));
})();
dom.themeBtn.addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
});

// ---------------------------------------------------------------------------
// Rules dialog
// ---------------------------------------------------------------------------
const openRules = () => {
  if (typeof dom.rulesDialog.showModal === 'function') dom.rulesDialog.showModal();
  else dom.rulesDialog.setAttribute('open', '');
};
dom.rulesBtn.addEventListener('click', openRules);
dom.rulesBtn2.addEventListener('click', (e) => { e.preventDefault(); openRules(); });

// ---------------------------------------------------------------------------
// Safe DOM helpers
// ---------------------------------------------------------------------------
function el(tag, className) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  return n;
}

function addSystem(text, kind) {
  const n = el('div', 'sys' + (kind ? ' ' + kind : ''));
  n.textContent = text;              // textContent => no HTML injection
  dom.messages.appendChild(n);
  scrollDown();
  return n;
}

function addMessage(from, text, mine) {
  const wrap = el('div', 'msg' + (mine ? ' me' : ''));
  const bubble = el('div', 'bubble');
  if (!mine) {
    const who = el('span', 'who');
    who.textContent = from;
    bubble.appendChild(who);
  }
  bubble.appendChild(document.createTextNode(text)); // explicit text node
  wrap.appendChild(bubble);
  dom.messages.appendChild(wrap);
  scrollDown();
}

function clearMessages() {
  while (dom.messages.firstChild) dom.messages.removeChild(dom.messages.firstChild);
}

function scrollDown() {
  dom.messages.scrollTop = dom.messages.scrollHeight;
}

function setTyping(on) {
  dom.typing.hidden = !on;
  if (on) scrollDown();
}

function setPeer(nick, meta) {
  dom.peerNick.textContent = nick;
  dom.peerMeta.textContent = meta;
  dom.peerAvatar.textContent = (nick || '?').charAt(0).toUpperCase();
}

function showSetupError(msg) {
  dom.setupError.hidden = !msg;
  dom.setupError.textContent = msg || '';
}
// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------
function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}`;
}

function send(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

function connect() {
  if (state.ws && (state.ws.readyState === WebSocket.OPEN ||
                   state.ws.readyState === WebSocket.CONNECTING)) return;

  let ws;
  try {
    ws = new WebSocket(wsUrl());
  } catch {
    scheduleReconnect();
    return;
  }
  state.ws = ws;

  ws.addEventListener('open', () => {
    state.retry = 0;
    if (state.profile && state.wantChat) {
      // transparently resume after a dropped connection
      send({ type: 'join', ...state.profile });
      setPhase('searching');
    }
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleServer(msg);
  });

  ws.addEventListener('close', () => {
    if (state.ws !== ws) return;
    state.ws = null;
    setTyping(false);
    if (state.wantChat) {
      setPhase('reconnecting');
      scheduleReconnect();
    }
  });

  ws.addEventListener('error', () => {
    try { ws.close(); } catch { /* ignore */ }
  });
}

function scheduleReconnect() {
  if (state.retryTimer) return;
  state.retry = Math.min(state.retry + 1, 6);
  const delay = Math.min(1000 * 2 ** state.retry, 20000);
  addSystem('Connexion perdue, nouvelle tentative…', 'warn');
  state.retryTimer = setTimeout(() => {
    state.retryTimer = null;
    connect();
  }, delay);
}

function setPhase(p) {
  state.phase = p;
  const chatting = p === 'chatting';
  dom.setupPanel.hidden = p !== 'idle';
  dom.chatPanel.hidden = p === 'idle';

  dom.msgInput.disabled = !chatting;
  dom.sendBtn.disabled = !chatting;
  dom.reportBtn.disabled = !chatting;
  dom.blockBtn.disabled = !chatting;
  if (!chatting) setTyping(false);

  if (p === 'searching') {
    setPeer('Recherche…', 'recherche d\'un interlocuteur');
    dom.messages.dataset.state = 'searching';
  } else if (p === 'reconnecting') {
    setPeer('Reconnexion…', 'connexion interrompue');
  }
  if (chatting) dom.msgInput.focus();
}

// ---------------------------------------------------------------------------
// Server events
// ---------------------------------------------------------------------------
function handleServer(msg) {
  switch (msg.type) {
    case 'hello':
      return;

    case 'stats':
      dom.onlineCount.textContent = `${msg.connected} en ligne`;
      return;

    case 'joined':
      state.joined = true;
      showSetupError('');
      return;

    case 'waiting':
      setPhase('searching');
      clearMessages();
      addSystem('Recherche d\'un interlocuteur…');
      return;

    case 'matched': {
      setPhase('chatting');
      state.everPaired = true;
      clearMessages();
      const p = msg.peer || {};
      const meta = [p.gender && p.gender !== 'any' ? p.gender : null,
                    p.age ? `${p.age} ans` : null,
                    p.country && p.country !== 'any' ? p.country : null]
        .filter(Boolean).join(' · ') || 'anonyme';
      setPeer(p.nick || 'Inconnu', meta);
      addSystem(`Connecté à ${p.nick}. Sois respectueux.`, 'ok');
      return;
    }

    case 'message':
      addMessage(msg.from || 'Inconnu', msg.text, false);
      setTyping(false);
      return;

    case 'typing':
      setTyping(msg.on === true);
      return;

    case 'left':
      setPhase('searching');
      setPeer('Recherche…', 'interlocuteur parti');
      addSystem('Ton interlocuteur a quitté la discussion.', 'warn');
      return;

    case 'idle':
      setPhase('idle');
      state.wantChat = false;
      return;

    case 'queue_timeout':
      // No partner found in time: send the user back to the setup panel with
      // an explanation instead of leaving them stuck on a dead chat screen.
      state.wantChat = false;
      setPhase('idle');
      showSetupError('Personne n\'est disponible pour le moment. Réessaie dans un instant.');
      dom.startBtn.disabled = false;
      dom.startBtn.textContent = 'Démarrer la recherche';
      return;

    case 'reported':
      addSystem('Signalement transmis. Merci. Tu recherches un nouvel interlocuteur.', 'ok');
      return;

    case 'banned':
      setPhase('idle');
      state.wantChat = false;
      showSetupError('Tu as été exclu suite à un signalement. Réessaie dans 10 minutes.');
      return;

    case 'error':
      if (state.phase === 'chatting') {
        // In a conversation a soft error (e.g. message flood) must not eject
        // the user back to the setup panel: report it inline instead.
        addSystem(msg.message, 'warn');
        return;
      }
      state.wantChat = false;
      setPhase('idle');
      showSetupError(msg.message);
      dom.startBtn.disabled = false;
      dom.startBtn.textContent = 'Démarrer la recherche';
      return;

    default:
      return;
  }
}
// ---------------------------------------------------------------------------
// UI events
// ---------------------------------------------------------------------------
dom.setupForm.addEventListener('submit', (e) => {
  e.preventDefault();
  showSetupError('');

  const nick = dom.nick.value.trim();
  const age = parseInt(dom.age.value, 10);

  if (nick.length < 2) return showSetupError('Pseudo : 2 caractères minimum.');
  if (!Number.isInteger(age) || age < 16 || age > 99) {
    return showSetupError('Âge requis : 16 ans minimum.');
  }
  if (!dom.acceptRules.checked) {
    return showSetupError('Tu dois accepter les règles de la communauté.');
  }

  state.profile = {
    nick, age,
    gender: dom.gender.value,
    lookingFor: dom.lookingFor.value,
    lang: dom.lang.value,
  };
  try {
    localStorage.setItem('oc-nick', nick);
    localStorage.setItem('oc-age', String(age));
  } catch { /* private mode */ }

  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    state.wantChat = true;
    dom.startBtn.disabled = true;
    dom.startBtn.textContent = 'Connexion…';
    connect();
    return;
  }

  state.wantChat = true;
  dom.startBtn.disabled = true;
  dom.startBtn.textContent = 'Recherche…';
  if (!send({ type: 'join', ...state.profile })) {
    dom.startBtn.disabled = false;
    dom.startBtn.textContent = 'Démarrer la recherche';
    return showSetupError('Connexion indisponible. Réessaie.');
  }
});

dom.composerForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = dom.msgInput.value.trim();
  if (!text) return;
  if (state.phase !== 'chatting') return;
  // client-side backstop (server enforces the real limit)
  const now = Date.now();
  if (now - state.lastSent < 250) return;
  state.lastSent = now;
  if (send({ type: 'message', text })) {
    addMessage(state.profile ? state.profile.nick : 'Moi', text, true);
    dom.msgInput.value = '';
  }
});

let typingSent = false;
dom.msgInput.addEventListener('input', () => {
  if (state.phase !== 'chatting') return;
  if (!typingSent && dom.msgInput.value.length > 0) {
    typingSent = true;
    send({ type: 'typing', on: true });
  }
  if (dom.msgInput.value.length === 0 && typingSent) {
    typingSent = false;
    send({ type: 'typing', on: false });
  }
});

dom.nextBtn.addEventListener('click', () => {
  if (state.phase === 'idle') return;
  typingSent = false;
  setTyping(false);
  send({ type: 'next' });
  setPhase('searching');
  clearMessages();
  addSystem('Recherche d\'un nouvel interlocuteur…');
});

dom.stopBtn.addEventListener('click', () => {
  typingSent = false;
  state.wantChat = false;
  send({ type: 'leave' });
  setPhase('idle');
  clearMessages();
});

dom.reportBtn.addEventListener('click', () => {
  if (state.phase !== 'chatting') return;
  if (!window.confirm('Signaler cet interlocuteur ? Il sera immédiatement banni et tu seras mis en relation avec quelqu\'un d\'autre.')) return;
  typingSent = false;
  send({ type: 'report' });
  setPhase('searching');
  clearMessages();
  addSystem('Signalement transmis. Recherche d\'un nouvel interlocuteur…', 'ok');
});

dom.blockBtn.addEventListener('click', () => {
  if (state.phase !== 'chatting') return;
  if (!window.confirm('Bloquer cet interlocuteur et changer ?')) return;
  typingSent = false;
  send({ type: 'block' });
  setPhase('searching');
  clearMessages();
  addSystem('Interlocuteur bloqué. Recherche d\'un nouveau…', 'ok');
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
(function restore() {
  try {
    const n = localStorage.getItem('oc-nick');
    const a = localStorage.getItem('oc-age');
    if (n) dom.nick.value = n;
    if (a) dom.age.value = a;
  } catch { /* ignore */ }
})();

// Keep a lightweight connection alive so stats + instant start work.
connect();

// Refresh the online counter periodically.
setInterval(() => { if (state.ws && state.ws.readyState === WebSocket.OPEN) send({ type: 'ping' }); }, 25000);


