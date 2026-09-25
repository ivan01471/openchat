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
  lookingFor: $('lookingFor'), lang: $('lang'), country: $('country'),
  acceptRules: $('acceptRules'), startBtn: $('startBtn'),
  messages: $('messages'), composerForm: $('composerForm'),
  msgInput: $('msgInput'), sendBtn: $('sendBtn'),
  peerNick: $('peerNick'), peerMeta: $('peerMeta'), peerAvatar: $('peerAvatar'),
  reportBtn: $('reportBtn'), blockBtn: $('blockBtn'),
  nextBtn: $('nextBtn'), stopBtn: $('stopBtn'),
  typing: $('typing'), onlineCount: $('onlineCount'),
  rulesBtn: $('rulesBtn'), rulesBtn2: $('rulesBtn2'),
  rulesDialog: $('rulesDialog'), themeBtn: $('themeBtn'),
  userSearch: $('userSearch'),
  tabUsers: $('tabUsers'),
  tabHistory: $('tabHistory'),
  userCount: $('userCount'),
  historyCount: $('historyCount'),
  onlineUsersList: $('onlineUsersList'),
  sessionHistoryList: $('sessionHistoryList'),
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
  currentPeer: null,  // { id, nick, gender, age, country }
  onlineUsers: [],    // all active users received from server
  history: [],        // in-session ephemeral chat conversations
  activeTab: 'users', // 'users' | 'history'
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

  // Save to active session history
  if (state.currentPeer) {
    let conv = state.history.find(h => h.peerNick === state.currentPeer.nick);
    if (!conv) {
      conv = {
        peerNick: state.currentPeer.nick,
        peerCountry: state.currentPeer.country || 'Inconnu',
        peerGender: state.currentPeer.gender || 'any',
        peerAge: state.currentPeer.age || '?',
        lastMessage: text,
        messages: [],
      };
      state.history.unshift(conv);
    }
    conv.lastMessage = text;
    conv.messages.push({ from, text, mine, ts: Date.now() });
    renderHistoryList();
  }
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
// Chatiw sidebar: Online users by country & Session history
// ---------------------------------------------------------------------------
function renderOnlineUsers() {
  if (!dom.onlineUsersList) return;
  const list = dom.onlineUsersList;
  while (list.firstChild) list.removeChild(list.firstChild);

  const query = (dom.userSearch ? dom.userSearch.value : '').trim().toLowerCase();
  const filtered = state.onlineUsers.filter(u => {
    if (state.profile && u.nick === state.profile.nick) return false;
    if (!query) return true;
    return (u.nick && u.nick.toLowerCase().includes(query)) ||
           (u.country && u.country.toLowerCase().includes(query));
  });

  if (dom.userCount) dom.userCount.textContent = filtered.length;

  if (filtered.length === 0) {
    const empty = el('div', 'list-empty');
    empty.textContent = query ? 'Aucun utilisateur ne correspond à ce filtre.' : 'Aucun autre utilisateur en ligne pour l\'instant.';
    list.appendChild(empty);
    return;
  }

  // Group by country
  const groups = {};
  for (const u of filtered) {
    const c = u.country || 'Autre';
    if (!groups[c]) groups[c] = [];
    groups[c].push(u);
  }

  for (const [country, uList] of Object.entries(groups)) {
    const groupDiv = el('div', 'country-group');
    const title = el('div', 'country-title');
    const nameSpan = el('span');
    nameSpan.textContent = country;
    const badge = el('span', 'country-badge');
    badge.textContent = `${uList.length}`;
    title.appendChild(nameSpan);
    title.appendChild(badge);
    groupDiv.appendChild(title);

    for (const u of uList) {
      const card = el('div', 'user-card' + (state.currentPeer && state.currentPeer.nick === u.nick ? ' active-chat' : ''));
      card.addEventListener('click', () => {
        if (state.currentPeer && state.currentPeer.nick === u.nick) return;
        send({ type: 'start_private', targetId: u.id });
        addSystem(`Connexion directe demandée avec ${u.nick}…`);
      });

      const info = el('div', 'user-card-info');
      const top = el('div', 'user-card-top');
      const name = el('span', 'user-name');
      name.textContent = u.nick;
      const gBadge = el('span', 'user-badge-gender');
      gBadge.textContent = u.gender === 'female' ? '♀' : u.gender === 'male' ? '♂' : '⚪';
      top.appendChild(name);
      top.appendChild(gBadge);

      const sub = el('span', 'user-meta-sub');
      sub.textContent = `${u.age ? u.age + ' ans' : ''} · ${u.busy ? 'en chat' : 'disponible'}`;
      info.appendChild(top);
      info.appendChild(sub);

      const dot = el('span', 'user-status-dot' + (u.busy ? ' busy' : ''));
      dot.title = u.busy ? 'En discussion' : 'En ligne';

      card.appendChild(info);
      card.appendChild(dot);
      groupDiv.appendChild(card);
    }
    list.appendChild(groupDiv);
  }
}
function renderHistoryList() {
  if (!dom.sessionHistoryList) return;
  const list = dom.sessionHistoryList;
  while (list.firstChild) list.removeChild(list.firstChild);

  if (dom.historyCount) dom.historyCount.textContent = state.history.length;

  if (state.history.length === 0) {
    const empty = el('div', 'list-empty');
    empty.textContent = 'Aucun historique dans cette session. L\'historique s\'efface complètement quand vous quittez.';
    list.appendChild(empty);
    return;
  }

  for (const conv of state.history) {
    const card = el('div', 'history-card');
    card.addEventListener('click', () => {
      clearMessages();
      setPeer(conv.peerNick, `${conv.peerAge} ans · ${conv.peerCountry}`);
      addSystem(`Historique de discussion avec ${conv.peerNick} (session en cours) :`);
      for (const m of conv.messages) {
        addMessage(m.from, m.text, m.mine);
      }
    });

    const info = el('div', 'user-card-info');
    const top = el('div', 'user-card-top');
    const name = el('span', 'user-name');
    name.textContent = conv.peerNick;
    const meta = el('span', 'user-meta-sub');
    meta.textContent = ` (${conv.peerCountry})`;
    top.appendChild(name);
    top.appendChild(meta);

    const lastMsg = el('span', 'history-card-msg');
    lastMsg.textContent = conv.lastMessage || '';
    info.appendChild(top);
    info.appendChild(lastMsg);

    card.appendChild(info);
    list.appendChild(card);
  }
}

if (dom.userSearch) dom.userSearch.addEventListener('input', renderOnlineUsers);

if (dom.tabUsers) {
  dom.tabUsers.addEventListener('click', () => {
    state.activeTab = 'users';
    dom.tabUsers.classList.add('active');
    dom.tabHistory.classList.remove('active');
    dom.onlineUsersList.hidden = false;
    dom.sessionHistoryList.hidden = true;
  });
}

if (dom.tabHistory) {
  dom.tabHistory.addEventListener('click', () => {
    state.activeTab = 'history';
    dom.tabHistory.classList.add('active');
    dom.tabUsers.classList.remove('active');
    dom.onlineUsersList.hidden = true;
    dom.sessionHistoryList.hidden = false;
    renderHistoryList();
  });
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
  if (state.ws) {
    if (state.ws.readyState === WebSocket.OPEN ||
        state.ws.readyState === WebSocket.CONNECTING) return;
    // Discard any stale dead/closing socket before creating a new one,
    // otherwise the guard above can block a manual restart forever.
    state.ws = null;
  }

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
    if (state.retryTimer) { clearTimeout(state.retryTimer); state.retryTimer = null; }
    if (state.profile && state.wantChat) {
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

  if (p === 'idle') {
    state.currentPeer = null;
    state.history = []; // ephemeral history lost on disconnect
    renderHistoryList();
    dom.startBtn.disabled = false;
    dom.startBtn.textContent = 'Démarrer la recherche';
  } else if (p === 'searching') {
    state.currentPeer = null;
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

    case 'user_list':
      state.onlineUsers = Array.isArray(msg.users) ? msg.users : [];
      renderOnlineUsers();
      return;

    case 'joined':
      state.joined = true;
      showSetupError('');
      return;

    case 'waiting':
      setPhase('searching');
      clearMessages();
      addSystem('Recherche d\'un interlocuteur ou clique sur un utilisateur à gauche pour lui parler directement…');
      if (dom.startBtn) { dom.startBtn.disabled = false; dom.startBtn.textContent = 'Démarrer la recherche'; }
      return;

    case 'matched': {
      setPhase('chatting');
      state.everPaired = true;
      clearMessages();
      const p = msg.peer || {};
      state.currentPeer = p;
      const meta = [p.gender && p.gender !== 'any' ? p.gender : null,
                    p.age ? `${p.age} ans` : null,
                    p.country && p.country !== 'any' ? p.country : null]
        .filter(Boolean).join(' · ') || 'anonyme';
      setPeer(p.nick || 'Inconnu', meta);
      addSystem(`Connecté à ${p.nick} (${p.country || 'Inconnu'}). Sois respectueux.`, 'ok');
      renderOnlineUsers();
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
      state.currentPeer = null;
      setPhase('searching');
      setPeer('Recherche…', 'interlocuteur parti');
      addSystem('Ton interlocuteur a quitté la discussion.', 'warn');
      renderOnlineUsers();
      return;

    case 'idle':
      setPhase('idle');
      state.wantChat = false;
      renderOnlineUsers();
      return;

    case 'queue_timeout':
      state.wantChat = false;
      setPhase('idle');
      showSetupError('Personne n\'est disponible pour le moment. Réessaie dans un instant ou choisis un utilisateur connecté.');
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
        addSystem(msg.message, 'warn');
        return;
      }
      state.wantChat = false;
      setPhase('idle');
      showSetupError(msg.message);
      return;

    case 'pong':
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
    country: dom.country ? dom.country.value : 'France',
  };
  try {
    localStorage.setItem('oc-nick', nick);
    localStorage.setItem('oc-age', String(age));
    if (dom.country) localStorage.setItem('oc-country', dom.country.value);
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
  if (!send({ type: 'next' })) {
    addSystem('Connexion indisponible, reconnexion…', 'warn');
    state.wantChat = state.wantChat || (state.phase !== 'idle');
    connect();
    return;
  }
  setPhase('searching');
  clearMessages();
  addSystem('Recherche d\'un nouvel interlocuteur…');
});

dom.stopBtn.addEventListener('click', () => {
  typingSent = false;
  state.wantChat = false;
  try { send({ type: 'leave' }); } catch { /* ignore */ }
  setPhase('idle');
  clearMessages();
  addSystem('Tu as quitté la discussion. L\'historique de session est effacé (comme Chatiw). Clique sur « Démarrer la recherche » pour te reconnecter.');
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
    const c = localStorage.getItem('oc-country');
    if (n) dom.nick.value = n;
    if (a) dom.age.value = a;
    if (c && dom.country) dom.country.value = c;
  } catch { /* ignore */ }
})();

// Keep a lightweight connection alive so stats + instant start work.
connect();

// Refresh stats and user list periodically
setInterval(() => {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    send({ type: 'ping' });
    send({ type: 'get_users' });
  }
}, 20000);


