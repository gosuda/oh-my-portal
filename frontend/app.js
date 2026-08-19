'use strict';

// ── DOM refs ───────────────────────────────────────────────────────────
const chat = document.getElementById('chat');
const input = document.getElementById('input');
const sendBtn = document.getElementById('sendBtn');
const stopBtn = document.getElementById('stopBtn');
const dot = document.getElementById('dot');
const sidebar = document.getElementById('sidebar');
const sidebarOverlay = document.getElementById('sidebar-overlay');
const sessionListEl = document.getElementById('sessionList');
const chatTitle = document.getElementById('chatTitle');
const hubBtn = document.getElementById('hubBtn');
const hubCount = document.getElementById('hubCount');
const hubEl = document.getElementById('hub');
const hubOverlay = document.getElementById('hub-overlay');
const hubList = document.getElementById('hubList');

// ── State ─────────────────────────────────────────────────────────────
let ws = null;
let streaming = false;
let agentEl = null, textEl = null, thinkEl = null;
let reconnectTimer = null;
let activeSessionId = null;
let nick = localStorage.getItem('chat-nick') || 'anon-' + Math.random().toString(36).slice(2, 6);
document.getElementById('nickInput').value = nick;

function saveNick(v) {
  nick = (v || '').trim().slice(0, 20) || nick;
  localStorage.setItem('chat-nick', nick);
}

let promptWatchdog = null;
let lastState = null;
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

// ── Sidebar ────────────────────────────────────────────────────────────
function toggleSidebar() {
  sidebar.classList.toggle('open');
  sidebarOverlay.classList.toggle('open');
}

// ── Agent Hub (subagent panel) ────────────────────────────────────────
let hubAgents = [];

function toggleHub() {
  hubEl.classList.toggle('open');
  hubOverlay.classList.toggle('open');
}

function renderHub() {
  const running = hubAgents.filter(a => a.status === 'running' || a.status === 'pending').length;
  hubBtn.style.display = hubAgents.length ? '' : 'none';
  hubCount.textContent = hubAgents.length;
  hubBtn.classList.toggle('active', running > 0);

  if (!hubAgents.length) {
    hubList.innerHTML = '<div class="hub-empty">no subagents</div>';
    return;
  }

  hubList.innerHTML = '';
  for (const a of hubAgents) {
    const card = document.createElement('div');
    card.className = 'hub-card st-' + (a.status || 'unknown');
    const dur = a.durationMs ? Math.round(a.durationMs / 1000) + 's' : '';
    const cost = a.cost ? '$' + a.cost.toFixed(4) : '';
    const meta = [
      a.toolCount ? a.toolCount + ' tools' : '',
      a.tokens ? (a.tokens > 1000 ? (a.tokens / 1000).toFixed(1) + 'k' : a.tokens) + ' tok' : '',
      dur, cost,
    ].filter(Boolean).join(' · ');

    card.innerHTML = `
      <div class="hc-top">
        <span class="hc-name">${esc(a.id)}</span>
        <span class="hc-status">${esc(a.status)}</span>
      </div>
      <div class="hc-meta">
        <span class="hc-agent">${esc(a.agent)}${a.modelRole ? ' · ' + esc(a.modelRole) : ''}</span>
        <span class="hc-stats">${meta}</span>
      </div>
      ${a.recentOutput && a.recentOutput.length ? `<div class="hc-out">${esc(a.recentOutput[a.recentOutput.length - 1]).slice(0, 200)}</div>` : ''}
    `;
    hubList.appendChild(card);
  }
}

function newSession() {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'new_session' }));
  }
  toggleSidebar();
}

function switchSession(id) {
  if (ws && ws.readyState === 1 && id !== activeSessionId) {
    ws.send(JSON.stringify({ type: 'switch_session', sessionId: id }));
  }
  toggleSidebar();
}

function deleteSession(id, e) {
  e.stopPropagation();
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'delete_session', sessionId: id }));
  }
}

function renderSessionList(sessions) {
  sessionListEl.innerHTML = '';
  for (const s of sessions) {
    const el = document.createElement('div');
    el.className = 'sb-item' + (s.id === activeSessionId ? ' active' : '');
    el.innerHTML = `
      <span class="sb-title">${esc(s.title)}</span>
      <span class="sb-count">${s.messageCount || ''}</span>
      <button class="sb-del" onclick="deleteSession('${s.id}',event)">×</button>`;
    el.onclick = () => switchSession(s.id);
    sessionListEl.appendChild(el);
  }
}

function clearChat() {
  chat.innerHTML = '';
  agentEl = null; textEl = null; thinkEl = null;
}

function loadHistory(messages) {
  chat.innerHTML = '';
  agentEl = null; textEl = null; thinkEl = null;
  for (const m of messages) {
    if (m.role === 'user') {
      userMsg(m.content, m.from || nick);
    } else if (m.role === 'assistant' && m.content) {
      agentEl = null; thinkEl = null;
      renderText(m.content);
      agentEl = null;
    }
  }
  chat.scrollTop = chat.scrollHeight;
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

let pendingMd = '';
function renderText(d) {
  agentBubble();
  pendingMd += d;
  // Render markdown on each delta (cheap for small texts)
  textEl.innerHTML = md(pendingMd);
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

function renderToolCard(name, params) {
  agentEl = null; textEl = null; thinkEl = null; pendingMd = '';
  const c = document.createElement('div');
  c.className = 'tool';
  c.dataset.name = name;
  const paramsStr = params ? JSON.stringify(params, null, 2) : '';
  c.innerHTML = `
    <div class="hd"><span class="icon">⚙</span><span class="name">${esc(name)}</span><span class="st">running…</span></div>
    <div class="bd">
      ${paramsStr ? `<div class="tool-params"><span class="lbl">params</span><pre>${esc(paramsStr)}</pre></div>` : ''}
      <div class="tool-result"><span class="lbl">result</span><pre>waiting…</pre></div>
    </div>`;
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

function renderCmdOutput(text) {
  if (!text || !text.trim()) return;
  // Render slash command output as a system-style message with markdown
  agentEl = null; textEl = null; thinkEl = null; pendingMd = '';
  const el = document.createElement('div');
  el.className = 'msg system';
  el.innerHTML = `<div class="sys-label">system</div>${md(text)}`;
  chat.appendChild(el);
  scrollBottom();
}

// ── Pickers (dropdown above input, same form as command autocomplete) ──

const pickerEl = document.createElement('div');
pickerEl.id = 'picker';
pickerEl.className = 'picker-list';
document.querySelector('footer').appendChild(pickerEl);

let pickerMode = null;          // 'model' | 'thinking' | null
let modelCache = null;          // last model_list payload
function hidePicker() { pickerMode = null; pickerEl.classList.remove('visible'); pickerEl.innerHTML = ''; }
// Typing a bare picker command opens the dropdown immediately —
// no Send press needed. Returns true when the value is a picker trigger.
function maybeShowPicker(value) {
  const t = value.trim();
  if (t !== '/model' && t !== '/thinking') return false;
  pickerMode = t === '/model' ? 'model' : 'thinking';
  if (pickerMode === 'model') {
    if (modelCache) renderModelPicker(modelCache);
    if (ws && ws.readyState === 1 && activeSessionId) {
      ws.send(JSON.stringify({ type: 'get_models', sessionId: activeSessionId }));
    }
  } else {
    renderThinkingPicker();
  }
  return true;
}

function showPicker(title, items, onPick) {
  if (!items.length) return;
  agentEl = null; textEl = null; thinkEl = null; pendingMd = '';
  hideAutocomplete();
  pickerEl.innerHTML = `<div class="picker-title">${esc(title)}</div>`;
  const list = document.createElement('div');
  list.className = 'model-list';
  for (const it of items) {
    const item = document.createElement('button');
    item.className = 'model-item' + (it.current ? ' current' : '');
    item.innerHTML = it.html;
    item.onclick = () => { hidePicker(); input.value = ''; input.style.height = 'auto'; onPick(it.value); };
    list.appendChild(item);
  }
  pickerEl.appendChild(list);
  pickerEl.classList.add('visible');
}

document.addEventListener('click', (e) => {
  // Send/Stop clicks open pickers themselves — don't treat as outside-clicks
  if (e.target.closest('#sendBtn, #stopBtn')) return;
  if (pickerEl.classList.contains('visible') && !pickerEl.contains(e.target)) hidePicker();
});

function renderModelPicker(models) {
  if (!models.length) return;
  const currentModel = (document.getElementById('model')?.textContent || '').trim();
  const items = models.map(m => {
    const full = m.provider + '/' + m.id;
    const isCurrent = full === currentModel;
    const cost = m.cost ? `$${m.cost.input}/$${m.cost.output}` : '';
    const ctx = m.contextWindow ? `${Math.round(m.contextWindow / 1024)}k` : '';
    return {
      value: full,
      current: isCurrent,
      html: `
        <span class="mi-provider">${esc(m.provider)}</span>
        <span class="mi-id">${esc(m.name || m.id)}</span>
        ${ctx ? `<span class="mi-ctx">${ctx}</span>` : ''}
        ${cost ? `<span class="mi-cost">${cost}</span>` : ''}
        ${m.reasoning ? '<span class="mi-badge">R</span>' : ''}
        ${isCurrent ? '<span class="mi-check">✓</span>' : ''}`,
    };
  });
  showPicker('select a model', items, (full) => {
    if (ws && ws.readyState === 1 && activeSessionId) {
      ws.send(JSON.stringify({ type: 'prompt', message: `/model ${full}`, sessionId: activeSessionId, nickname: nick }));
      localEcho(`model → ${full}`);
    }
  });
}

function renderThinkingPicker() {
  const efforts = lastState?.model?.thinking?.efforts || ['off', 'low', 'medium', 'high'];
  const options = ['off', ...efforts.filter(e => e !== 'off')];
  const current = lastState?.thinkingLevel;
  const items = options.map(lvl => ({
    value: lvl,
    current: lvl === current,
    html: `<span class="mi-id">${esc(lvl)}</span>${lvl === current ? '<span class="mi-check">✓</span>' : ''}`,
  }));
  showPicker('select thinking level', items, (lvl) => {
    if (ws && ws.readyState === 1 && activeSessionId) {
      ws.send(JSON.stringify({ type: 'prompt', message: `/thinking ${lvl}`, sessionId: activeSessionId, nickname: nick }));
      localEcho(`thinking → ${lvl}`);
    }
  });
}

function localEcho(text) {
  agentEl = null; textEl = null; thinkEl = null; pendingMd = '';
  const el = document.createElement('div');
  el.className = 'msg system echo';
  el.innerHTML = `<div class="sys-label">→</div>${esc(text)}`;
  chat.appendChild(el);
  scrollBottom();
}
function setStream(on) {
  streaming = on;
  sendBtn.style.display = on ? 'none' : 'inline-block';
  stopBtn.style.display = on ? 'inline-block' : 'none';
  if (!on) { agentEl = null; textEl = null; thinkEl = null; }
}
function handleEvent(msg) {
  switch (msg.type) {
    case 'session_list':
      renderSessionList(msg.sessions || []);
      break;
    case 'session_switched':
      activeSessionId = msg.sessionId;
      clearChat();
      break;
    case 'session_history':
      loadHistory(msg.messages || []);
      break;
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
        renderToolCard(msg.name || 'tool', msg.params);
      }
      break;
    }
    case 'tool_end': {
      const cards = chat.querySelectorAll('.tool');
      const last = cards[cards.length - 1];
      if (last) {
        last.querySelector('.st').textContent = '✓';
        last.querySelector('.st').classList.add('done');
        const resultEl = last.querySelector('.tool-result pre');
        if (resultEl && msg.result) {
          const r = msg.result;
          if (r.length < 2000 && (r.includes('\n') || r.includes('`') || r.includes('**'))) {
            resultEl.innerHTML = md(r);
          } else {
            resultEl.textContent = r.slice(0, 2000);
          }
        } else if (resultEl) {
          resultEl.textContent = '(no output)';
        }
      }
      break;
    }
    case 'user_message':
      if (msg.from !== nick) {
        userMsg(msg.content || '', msg.from || 'someone');
      }
      break;
    case 'prompt_accepted':
      setStream(true);
      // Some session-local commands (e.g. /goal show) are acknowledged but
      // never start the agent and produce no output — unstick after a beat.
      clearTimeout(promptWatchdog);
      promptWatchdog = setTimeout(() => { if (streaming) setStream(false); }, 3000);
      break;
    case 'agent_start':
      clearTimeout(promptWatchdog);
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
      renderCmdOutput(msg.content || msg.output || '');
      break;
    case 'model_list': {
      modelCache = msg.models || [];
      renderModelPicker(modelCache);
      break;
    }
    case 'subagent_update':
      hubAgents = msg.subagents || [];
      renderHub();
      break;
    case 'agent_error': {
      agentEl = null; textEl = null; thinkEl = null; pendingMd = '';
      const el = document.createElement('div');
      el.className = 'msg agent-error';
      el.innerHTML = `<div class="err-label">⚠ agent error</div>${md(msg.error || 'unknown error')}`;
      chat.appendChild(el);
      scrollBottom();
      setStream(false);
      break;
    }
    case 'agent_exited':
      if (!document.querySelector('.msg.agent-error')) renderNotice('agent exited');
      setStream(false);
      break;
    case 'state_update': {
      lastState = msg;
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
    case 'cost_update': {
      const el = document.getElementById('cost');
      if (el && typeof msg.cost === 'number') {
        el.textContent = '$' + msg.cost.toFixed(4);
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
    // Auto-create session on first connect
    if (!activeSessionId) {
      ws.send(JSON.stringify({ type: 'new_session' }));
    } else {
      ws.send(JSON.stringify({ type: 'switch_session', sessionId: activeSessionId }));
    }
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
  if (!t || !ws || ws.readyState !== 1 || !activeSessionId) return;
  // Picker triggers: the dropdown IS the interface — don't send the raw command.
  if (t === '/model' || t === '/thinking') {
    maybeShowPicker(t);  // re-open if closed
    return;
  }
  input.value = '';
  input.style.height = 'auto';
  userMsg(t, nick);
  ws.send(JSON.stringify({
    type: 'prompt',
    message: t,
    sessionId: activeSessionId,
    nickname: nick,
  }));
}

function stop() {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'abort' }));
    setStream(false);
  }
}

// ── Command autocomplete ──────────────────────────────────────────────
const COMMANDS = [
  { cmd: '/model',       desc: 'Show or switch the current model' },
  { cmd: '/goal',        desc: 'Toggle goal mode (persistent autonomous objective)' },
  { cmd: '/goal set',    desc: 'Set or replace the goal' },
  { cmd: '/goal show',   desc: 'Show current goal details' },
  { cmd: '/goal pause',  desc: 'Pause the current goal' },
  { cmd: '/goal resume', desc: 'Resume a paused goal' },
  { cmd: '/goal drop',   desc: 'Drop the current goal' },
  { cmd: '/goal budget', desc: 'Adjust the token budget (<N|off>)' },
  { cmd: '/compact',     desc: 'Compress the conversation context' },
  { cmd: '/thinking',    desc: 'Set thinking level (off/low/medium/high/max)' },
  { cmd: '/help',        desc: 'Show available commands' },
  { cmd: '/dump',        desc: 'Dump the full conversation' },
  { cmd: '/export',      desc: 'Export the conversation' },
  { cmd: '/exit',        desc: 'Leave the session' },
];

const cmdList = document.getElementById('cmdList');
let cmdActiveIndex = -1;

function hideAutocomplete() {
  cmdList.classList.remove('visible');
  cmdList.innerHTML = '';
  cmdActiveIndex = -1;
}
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

// ── Input events ──────────────────────────────────────────────────────
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
  if (maybeShowPicker(input.value)) return;
  hidePicker();
  showCmds(input.value);
});

connect();
