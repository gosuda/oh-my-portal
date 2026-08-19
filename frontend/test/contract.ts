// Contract test suite — runtime-agnostic (call runContractTests() from any
// Bun process; wrap in bun:test for CI later).
//
// WHY THIS EXISTS: features kept breaking each other because the contracts
// below lived nowhere. Each regression this suite encodes was a real
// breakage shipped to production:
//   C1  gateEl removed        → gate could never unlock
//   C2  markdown.js unserved  → answers never rendered (thinking only)
//   C3  onopen new_session    → every connect spawned a session (New Chat
//                               looked like a reset)
//   C4  assistant turns unrecorded → refresh lost the conversation
//   C5  hideCmds deleted      → autocomplete died silently
//   C6  password in app.js    → secret shipped in a public asset
//
// Run before every deploy: import this file, call runContractTests().
// A deploy is only valid when every check passes.

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = dirname(fileURLToPath(import.meta.url)); // frontend/test/
const file = (p: string) => readFileSync(join(ROOT, "..", p), "utf-8");

type Check = { name: string; run: () => Promise<string | true> | string | true };
function assert(cond: unknown, msg: string): true {
  if (!cond) throw new Error(msg);
  return true;
}

const checks: Check[] = [];
function check(name: string, run: Check["run"]) { checks.push({ name, run }); }

// C0: every shipped script must parse. A duplicate declaration killed
// the whole frontend (gate included) — catch it before anything else.
check("syntax: all frontend scripts parse", async () => {
  for (const f of ["app.js", "markdown.js"]) {
    const src = file(f);
    try { new Function(src); } catch (e) { throw new Error(`${f}: ${e.message}`); }
  }
  const bridge = file("agent-bridge.ts");
  // import would boot a server; transpile-only catches syntax errors
  const { Transpiler } = await import("bun");
  new Transpiler({ loader: "ts" }).transformSync(bridge);
  return true;
});

// C7: the state block is the file's most-edited region and has lost
// declarations repeatedly (runtime ReferenceErrors that syntax checks
// can't see — pendingMd, hubAgents, gateEl). Every canonical state
// variable must be declared exactly once.
check("state: canonical state vars declared exactly once", () => {
  const app = file("app.js");
  const canonical = [
    "ws", "streaming", "activeSessionId", "reconnectTimer", "promptWatchdog",
    "lastState", "modelCache", "caps", "COMMANDS", "hubAgents", "agentEl",
    "textEl", "thinkEl", "pendingMd", "lastSessions", "nick", "hubView",
    "sessionFiles", "hubTranscripts", "pickerMode", "cmdActiveIndex",
  ];
  const problems: string[] = [];
  for (const name of canonical) {
    const decls = [...app.matchAll(new RegExp(`^\\s*(?:let|const) ${name}\\b`, "gm"))].length;
    if (decls !== 1) problems.push(`${name}: ${decls} declarations`);
  }
  return assert(problems.length === 0, problems.join("; "));
});

check("dom: app.js bindings ↔ index.html ids (both directions)", () => {
  const app = file("app.js");
  const html = file("index.html");
  const bound = [...new Set([...app.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]))];
  const declared = [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
  // created at runtime (bound after createElement, absent from static HTML)
  const runtimeCreated = new Set(["trBody"]);
  // layout-only containers targeted by CSS, never looked up from JS
  const cssOnly = new Set(["app"]);
  const missingInHtml = bound.filter(id => !declared.includes(id) && !runtimeCreated.has(id));
  const unbound = [...new Set(declared)].filter(id => !bound.includes(id) && !cssOnly.has(id));
  return assert(
    missingInHtml.length === 0 && unbound.length === 0,
    `ids used but not in HTML: [${missingInHtml}]; HTML ids never bound: [${unbound}]`
  );
});
check("events: adapter emit() ⊆ union; emitted-or-bridge ⊆ frontend handlers", () => {
  const types = file("adapters/types.ts");
  const app = file("app.js");
  const bridge = file("agent-bridge.ts");
  const adapterFiles = ["adapters/omp-rpc.ts", "adapters/simple.ts", "adapters/claude-code.ts", "adapters/codex.ts", "adapters/opencode.ts"].map(file);

  const union = new Set([...types.matchAll(/\|\s*"([a-z_]+)"/g)].map(m => m[1]));

  // Adapter emissions only: `emit({ type: "..." })` — RPC/WS protocol
  // verbs (get_state, prompt, …) and bridge-level sends are not events.
  const emitted = new Set<string>();
  for (const src of adapterFiles) {
    for (const m of src.matchAll(/emit\(\{\s*type:\s*"([a-z_]+)"/g)) emitted.add(m[1]);
  }
  // Bridge-level events the frontend must handle
  const bridgeEvents = new Set(["capabilities", "session_switched", "session_list", "session_history", "user_message"]);

  const handled = new Set([...app.matchAll(/case\s+'([a-z_]+)':/g)].map(m => m[1]));

  const untyped = [...emitted].filter(t => !union.has(t));
  const unhandled = [...emitted, ...bridgeEvents].filter(t => !handled.has(t));
  return assert(
    untyped.length === 0 && unhandled.length === 0,
    `adapter emits outside the union: [${untyped}]; events no frontend case handles: [${unhandled}]`
  );
});

// C6: no password material in any served asset.
check("security: no hardcoded password in assets", () => {
  for (const f of ["app.js", "markdown.js", "index.html", "style.css"]) {
    assert(!/"password"\s*===|value === '\d{4}'/.test(file(f)), `${f} contains a password comparison`);
  }
  return true;
});

// One bridge per suite run — both runtime checks share it (a second
// bind of the same port would fail).
let bootedBase: Promise<string> | null = null;
function bootTestBridge(): Promise<string> {
  if (!bootedBase) {
    bootedBase = (async () => {
      process.env.GATE_PASSWORD = "contract-test-pw";
      process.env.PORT = "7991";
      process.env.AGENT = "echo"; // SimpleAdapter with `echo` — free fake agent
      await import(`../agent-bridge.ts?contract=${Date.now()}`);
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try {
          await fetch("http://127.0.0.1:7991/healthz");
          return "http://127.0.0.1:7991";
        } catch { await new Promise(r => setTimeout(r, 100)); }
      }
      throw new Error("test bridge did not start on 7991");
    })();
  }
  return bootedBase;
}

function ws(base: string, path: string): Promise<{ messages: Array<Record<string, unknown>>; close: { code: number; reason: string } }> {
  const { promise, resolve } = Promise.withResolvers<{ messages: Array<Record<string, unknown>>; close: { code: number; reason: string } }>();
  const sock = new WebSocket(base.replace(/^http/, "ws") + path);
  const messages: Array<Record<string, unknown>> = [];
  sock.onmessage = (e) => { try { messages.push(JSON.parse(e.data)); } catch { /* ignore */ } };
  sock.onclose = (e) => resolve({ messages, close: { code: e.code, reason: e.reason } });
  return promise;
}

// Like ws() but resolves as soon as a message satisfies `until` — for
// sockets the test has no reason to close.
function wsUntil(base: string, path: string, until: (m: Record<string, unknown>) => boolean): Promise<Array<Record<string, unknown>>> {
  const { promise, resolve } = Promise.withResolvers<Array<Record<string, unknown>>>();
  const sock = new WebSocket(base.replace(/^http/, "ws") + path);
  const messages: Array<Record<string, unknown>> = [];
  sock.onmessage = (e) => {
    let m: Record<string, unknown> = {};
    try { m = JSON.parse(e.data); } catch { /* ignore */ }
    messages.push(m);
    if (until(m)) { sock.close(); resolve(messages); }
  };
  sock.onclose = () => resolve(messages);
  return promise;
}

check("runtime: gate — wrong pw 401, no-token WS closed 1008", async () => {
  const base = await bootTestBridge();
  const wrong = await fetch(base + "/auth", { method: "POST", body: JSON.stringify({ password: "nope" }), headers: { "Content-Type": "application/json" } });
  assert(wrong.status === 401, `wrong password gave ${wrong.status}`);
  const rejected = await ws(base, "/");
  assert(rejected.close.code === 1008, `no-token close code ${rejected.close.code}`);
  assert(rejected.messages.length === 0, "unauthenticated socket received events");
  return true;
});

check("runtime: auth → exactly one session, prompt round-trips, replay has both roles", async () => {
  const base = await bootTestBridge();
  const auth = await (await fetch(base + "/auth", { method: "POST", body: JSON.stringify({ password: "contract-test-pw" }), headers: { "Content-Type": "application/json" } })).json();
  assert(auth.ok && auth.token, "auth failed");

  // one connection, one session — C3: no session explosion on connect
  const { promise: turnDone, resolve: turnResolve } = Promise.withResolvers<Array<Record<string, unknown>>>();
  const sock = new WebSocket(base.replace(/^http/, "ws") + "/?token=" + encodeURIComponent(auth.token));
  const messages: Array<Record<string, unknown>> = [];
  sock.onmessage = (e) => {
    const m = JSON.parse(e.data);
    messages.push(m);
    if (m.type === "session_switched") {
      sock.send(JSON.stringify({ type: "prompt", message: "hello-contract", sessionId: m.sessionId, nickname: "test" }));
    }
  };
  setTimeout(() => { sock.close(); turnResolve(messages); }, 2500);
  const first = { messages: await turnDone };
  const switches = first.messages.filter(m => m.type === "session_switched").length;
  assert(switches === 1, `connect produced ${switches} session_switched events (C3 regression)`);
  const text = first.messages.filter(m => m.type === "text_delta").map(m => m.content).join("");
  assert(text.includes("hello-contract"), `agent text not relayed: "${text}"`);

  // C4: fresh connection replays user AND assistant turns
  const replayMsgs = await wsUntil(base, "/?token=" + encodeURIComponent(auth.token), (m) => m.type === "session_history");
  const history: any = replayMsgs.find(m => m.type === "session_history");
  const roles: string[] = (history?.messages || []).map((m: any) => m.role);
  assert(roles.includes("user") && roles.includes("assistant"),
    `replay missing roles: ${JSON.stringify(roles)} (C4 regression)`);
  return true;
});

// ── Runner ────────────────────────────────────────────────────────────

export async function runContractTests(): Promise<{ passed: string[]; failed: Array<{ name: string; error: string }> }> {
  const passed: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];
  for (const c of checks) {
    try {
      await c.run();
      passed.push(c.name);
    } catch (e) {
      failed.push({ name: c.name, error: (e as Error).message });
    }
  }
  return { passed, failed };
}

// Direct execution (bun test/contract.ts or kernel import+call)
if (import.meta.main || process.env.RUN_CONTRACT === "1") {
  const { passed, failed } = await runContractTests();
  for (const p of passed) console.log(`  ✓ ${p}`);
  for (const f of failed) console.log(`  ✗ ${f.name}\n    ${f.error}`);
  console.log(`\n${passed.length} passed, ${failed.length} failed`);
  // The test bridge's Bun.serve keeps the event loop alive — exit explicitly
  process.exit(failed.length ? 1 : 0);
}
