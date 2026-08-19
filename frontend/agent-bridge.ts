#!/usr/bin/env bun
// agent-bridge: WebSocket ↔ CLI agent adapter for oh-my-portal.
// Spawns a CLI agent (default: omp --mode rpc) and bridges its stdio
// JSON-RPC to WebSocket clients, rendering events into a universal
// agent event stream the frontend can display.
//
// Usage: bun agent-bridge.ts [--agent "omp --mode rpc"] [--port 7683]

import { spawn, ChildProcess } from "child_process";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const AGENT_CMD = flag("agent", "omp --mode rpc");
const PORT = parseInt(flag("port", "7683"), 10);

// ── Agent process management ─────────────────────────────────────────

let agentProc: ChildProcess | null = null;
let agentStdin: NodeJS.WritableStream | null = null;

function startAgent() {
  const [cmd, ...rest] = AGENT_CMD.split(" ");
  agentProc = spawn(cmd, rest, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });
  agentStdin = agentProc.stdin;

  let buffer = "";
  agentProc.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf-8");
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        handleAgentMessage(msg);
      } catch { /* non-JSON line, skip */ }
    }
  });

  agentProc.stderr!.on("data", (chunk: Buffer) => {
    broadcast({ type: "agent_log", content: chunk.toString("utf-8") });
  });

  agentProc.on("exit", (code) => {
    console.log(`[bridge] agent exited (${code})`);
    broadcast({ type: "agent_exited", code });
    agentProc = null;
    agentStdin = null;
  });

  console.log(`[bridge] spawned: ${AGENT_CMD} (pid ${agentProc.pid})`);
}

function sendToAgent(obj: Record<string, unknown>) {
  if (!agentStdin) {
    startAgent();
  }
  if (agentStdin) {
    agentStdin.write(JSON.stringify(obj) + "\n");
  }
}

// ── RPC protocol negotiation ─────────────────────────────────────────

let rpcReady = false;
let pendingProtocol = false;

function negotiateProtocol() {
  if (pendingProtocol) return;
  pendingProtocol = true;
  sendToAgent({ id: "proto-1", type: "negotiate_protocol", protocolVersion: 2 });
}

// ── Event translation: agent-specific → universal ───────────────────

// Universal event format the frontend understands:
// { type: "text_delta", content }
// { type: "thinking_delta", content }
// { type: "tool_start", name, params }
// { type: "tool_end", name, result }
// { type: "agent_start" }
// { type: "agent_end" }
// { type: "state", model, contextPercent, isStreaming }

function handleAgentMessage(msg: any) {
  // Handle ready frame
  if (msg.type === "ready") {
    rpcReady = true;
    negotiateProtocol();
    broadcast({ type: "agent_ready" });
    return;
  }

  // Handle response to protocol negotiation
  if (msg.type === "response" && msg.id === "proto-1") {
    pendingProtocol = false;
    if (msg.success) {
      console.log("[bridge] protocol v2 negotiated");
    }
    return;
  }

  // Handle prompt response
  if (msg.type === "response" && msg.command === "prompt") {
    if (msg.success) {
      broadcast({ type: "prompt_accepted" });
    } else {
      broadcast({ type: "prompt_error", error: msg.error || "prompt failed" });
    }
    return;
  }

  // Translate agent session events to universal events
  switch (msg.type) {
    case "agent_start":
      broadcast({ type: "agent_start" });
      break;
    case "agent_end":
      broadcast({ type: "agent_end", terminal: msg.isTerminal !== false });
      break;
    case "message_start":
      // new message block
      break;
    case "message_update": {
      const evt = msg.assistantMessageEvent;
      if (!evt) break;
      if (evt.type === "text_delta" && evt.delta) {
        broadcast({ type: "text_delta", content: evt.delta });
      } else if (evt.type === "thinking_delta" && evt.delta) {
        broadcast({ type: "thinking_delta", content: evt.delta });
      } else if (evt.type === "toolcall") {
        // Tool call might be partial during streaming
        if (evt.toolCall?.name) {
          broadcast({
            type: "tool_start",
            name: evt.toolCall.name,
            params: evt.toolCall.input || {},
          });
        }
      }
      break;
    }
    case "message_end":
      break;
    case "tool_execution_start":
      broadcast({
        type: "tool_start",
        name: msg.toolName || "unknown",
        params: msg.input || {},
      });
      break;
    case "tool_execution_end":
      broadcast({
        type: "tool_end",
        name: msg.toolName || "unknown",
        result: summarizeResult(msg.result),
      });
      break;
    case "notice":
      broadcast({ type: "notice", content: msg.message || "" });
      break;
    default:
      // Forward unknown events as-is for debugging
      broadcast({ type: "raw", event: msg.type, data: msg });
      break;
  }
}

function summarizeResult(result: any): string {
  if (!result) return "";
  if (result.content) {
    if (Array.isArray(result.content)) {
      return result.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text || "")
        .join("\n")
        .slice(0, 2000);
    }
    if (typeof result.content === "string") {
      return result.content.slice(0, 2000);
    }
  }
  if (result.error) return `Error: ${result.error}`;
  return JSON.stringify(result).slice(0, 500);
}

// ── WebSocket server ─────────────────────────────────────────────────

const clients = new Set<any>();

function broadcast(msg: Record<string, unknown>) {
  const data = JSON.stringify(msg);
  for (const ws of clients) {
    try { ws.send(data); } catch { /* client gone */ }
  }
}

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  fetch(req, server) {
    // Serve the frontend HTML
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(Bun.file(new URL("./index.html", import.meta.url)));
    }
    // Health check
    if (url.pathname === "/healthz") {
      return new Response("ok", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      clients.add(ws);
      console.log(`[bridge] client connected (${clients.size} total)`);
      ws.send(JSON.stringify({ type: "bridge_connected", agent: AGENT_CMD }));
      if (!agentProc) startAgent();
    },
    message(ws, message) {
      try {
        const msg = JSON.parse(message as string);
        if (msg.type === "prompt") {
          sendToAgent({
            id: `prompt-${Date.now()}`,
            type: "prompt",
            message: msg.message,
          });
        } else if (msg.type === "abort") {
          sendToAgent({ id: `abort-${Date.now()}`, type: "abort" });
        }
      } catch { /* invalid JSON from client */ }
    },
    close(ws) {
      clients.delete(ws);
      console.log(`[bridge] client disconnected (${clients.size} total)`);
    },
  },
});

console.log(`[bridge] listening on 127.0.0.1:${PORT}`);
console.log(`[bridge] agent command: ${AGENT_CMD}`);
console.log(`[bridge] frontend served at http://127.0.0.1:${PORT}/`);
