#!/usr/bin/env bun
// agent-bridge: WebSocket ↔ CLI agent with session management.
// Each session gets its own agent process (independent context).
//
// Usage:
//   bun agent-bridge.ts                           → OMP (default)
//   bun agent-bridge.ts --agent claude            → Claude Code SDK
//   bun agent-bridge.ts --port 7683               → custom port

import type { AgentAdapter, AgentEvent } from "./adapters/types";
import { OmpRpcAdapter } from "./adapters/omp-rpc";
import { ClaudeCodeAdapter } from "./adapters/claude-code";
import { CodexAdapter } from "./adapters/codex";
import { OpencodeAdapter } from "./adapters/opencode";
import { SimpleAdapter } from "./adapters/simple";

// ── CLI args ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const AGENT = flag("agent", "omp");
const PORT = parseInt(flag("port", "7683"), 10);

// ── Adapter factory ──────────────────────────────────────────────────

function createAdapter(): AgentAdapter {
  if (AGENT === "omp" || AGENT.startsWith("omp ")) return new OmpRpcAdapter();
  if (AGENT === "claude" || AGENT === "claude-code") return new ClaudeCodeAdapter();
  if (AGENT === "codex" || AGENT === "openai") return new CodexAdapter();
  if (AGENT === "opencode") return new OpencodeAdapter();
  return new SimpleAdapter(AGENT);
}

// ── Session management ────────────────────────────────────────────────

interface Session {
  id: string;
  adapter: AgentAdapter;
  title: string;
  createdAt: number;
  messages: Array<{ role: string; content: string; from?: string }>;
}

const sessions = new Map<string, Session>();
let sessionCounter = 0;

function createSession(): Session {
  const id = `s${++sessionCounter}_${Date.now().toString(36)}`;
  const adapter = createAdapter();
  const session: Session = { id, adapter, title: "New Chat", createdAt: Date.now(), messages: [] };

  // Record assistant turns so session switching and page refreshes replay
  // the full conversation, not just the user's side.
  let turnText = "";
  adapter.onEvent((event) => {
    if (event.type === "text_delta" && event.content) {
      turnText += event.content;
    } else if (event.type === "agent_end") {
      if (turnText.trim()) session.messages.push({ role: "assistant", content: turnText });
      turnText = "";
    }
    sendToSession(id, event);
  });

  adapter.start();
  sessions.set(id, session);
  console.log(`[bridge] session ${id} created (${sessions.size} active)`);
  return session;
}

function deleteSession(id: string): void {
  const session = sessions.get(id);
  if (session) {
    session.adapter.stop();
    sessions.delete(id);
    console.log(`[bridge] session ${id} deleted (${sessions.size} active)`);
  }
}

function sessionList() {
  return Array.from(sessions.values()).map((s) => ({
    id: s.id,
    title: s.title,
    createdAt: s.createdAt,
    messageCount: s.messages.length,
  }));
}

// ── WebSocket clients ────────────────────────────────────────────────

type ClientWebSocket = import("ws").WebSocket & { activeSession: string | null };
const clients = new Set<ClientWebSocket>();

function sendToSession(sessionId: string, event: AgentEvent): void {
  const data = JSON.stringify(event);
  for (const ws of clients) {
    if (ws.activeSession === sessionId) {
      try { ws.send(data); } catch { /* gone */ }
    }
  }
}

// Tell a client what the session's adapter can do — the frontend shows
// only the features the active agent supports.
function sendCapabilities(ws: ClientWebSocket, session: Session): void {
  ws.send(JSON.stringify({
    type: "capabilities",
    adapter: session.adapter.name,
    caps: session.adapter.capabilities,
    commands: session.adapter.commands?.() ?? [],
  }));
}

function broadcastAll(obj: Record<string, unknown>): void {
  const data = JSON.stringify(obj);
  for (const ws of clients) {
    try { ws.send(data); } catch { /* gone */ }
  }
}

// ── HTTP + WebSocket server ─────────────────────────────────────────

const html = await Bun.file(new URL("./index.html", import.meta.url)).text();
const css = await Bun.file(new URL("./style.css", import.meta.url)).text();
const js = await Bun.file(new URL("./app.js", import.meta.url)).text();

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req, server) {
    // WebSocket upgrade first
    if (server.upgrade(req)) return;

    const path = new URL(req.url).pathname;
    if (path === "/" || path === "/index.html") {
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    if (path === "/style.css") {
      return new Response(css, { headers: { "Content-Type": "text/css; charset=utf-8" } });
    }
    if (path === "/app.js") {
      return new Response(js, { headers: { "Content-Type": "application/javascript; charset=utf-8" } });
    }
    if (path === "/healthz") {
      return new Response("ok");
    }
    return new Response("not found", { status: 404 });
  },

  websocket: {
    open(ws: ClientWebSocket) {
      clients.add(ws);
      ws.activeSession = null;
      console.log(`[bridge] client connected (${clients.size})`);

      // Reconnect (page refresh) → reattach to the most recent session;
      // only create one when none exist.
      const latest = Array.from(sessions.values())
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      const session = latest ?? createSession();
      ws.activeSession = session.id;
      sendCapabilities(ws, session);
      ws.send(JSON.stringify({ type: "session_switched", sessionId: session.id }));
      if (latest) {
        ws.send(JSON.stringify({ type: "session_history", messages: session.messages }));
        session.adapter.pollState();
      }
      broadcastAll({ type: "session_list", sessions: sessionList() });
    },

    message(ws: ClientWebSocket, message: string) {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(message); } catch { return; }

      const type = msg.type as string;
      if (type === "new_session") {
        const session = createSession();
        ws.activeSession = session.id;
        sendCapabilities(ws, session);
        ws.send(JSON.stringify({ type: "session_switched", sessionId: session.id }));
        broadcastAll({ type: "session_list", sessions: sessionList() });
      }

      else if (type === "switch_session" && typeof msg.sessionId === "string") {
        const session = sessions.get(msg.sessionId);
        if (session) {
          ws.activeSession = session.id;
          sendCapabilities(ws, session);
          ws.send(JSON.stringify({ type: "session_switched", sessionId: session.id }));
          ws.send(JSON.stringify({ type: "session_history", messages: session.messages }));
          session.adapter.pollState();
        }
      }

      else if (type === "delete_session" && typeof msg.sessionId === "string") {
        deleteSession(msg.sessionId);
        if (ws.activeSession === msg.sessionId) ws.activeSession = null;
        broadcastAll({ type: "session_list", sessions: sessionList() });
      }

      else if (type === "list_sessions") {
        ws.send(JSON.stringify({ type: "session_list", sessions: sessionList() }));
      }

      else if (type === "prompt" && typeof msg.sessionId === "string") {
        const session = sessions.get(msg.sessionId);
        if (!session) return;
        ws.activeSession = session.id;

        const text = msg.message as string;
        const from = (msg.nickname as string) || "anonymous";

        session.messages.push({ role: "user", content: text, from });
        if (session.title === "New Chat" && text) {
          session.title = text.slice(0, 40) + (text.length > 40 ? "…" : "");
        }

        sendToSession(session.id, { type: "user_message", content: text, from });
        session.adapter.prompt(text);
      }

      else if (type === "get_models" && typeof msg.sessionId === "string") {
        const session = sessions.get(msg.sessionId);
        if (session) session.adapter.listModels?.();
      }

      else if (type === "get_subagent_messages" && typeof msg.sessionId === "string") {
        const session = sessions.get(msg.sessionId);
        session?.adapter.getSubagentMessages?.(
          String(msg.subagentId || ""),
          String(msg.sessionFile || ""),
          typeof msg.fromByte === "number" ? msg.fromByte : 0,
        );
      }

      else if (type === "abort" && ws.activeSession) {
        const session = sessions.get(ws.activeSession);
        if (session) session.adapter.abort();
      }
    },

    close(ws: ClientWebSocket) {
      clients.delete(ws);
      console.log(`[bridge] client disconnected (${clients.size})`);
    },
  },
});

console.log(`[bridge] listening on 127.0.0.1:${PORT}`);
console.log(`[bridge] frontend at http://127.0.0.1:${PORT}/`);
console.log(`[bridge] agent: ${AGENT}`);
