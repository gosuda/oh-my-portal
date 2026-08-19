#!/usr/bin/env bun
// agent-bridge: WebSocket ↔ CLI agent adapter for oh-my-portal.
// Serves the frontend and bridges agent protocols to universal events.
//
// Usage:
//   bun agent-bridge.ts                           → OMP RPC (default)
//   bun agent-bridge.ts --agent claude            → Claude Code SDK
//   bun agent-bridge.ts --agent codex             → OpenAI Codex SDK
//   bun agent-bridge.ts --agent opencode          → opencode serve API
//   bun agent-bridge.ts --agent <any-command>     → subprocess fallback
//   bun agent-bridge.ts --port 7683               → custom port

import { AgentAdapter, AgentEvent } from "./adapters/types";
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

// ── Adapter selection ────────────────────────────────────────────────

function createAdapter(agentName: string): AgentAdapter {
  if (agentName === "omp" || agentName.startsWith("omp ")) {
    return new OmpRpcAdapter(agentName.split(" ")[0]);
  }
  if (agentName === "claude" || agentName === "claude-code") {
    return new ClaudeCodeAdapter();
  }
  if (agentName === "codex" || agentName === "openai") {
    return new CodexAdapter();
  }
  if (agentName === "opencode") {
    return new OpencodeAdapter();
  }
  // Any other agent: universal subprocess fallback
  return new SimpleAdapter(agentName);
}

const adapter = createAdapter(AGENT);
console.log(`[bridge] adapter: ${adapter.name} (${AGENT})`);

// ── WebSocket clients ────────────────────────────────────────────────

const clients = new Set<import("ws").WebSocket>();

function broadcast(event: AgentEvent & { from?: string }) {
  const data = JSON.stringify(event);
  for (const ws of clients) {
    try { ws.send(data); } catch { /* gone */ }
  }
}

// ── Adapter wiring ───────────────────────────────────────────────────

adapter.onEvent((event) => broadcast(event));

// ── HTTP + WebSocket server ─────────────────────────────────────────

const html = await Bun.file(new URL("./index.html", import.meta.url)).text();

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade (check before serving static files)
    if (server.upgrade(req)) return;

    // Static files
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    if (url.pathname === "/style.css") {
      const css = await Bun.file(new URL("./style.css", import.meta.url)).text();
      return new Response(css, { headers: { "Content-Type": "text/css; charset=utf-8" } });
    }
    if (url.pathname === "/app.js") {
      const js = await Bun.file(new URL("./app.js", import.meta.url)).text();
      return new Response(js, { headers: { "Content-Type": "application/javascript; charset=utf-8" } });
    }
    if (url.pathname === "/healthz") {
      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  },

  websocket: {
    open(ws) {
      clients.add(ws);
      console.log(`[bridge] client connected (${clients.size})`);
      ws.send(JSON.stringify({ type: "bridge_connected", agent: adapter.name }));
      adapter.start();
    },

    message(ws, message) {
      try {
        const msg = JSON.parse(message as string);
        if (msg.type === "prompt") {
          broadcast({ type: "user_message", content: msg.message, from: msg.nickname || "anonymous" });
          adapter.prompt(msg.message);
        } else if (msg.type === "abort") {
          adapter.abort();
        }
      } catch {
        // invalid JSON from client
      }
    },

    close(ws) {
      clients.delete(ws);
      console.log(`[bridge] client disconnected (${clients.size})`);
    },
  },
});

console.log(`[bridge] listening on 127.0.0.1:${PORT}`);
console.log(`[bridge] frontend at http://127.0.0.1:${PORT}/`);
