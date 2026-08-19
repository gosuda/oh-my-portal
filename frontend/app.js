'use strict';

// agent-frontend client — vanilla JS, no dependencies.
//
// WebSocket event contract (bridge → client):
//   session_switched {sessionId}          active session changed
//   session_history  {messages[]}         replay on switch/refresh
//   session_list     {sessions[]}         sidebar entries
//   user_message     {content, from}      a participant sent a prompt
//   text_delta       {content}            assistant text (markdown)
//   thinking_delta   {content}            assistant thinking
//   tool_start       {name, params}       tool call began
//   tool_end         {name, result}       tool call finished
//   prompt_accepted  {}                   bridge forwarded the prompt
//   agent_start / agent_end               streaming boundaries
//   command_result   {}                   slash command handled locally
//   command_output   {content}            slash command output (markdown)
//   state_update     {model, contextUsage, thinkingLevel}
//   cost_update      {cost}               cumulative session spend
//   model_list       {models[]}           available models
//   subagent_update  {subagents[]}        live subagent progress
//   agent_error      {error}              agent died (stderr guidance)
//   agent_exited     {}                   agent process gone
//   notice           {content}
//
// Client → bridge:
//   new_session / switch_session {sessionId} / delete_session {sessionId}
//   prompt {sessionId, message, nickname} / abort / get_models {sessionId}

const chatTitle = document.getElementById('chatTitle');
const statusEl = document.getElementById('status');

const chat = document.getElementById('chat');
const input = document.getElementById('input');
const sendBtn = document.getElementById('sendBtn');
const stopBtn = document.getElementById('stopBtn');
const dot = document.getElementById('dot');
const modelEl = document.getElementById('model');
const ctxEl = document.getElementById('ctx');
const costEl = document.getElementById('cost');
const sidebar = document.getElementById('sidebar');
const sidebarOverlay = document.getElementById('sidebar-overlay');
const gateInput = document.getElementById('gateInput');
const nickInput = document.getElementById('nickInput');
const cmdList = document.getElementById('cmdList');
const hubBtn = document.getElementById('hubBtn');
const hubCount = document.getElementById('hubCount');
const hubEl = document.getElementById('hub');
const hubOverlay = document.getElementById('hub-overlay');
const hubList = document.getElementById('hubList');

// ── 2. State ─────────────────────────────────────────────────────────

let ws = null;
let streaming = false;
let activeSessionId = null;
let reconnectTimer = null;
let promptWatchdog = null;
let lastState = null;        // last state_update (model, thinkingLevel, …)
let modelCache = null;       // last model_list payload
let caps = { models: false, thinking: false, subagents: false, transcripts: false, cost: false, commands: false, abort: true };
let COMMANDS = [];           // adapter-provided slash commands (via capabilities)
let hubAgents = [];          // last subagent_update payload

// In-flight assistant message being streamed.
let agentEl = null;          // bubble element
let textEl = null;           // markdown container inside bubble
let thinkEl = null;          // thinking container inside bubble
let pendingMd = '';          // unrendered markdown accumulator

let nick = localStorage.getItem('chat-nick') || 'anon-' + Math.random().toString(36).slice(2, 6);
nickInput.value = nick;

// ── 3. Utilities ─────────────────────────────────────────────────────

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

// Detach the in-flight agent bubble so the next element starts fresh.
function resetAgent() {
  agentEl = null; textEl = null; thinkEl = null; pendingMd = '';
}

function scrollBottom() { chat.scrollTop = chat.scrollHeight; }

function saveNick(v) {
  nick = (v || '').trim().slice(0, 20) || nick;
  localStorage.setItem('chat-nick', nick);
}

// ── 4. Password gate (R3) ────────────────────────────────────────────

function unlock() {
  if (gateInput.value === '1234') {
    gateEl.style.display = 'none';
    localStorage.setItem('chat-pass', '1');
    input.focus();
  } else {
    gateInput.value = '';
    gateInput.placeholder = 'wrong';
  }
}
if (localStorage.getItem('chat-pass') === '1') gateEl.style.display = 'none';

// ── 5. Sidebar / sessions (R2) ───────────────────────────────────────

function toggleSidebar() {
  sidebar.classList.toggle('open');
  sidebarOverlay.classList.toggle('open');
}

function newSession() {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'new_session' }));
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

// ── 6. Chat rendering (R1, R5, R6, R7, R10, R15) ────────────────────

function userMsg(text, who) {
  resetAgent();
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

function renderText(delta) {
  agentBubble();
  pendingMd += delta;
  textEl.innerHTML = md(pendingMd);
  scrollBottom();
}

function renderThinking(delta) {
  agentBubble();
  if (!thinkEl) {
    thinkEl = document.createElement('div');
    thinkEl.className = 'thinking';
    agentEl.insertBefore(thinkEl, textEl);
  }
  thinkEl.textContent += delta;
}

function renderToolCard(name, params) {
  resetAgent();
  const card = document.createElement('div');
  card.className = 'tool';
  card.dataset.name = name;
  const paramsStr = params && Object.keys(params).length ? JSON.stringify(params, null, 2) : '';
  card.innerHTML = `
    <div class="hd"><span class="icon">⚙</span><span class="name">${esc(name)}</span><span class="st">running…</span></div>
    <div class="bd">
      ${paramsStr ? `<div class="tool-params"><span class="lbl">params</span><pre>${esc(paramsStr)}</pre></div>` : ''}
      <div class="tool-result"><span class="lbl">result</span><pre>waiting…</pre></div>
    </div>`;
  card.querySelector('.hd').onclick = () => card.classList.toggle('open');
  chat.appendChild(card);
  scrollBottom();
}

function finishToolCard(result) {
  const cards = chat.querySelectorAll('.tool');
  const last = cards[cards.length - 1];
  if (!last) return;
  last.querySelector('.st').textContent = '✓';
  last.querySelector('.st').classList.add('done');
  const out = last.querySelector('.tool-result pre');
  if (!out) return;
  if (result) {
    // Markdown-render text-like results, truncate long ones
    if (result.length < 2000 && (result.includes('\n') || result.includes('`') || result.includes('**'))) {
      out.innerHTML = md(result);
    } else {
      out.textContent = result.slice(0, 2000);
    }
  } else {
    out.textContent = '(no output)';
  }
}

function renderNotice(text) {
  const el = document.createElement('div');
  el.className = 'notice';
  el.textContent = text;
  chat.appendChild(el);
  scrollBottom();
}

function renderCmdOutput(text) {
  if (!text || !text.trim()) return;
  resetAgent();
  const el = document.createElement('div');
  el.className = 'msg system';
  el.innerHTML = `<div class="sys-label">system</div>${md(text)}`;
  chat.appendChild(el);
  scrollBottom();
}

// Local confirmation for client-initiated choices (R10)
function localEcho(text) {
  resetAgent();
  const el = document.createElement('div');
  el.className = 'msg system echo';
  el.innerHTML = `<div class="sys-label">→</div>${esc(text)}`;
  chat.appendChild(el);
  scrollBottom();
}

// Agent died with guidance on stderr — show it prominently (R15)
function renderAgentError(errorText) {
  resetAgent();
  const el = document.createElement('div');
  el.className = 'msg agent-error';
  el.innerHTML = `<div class="err-label">⚠ agent error</div>${md(errorText || 'unknown error')}`;
  chat.appendChild(el);
  scrollBottom();
}

function clearChat() {
  chat.innerHTML = '';
  resetAgent();
}

function loadHistory(messages) {
  clearChat();
  for (const m of messages) {
    if (m.role === 'user') {
      userMsg(m.content, m.from || nick);
    } else if (m.role === 'assistant' && m.content) {
      agentBubble();
      pendingMd = m.content;
      textEl.innerHTML = md(pendingMd);
      resetAgent();
    }
  }
  chat.scrollTop = chat.scrollHeight;
}

// ── 7. Agent Hub (R14 + transcripts) ────────────────────────────────

let hubView = { mode: 'list', agentId: null };  // list | transcript
let sessionFiles = new Map();                   // subagentId → sessionFile
let hubTranscripts = new Map();                 // subagentId → messages[]

function toggleHub() {
  hubEl.classList.toggle('open');
  hubOverlay.classList.toggle('open');
}

function closeHub() {
  hubEl.classList.remove('open');
  hubOverlay.classList.remove('open');
}

// Merge one progress entry into hubAgents (upsert by id).
function upsertSubagent(entry) {
  const i = hubAgents.findIndex(a => a.id === entry.id);
  if (i >= 0) hubAgents[i] = { ...hubAgents[i], ...entry };
  else hubAgents.push(entry);
}

function renderHub() {
  const running = hubAgents.filter(a => a.status === 'running' || a.status === 'pending' || a.status === 'started').length;
  hubBtn.style.display = hubAgents.length ? '' : 'none';
  hubCount.textContent = hubAgents.length;
  hubBtn.classList.toggle('active', running > 0);

  if (hubView.mode === 'transcript') { renderTranscriptView(); return; }

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
      dur,
      cost,
    ].filter(Boolean).join(' · ');
    const canOpen = sessionFiles.has(a.id);
    card.innerHTML = `
      <div class="hc-top">
        <span class="hc-name">${esc(a.id)}</span>
        <span class="hc-status">${esc(a.status)}</span>
      </div>
      <div class="hc-meta">
        <span class="hc-agent">${esc(a.agent)}${a.modelRole ? ' · ' + esc(a.modelRole) : ''}</span>
        <span class="hc-stats">${esc(meta)}</span>
      </div>
      ${a.recentOutput && a.recentOutput.length ? `<div class="hc-out">${esc(a.recentOutput[a.recentOutput.length - 1]).slice(0, 200)}</div>` : ''}
      ${canOpen ? '<button class="hc-open">▤ transcript</button>' : ''}
    `;
    if (canOpen) {
      card.querySelector('.hc-open').onclick = (e) => {
        e.stopPropagation();
        openTranscript(a.id);
      };
    }
    hubList.appendChild(card);
  }
}

function openTranscript(agentId) {
  hubView = { mode: 'transcript', agentId };
  hubList.innerHTML = '<div class="hub-empty">loading…</div>';
  if (ws && ws.readyState === 1 && activeSessionId) {
    ws.send(JSON.stringify({
      type: 'get_subagent_messages',
      sessionId: activeSessionId,
      subagentId: agentId,
      sessionFile: sessionFiles.get(agentId),
      fromByte: 0,
    }));
  }
}

function renderTranscriptView() {
  const agentId = hubView.agentId;
  hubList.innerHTML = `
    <div class="hub-back" onclick="backToHubList()">← agents</div>
    <div class="tr-title">${esc(agentId)}</div>
    <div id="trBody" class="tr-body"></div>`;
  const body = document.getElementById('trBody');
  const msgs = hubTranscripts.get(agentId) || [];
  if (!msgs.length) {
    body.innerHTML = '<div class="hub-empty">no transcript</div>';
    return;
  }
  for (const m of msgs) {
    const el = document.createElement('div');
    el.className = 'tr-msg ' + m.role;
    const blocks = Array.isArray(m.content) ? m.content : [];
    let html = '';
    for (const b of blocks) {
      if (b.type === 'text' && b.text) html += md(b.text);
      else if (b.type === 'toolCall') html += `<div class="tr-tool">⚙ ${esc(b.name || 'tool')}</div>`;
      else if (b.type === 'thinking' && b.thinking) html += `<div class="tr-think">${esc(b.thinking.slice(0, 300))}</div>`;
    }
    if (!html && typeof m.content === 'string') html = md(m.content);
    el.innerHTML = html || `<span class="tr-dim">(${esc(m.role)})</span>`;
    body.appendChild(el);
  }
  body.scrollTop = body.scrollHeight;
}

function backToHubList() {
  hubView = { mode: 'list', agentId: null };
  renderHub();
}

// ── 8. Stream state (R13, R16) ───────────────────────────────────────

function setStream(on) {
  streaming = on;
  // Explicit display values — a CSS `display:none` rule on .stop would
  // win over style.display='' (that bug hid the Stop button).
  sendBtn.style.display = on ? 'none' : 'inline-block';
  stopBtn.style.display = on ? 'inline-block' : 'none';
  if (!on) resetAgent();
}

// Some session-local commands (e.g. /goal show) are acknowledged but
// never start the agent and produce no output — unstick the stream
// indicator if nothing happens within 3s.
function armPromptWatchdog() {
  clearTimeout(promptWatchdog);
  promptWatchdog = setTimeout(() => { if (streaming) setStream(false); }, 3000);
}
function cancelPromptWatchdog() { clearTimeout(promptWatchdog); }

// ── 9. Pickers (R9) ──────────────────────────────────────────────────
// Dropdown anchored above the input — the same form as the command
// autocomplete. Opens the moment the bare trigger is typed; picking
// sends the command, clears the input, and echoes the choice.

const pickerEl = document.createElement('div');
pickerEl.id = 'picker';
pickerEl.className = 'picker-list';
document.querySelector('footer').appendChild(pickerEl);

let pickerMode = null; // 'model' | 'thinking' | null

function hidePicker() {
  pickerMode = null;
  pickerEl.classList.remove('visible');
  pickerEl.innerHTML = '';
}

function showPicker(title, items, onPick) {
  if (!items.length) return;
  resetAgent();
  hideAutocomplete();
  pickerEl.innerHTML = `<div class="picker-title">${esc(title)}</div>`;
  const list = document.createElement('div');
  list.className = 'model-list';
  for (const it of items) {
    const item = document.createElement('button');
    item.className = 'model-item' + (it.current ? ' current' : '');
    item.innerHTML = it.html;
    item.onclick = () => {
      hidePicker();
      input.value = '';
      input.style.height = 'auto';
      onPick(it.value);
    };
    list.appendChild(item);
  }
  pickerEl.appendChild(list);
  pickerEl.classList.add('visible');
}

function maybeShowPicker(value) {
  const t = value.trim();
  if (t === '/model' && caps.models) {
    pickerMode = 'model';
    if (modelCache) renderModelPicker(modelCache);
    if (ws && ws.readyState === 1 && activeSessionId) {
      ws.send(JSON.stringify({ type: 'get_models', sessionId: activeSessionId }));
    }
    return true;
  }
  if (t === '/thinking' && caps.thinking) {
    pickerMode = 'thinking';
    renderThinkingPicker();
    return true;
  }
  return false;
}

// Send a slash command from a picker pick and echo it (R9, R10).
function sendCommand(command, echo) {
  if (!ws || ws.readyState !== 1 || !activeSessionId) return;
  ws.send(JSON.stringify({ type: 'prompt', message: command, sessionId: activeSessionId, nickname: nick }));
  localEcho(echo);
}

function renderModelPicker(models) {
  if (!models.length) return;
  const currentModel = (modelEl.textContent || '').trim();
  const items = models.map(m => {
    const full = m.provider + '/' + m.id;
    const current = full === currentModel;
    const cost = m.cost ? `$${m.cost.input}/$${m.cost.output}` : '';
    const ctx = m.contextWindow ? `${Math.round(m.contextWindow / 1024)}k` : '';
    return {
      value: full,
      current,
      html: `
        <span class="mi-provider">${esc(m.provider)}</span>
        <span class="mi-id">${esc(m.name || m.id)}</span>
        ${ctx ? `<span class="mi-ctx">${esc(ctx)}</span>` : ''}
        ${cost ? `<span class="mi-cost">${esc(cost)}</span>` : ''}
        ${m.reasoning ? '<span class="mi-badge">R</span>' : ''}
        ${current ? '<span class="mi-check">✓</span>' : ''}`,
    };
  });
  showPicker('select a model', items, (full) => {
    sendCommand(`/model ${full}`, `model → ${full}`);
  });
}

function renderThinkingPicker() {
  const efforts = lastState?.model?.thinking?.efforts || ['off', 'low', 'medium', 'high'];
  const current = lastState?.thinkingLevel;
  const items = ['off', ...efforts.filter(e => e !== 'off')].map(lvl => ({
    value: lvl,
    current: lvl === current,
    html: `<span class="mi-id">${esc(lvl)}</span>${lvl === current ? '<span class="mi-check">✓</span>' : ''}`,
  }));
  showPicker('select thinking level', items, (lvl) => {
    sendCommand(`/thinking ${lvl}`, `thinking → ${lvl}`);
  });
}


// Outside-click closes the picker. Send/Stop/autocomplete clicks are
// exempt — they manage pickers (a fresh picker may open during the
// same click whose bubbling would otherwise close it immediately).
document.addEventListener('click', (e) => {
  if (e.target.closest('#sendBtn, #stopBtn, #cmdList')) return;
  if (pickerEl.classList.contains('visible') && !pickerEl.contains(e.target)) hidePicker();
});

// ── 10. Command autocomplete (R8, R17) ───────────────────────────────
// Two-level cascade: level 1 lists top-level commands only; after the
// parent is chosen (trailing space), level 2 lists its subcommands,
// filtered as you type. Once the subcommand itself is complete (a
// space follows), you are typing arguments — the list hides.


let cmdActiveIndex = -1;

function hideAutocomplete() {
  cmdList.classList.remove('visible');
  cmdList.innerHTML = '';
  cmdActiveIndex = -1;
}

function autocompleteMatches(text) {
  if (!text.startsWith('/')) return [];
  const sp = text.indexOf(' ');
  if (sp === -1) {
    // Level 1: top-level commands only.
    const q = text.slice(1).toLowerCase();
    return COMMANDS.filter(c => !c.cmd.includes(' ') && c.cmd.slice(1).toLowerCase().startsWith(q));
  }
  // Level 2: subcommands of the typed parent; hide once arguments start.
  if (text.slice(sp + 1).trim().includes(' ')) return [];
  const parent = text.slice(0, sp).toLowerCase() + ' ';
  const sub = text.slice(sp + 1).toLowerCase().trim();
  return COMMANDS.filter(c =>
    c.cmd.toLowerCase().startsWith(parent) &&
    c.cmd.slice(parent.length).toLowerCase().startsWith(sub)
  );
}

function showAutocomplete(text) {
  const matches = autocompleteMatches(text);
  if (!matches.length) { hideAutocomplete(); return; }
  cmdList.innerHTML = '';
  for (const m of matches) {
    const el = document.createElement('div');
    el.className = 'cmd-item';
    el.innerHTML = `<span class="cmd">${esc(m.cmd)}</span><span class="desc">${esc(m.desc)}</span>`;
    el.onclick = () => {
      input.value = m.cmd + ' ';
      input.focus();
      hideAutocomplete();
      // Re-run input semantics so picker triggers (/model, /thinking)
      // open their dropdown exactly as if typed manually.
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    cmdList.appendChild(el);
  }
  cmdList.classList.add('visible');
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
  (items[cmdActiveIndex] || items[0])?.click();
}

// ── 11. Event dispatch ───────────────────────────────────────────────

function handleEvent(msg) {
  switch (msg.type) {
    // Sessions
    case 'session_list':
      renderSessionList(msg.sessions || []);
      break;
    case 'session_switched':
      activeSessionId = msg.sessionId;
      clearChat();
      // Per-session state from the previous session must not leak in
      hubAgents = [];
      hubView = { mode: 'list', agentId: null };
      sessionFiles.clear();
      hubTranscripts.clear();
      hubBtn.style.display = 'none';
      lastState = null;
      break;
    case 'session_history':
      loadHistory(msg.messages || []);
      break;
    // Feature negotiation — the adapter decides what the UI offers
    case 'capabilities':
      caps = { ...caps, ...(msg.caps || {}) };
      COMMANDS = msg.commands || [];
      hideAutocomplete();
      hidePicker();
      if (!caps.subagents) { hubBtn.style.display = 'none'; hubAgents = []; }
      if (!caps.cost) costEl.textContent = '';
      if (msg.adapter) chatTitle.textContent = 'Agent Chat · ' + msg.adapter;
      break;

    // Chat stream
    case 'user_message':
      if (msg.from !== nick) userMsg(msg.content || '', msg.from || 'someone');
      break;
    case 'text_delta':
      renderText(msg.content || '');
      break;
    case 'thinking_delta':
      renderThinking(msg.content || '');
      break;
    case 'tool_start':
      renderToolCard(msg.name || 'tool', msg.params);
      break;
    case 'tool_end':
      finishToolCard(msg.result);
      break;

    case 'tool_params': {
      // Args arrive after the card was created (tool_execution_update) —
      // fill the last card's params section.
      const cards = chat.querySelectorAll('.tool');
      const last = cards[cards.length - 1];
      if (last && msg.params) {
        let pre = last.querySelector('.tool-params pre');
        if (!pre) {
          const box = document.createElement('div');
          box.className = 'tool-params';
          box.innerHTML = '<span class="lbl">params</span><pre></pre>';
          last.querySelector('.bd').prepend(box);
          pre = box.querySelector('pre');
        }
        pre.textContent = JSON.stringify(msg.params, null, 2);
      }
      break;
    }
    case 'agent_start':
      cancelPromptWatchdog();
      setStream(true);
      break;
    case 'agent_end':
    case 'command_result':
      cancelPromptWatchdog();
      setStream(false);
      break;
    case 'prompt_error':
      renderNotice(msg.error || 'error');
      setStream(false);
      break;

    // Slash command output
    case 'command_output':
      renderCmdOutput(msg.content || msg.output || '');
      break;

    // Pickers
    case 'model_list':
      modelCache = msg.models || [];
      renderModelPicker(modelCache);
      break;

    // Agent Hub — progress arrays upsert by id (finished agents stay visible)
    case 'subagent_update':
      for (const entry of (msg.subagents || [])) upsertSubagent(entry);
      renderHub();
      break;
    case 'subagent_lifecycle':
      if (msg.sessionFile) sessionFiles.set(msg.subagentId, msg.sessionFile);
      upsertSubagent({ id: msg.subagentId, status: msg.status, agent: msg.name || msg.subagentId });
      renderHub();
      break;
    case 'subagent_transcript':
      hubTranscripts.set(msg.subagentId ?? hubView.agentId, msg.transcript || []);
      if (hubView.mode === 'transcript') renderTranscriptView();
      break;

    // Failures
    case 'agent_error':
      renderAgentError(msg.error);
      setStream(false);
      break;
    case 'agent_exited':
      // The error card already explains a crash — no redundant notice.
      if (!document.querySelector('.msg.agent-error')) renderNotice('agent exited');
      setStream(false);
      break;

    // Footer status
    case 'state_update':
      lastState = msg;
      statusEl.style.display = 'block';
      if (msg.model) modelEl.textContent = msg.model.provider + '/' + msg.model.id;
      if (msg.contextUsage) {
        const u = msg.contextUsage;
        ctxEl.textContent = (u.tokens / 1000).toFixed(0) + 'k/' + (u.contextWindow / 1000).toFixed(0) + 'k (' + u.percent.toFixed(1) + '%)';
      }
      break;
    case 'cost_update':
      if (typeof msg.cost === 'number') costEl.textContent = '$' + msg.cost.toFixed(4);
      break;

    case 'notice':
      renderNotice(msg.content);
      break;
  }
}

// ── 12. WebSocket ────────────────────────────────────────────────────

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host);

  ws.onopen = () => {
    dot.classList.add('on');
    input.disabled = false;
    sendBtn.disabled = false;
    clearTimeout(reconnectTimer);
    // The bridge reattaches refreshes to the latest session (R2); on a
    // first-ever connect it auto-creates one.
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

// ── 13. Actions (R13, R18) ───────────────────────────────────────────

function send() {
  const t = input.value.trim();
  if (!t || !ws || ws.readyState !== 1 || !activeSessionId) return;
  // Bare picker triggers: the dropdown is the interface — don't send
  // the raw command (it would reach the agent as a prompt).
  if (t === '/model' || t === '/thinking') {
    maybeShowPicker(t);
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

// ── 14. Input wiring ─────────────────────────────────────────────────

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (cmdList.classList.contains('visible')) cmdAccept();
    else send();
  } else if (e.key === 'ArrowUp' && cmdList.classList.contains('visible')) {
    e.preventDefault();
    cmdNav(-1);
  } else if (e.key === 'ArrowDown' && cmdList.classList.contains('visible')) {
    e.preventDefault();
    cmdNav(1);
  } else if (e.key === 'Escape') {
    hideAutocomplete();
    hidePicker();
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
  showAutocomplete(input.value);
});

// ── init ─────────────────────────────────────────────────────────────

connect();
