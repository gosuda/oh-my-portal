'use strict';

// ── DOM refs ───────────────────────────────────────────────────────────
const chat = document.getElementById('chat');
const input = document.getElementById('input');
const sendBtn = document.getElementById('sendBtn');
const stopBtn = document.getElementById('stopBtn');
const dot = document.getElementById('dot');

// ── State ─────────────────────────────────────────────────────────────
let ws = null;
let streaming = false;
let agentEl = null, textEl = null, thinkEl = null;
let reconnectTimer = null;
let nick = localStorage.getItem('chat-nick') || 'anon-' + Math.random().toString(36).slice(2, 6);
document.getElementById('nickInput').value = nick;

function saveNick(v) {
  nick = (v || '').trim().slice(0, 20) || nick;
  localStorage.setItem('chat-nick', nick);
}

// ── Password gate ─────────────────────────────────────────────────────
function unlock() {
  const el = document.getElementById('gateInput');
  if (el.value === '1234') {
    document.getElementById('gate').style.display = 'none';
    localStorage.setItem('chat-pass', '1');
    input.focus();
  } else {
    el.value = '';
    el.placeholder = 'wrong';
  }
}
if (localStorage.getItem('chat-pass') === '1') {
  document.getElementById('gate').style.display = 'none';
}

// ── Rendering ─────────────────────────────────────────────────────────
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function scrollBottom() { chat.scrollTop = chat.scrollHeight; }

function userMsg(text, who) {
  agentEl = null; textEl = null; thinkEl = null;
  const el = document.createElement('div');
  if (who === nick) {
    el.className = 'msg mine';
    el.textContent = text;
  } else {
    el.className = 'msg theirs';
    el.innerHTML = `<span class="nick">${esc(who)}</span>${esc(text)}`;
  }
  chat.appendChild(el);
  scrollBottom();
}

function agentBubble() {
  if (!agentEl) {
    agentEl = document.createElement('div');
    agentEl.className = 'msg agent';
    textEl = document.createElement('div');
    agentEl.appendChild(textEl);
    chat.appendChild(agentEl);
  }
  scrollBottom();
}

function renderText(d) {
  agentBubble();
  textEl.textContent += d;
  scrollBottom();
}

function renderThinking(d) {
  agentBubble();
  if (!thinkEl) {
    thinkEl = document.createElement('div');
    thinkEl.className = 'thinking';
    agentEl.insertBefore(thinkEl, textEl);
  }
  thinkEl.textContent += d;
}

function renderToolCard(name) {
  agentEl = null; textEl = null; thinkEl = null;
  const c = document.createElement('div');
  c.className = 'tool';
  c.dataset.name = name;
  c.innerHTML = `<div class="hd"><span class="icon">⚙</span><span class="name">${esc(name)}</span><span class="st">…</span></div><div class="bd"><pre></pre></div>`;
  c.querySelector('.hd').onclick = () => c.classList.toggle('open');
  chat.appendChild(c);
  scrollBottom();
}

function renderNotice(t) {
  const el = document.createElement('div');
  el.className = 'notice';
  el.textContent = t;
  chat.appendChild(el);
  scrollBottom();
}

function setStream(on) {
  streaming = on;
  sendBtn.style.display = on ? 'none' : '';
  stopBtn.style.display = on ? '' : 'none';
  if (!on) { agentEl = null; textEl = null; thinkEl = null; }
}

// ── Event dispatch ────────────────────────────────────────────────────
function handleEvent(msg) {
  switch (msg.type) {
    case 'text_delta':
      renderText(msg.content || '');
      break;
    case 'thinking_delta':
      renderThinking(msg.content || '');
      break;
    case 'tool_start': {
      const cards = chat.querySelectorAll('.tool');
      const last = cards[cards.length - 1];
      if (!last || last.dataset.name !== msg.name) {
        renderToolCard(msg.name || 'tool');
      }
      break;
    }
    case 'tool_end': {
      const cards = chat.querySelectorAll('.tool');
      const last = cards[cards.length - 1];
      if (last) {
        last.querySelector('.st').textContent = 'done';
        if (msg.result) last.querySelector('.bd pre').textContent = msg.result;
      }
      break;
    }
    case 'user_message':
      if (msg.from !== nick) {
        userMsg(msg.content || '', msg.from || 'someone');
      }
      break;
    case 'prompt_accepted':
    case 'agent_start':
      setStream(true);
      break;
    case 'prompt_error':
      renderNotice(msg.error || 'error');
      setStream(false);
      break;
    case 'agent_end':
    case 'command_result':
      setStream(false);
      break;
    case 'command_output':
      renderNotice(msg.content || msg.output || '');
      break;
    case 'agent_exited':
      renderNotice('agent exited');
      setStream(false);
      break;
    case 'state_update': {
      const s = document.getElementById('status');
      const m = document.getElementById('model');
      const c = document.getElementById('ctx');
      s.style.display = 'block';
      if (msg.model && m) m.textContent = msg.model.provider + '/' + msg.model.id;
      if (msg.contextUsage && c) {
        const u = msg.contextUsage;
        c.textContent = (u.tokens / 1000).toFixed(0) + 'k/' + (u.contextWindow / 1000).toFixed(0) + 'k (' + u.percent.toFixed(1) + '%)';
      }
      break;
    }
    case 'notice':
      renderNotice(msg.content);
      break;
  }
}

// ── WebSocket ─────────────────────────────────────────────────────────
function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host);

  ws.onopen = () => {
    dot.classList.add('on');
    input.disabled = false;
    sendBtn.disabled = false;
    clearTimeout(reconnectTimer);
  };

  ws.onclose = () => {
    dot.classList.remove('on');
    input.disabled = true;
    sendBtn.disabled = true;
    reconnectTimer = setTimeout(connect, 2000);
  };

  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handleEvent(msg);
  };
}

// ── Actions ───────────────────────────────────────────────────────────
function send() {
  const t = input.value.trim();
  if (!t || !ws || ws.readyState !== 1) return;
  input.value = '';
  input.style.height = 'auto';
  userMsg(t, nick);
  ws.send(JSON.stringify({ type: 'prompt', message: t, nickname: nick }));
}

function stop() {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'abort' }));
    setStream(false);
  }
}

// ── Command autocomplete ──────────────────────────────────────────────

const COMMANDS = [
  { cmd: '/model',    desc: 'Show or switch the current model' },
  { cmd: '/compact',  desc: 'Compress the conversation context' },
  { cmd: '/thinking', desc: 'Set thinking level (off/low/medium/high/max)' },
  { cmd: '/help',     desc: 'Show available commands' },
  { cmd: '/dump',     desc: 'Dump the full conversation' },
  { cmd: '/export',   desc: 'Export the conversation' },
  { cmd: '/exit',     desc: 'Leave the session' },
];

const cmdList = document.getElementById('cmdList');
let cmdActiveIndex = -1;

function showCmds(text) {
  if (!text.startsWith('/') || text.includes(' ')) {
    cmdList.classList.remove('visible');
    cmdList.innerHTML = '';
    cmdActiveIndex = -1;
    return;
  }

  const q = text.slice(1).toLowerCase();
  const matches = COMMANDS.filter(c => c.cmd.slice(1).toLowerCase().startsWith(q));
  if (matches.length === 0) {
    cmdList.classList.remove('visible');
    cmdList.innerHTML = '';
    return;
  }

  cmdList.innerHTML = '';
  for (const m of matches) {
    const el = document.createElement('div');
    el.className = 'cmd-item';
    el.innerHTML = `<span class="cmd">${esc(m.cmd)}</span><span class="desc">${esc(m.desc)}</span>`;
    el.onclick = () => {
      input.value = m.cmd + ' ';
      input.focus();
      hideCmds();
    };
    cmdList.appendChild(el);
  }
  cmdList.classList.add('visible');
}

function hideCmds() {
  cmdList.classList.remove('visible');
  cmdActiveIndex = -1;
}

function cmdNav(dir) {
  const items = cmdList.querySelectorAll('.cmd-item');
  if (!items.length) return;
  cmdActiveIndex = Math.max(0, Math.min(items.length - 1, cmdActiveIndex + dir));
  items.forEach((el, i) => el.classList.toggle('active', i === cmdActiveIndex));
  items[cmdActiveIndex]?.scrollIntoView({ block: 'nearest' });
}

function cmdAccept() {
  const items = cmdList.querySelectorAll('.cmd-item');
  const target = items[cmdActiveIndex] || items[0];
  if (target) target.click();
}

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (cmdList.classList.contains('visible')) {
      cmdAccept();
    } else {
      send();
    }
  } else if (e.key === 'ArrowUp' && cmdList.classList.contains('visible')) {
    e.preventDefault();
    cmdNav(-1);
  } else if (e.key === 'ArrowDown' && cmdList.classList.contains('visible')) {
    e.preventDefault();
    cmdNav(1);
  } else if (e.key === 'Escape') {
    hideCmds();
  } else if (e.key === 'Tab' && cmdList.classList.contains('visible')) {
    e.preventDefault();
    cmdAccept();
  }
});

input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  showCmds(input.value);
});

connect();
