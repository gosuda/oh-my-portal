// Static contract checks — shared by the test suite AND the bridge itself.
// The bridge runs these at boot and refuses to serve on failure: a broken
// frontend physically cannot deploy, regardless of process discipline.
//
// Runtime checks (gate/session flows needing a booted bridge) live in
// test/contract.ts; everything here is pure static analysis.

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = dirname(fileURLToPath(import.meta.url)); // frontend/
export const file = (p: string) => readFileSync(join(ROOT, p), "utf-8");

export interface CheckResult { name: string; error?: string }

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

export function runStaticChecks(): { passed: CheckResult[]; failed: CheckResult[] } {
  const passed: CheckResult[] = [];
  const failed: CheckResult[] = [];
  const run = (name: string, fn: () => void) => {
    try { fn(); passed.push({ name }); }
    catch (e) { failed.push({ name, error: (e as Error).message }); }
  };

  // C0: every shipped script must parse — a duplicate declaration once
  // killed the whole frontend (gate included).
  run("syntax: all frontend scripts parse", () => {
    for (const f of ["app.js", "markdown.js"]) {
      try { new Function(file(f)); } catch (e) { throw new Error(`${f}: ${(e as Error).message}`); }
    }
    const { Transpiler } = require("bun");
    new Transpiler({ loader: "ts" }).transformSync(file("agent-bridge.ts"));
    for (const f of ["adapters/types.ts", "adapters/omp-rpc.ts", "adapters/claude-code.ts", "adapters/codex.ts", "adapters/opencode.ts", "adapters/simple.ts"]) {
      new Transpiler({ loader: "ts" }).transformSync(file(f));
    }
  });

  // C7: state-block integrity — declarations were dropped three times
  // (gateEl, sessionListEl, pendingMd). Runtime ReferenceErrors that no
  // syntax check can see.
  run("state: canonical state vars declared exactly once", () => {
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
    assert(problems.length === 0, problems.join("; "));
  });

  // C1: DOM bindings ↔ HTML ids, both directions. Forward catches lookups
  // of removed elements; inverse catches dropped binding lines.
  run("dom: app.js bindings ↔ index.html ids (both directions)", () => {
    const app = file("app.js");
    const html = file("index.html");
    const bound = [...new Set([...app.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]))];
    const declared = [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
    const runtimeCreated = new Set(["trBody"]);
    const cssOnly = new Set(["app"]);
    const missingInHtml = bound.filter(id => !declared.includes(id) && !runtimeCreated.has(id));
    const unbound = [...new Set(declared)].filter(id => !bound.includes(id) && !cssOnly.has(id));
    assert(missingInHtml.length === 0 && unbound.length === 0,
      `ids used but not in HTML: [${missingInHtml}]; HTML ids never bound: [${unbound}]`);
  });

  // C5: event-protocol integrity. Adapter emissions must be typed; every
  // emitted or bridge-level event must have a frontend handler.
  run("events: adapter emit() ⊆ union; emitted-or-bridge ⊆ frontend handlers", () => {
    const types = file("adapters/types.ts");
    const app = file("app.js");
    const union = new Set([...types.matchAll(/\|\s*"([a-z_]+)"/g)].map(m => m[1]));
    const emitted = new Set<string>();
    for (const f of ["adapters/omp-rpc.ts", "adapters/simple.ts", "adapters/claude-code.ts", "adapters/codex.ts", "adapters/opencode.ts"]) {
      for (const m of file(f).matchAll(/emit\(\{\s*type:\s*"([a-z_]+)"/g)) emitted.add(m[1]);
    }
    const bridgeEvents = new Set(["capabilities", "session_switched", "session_list", "session_history", "user_message"]);
    const handled = new Set([...app.matchAll(/case\s+'([a-z_]+)':/g)].map(m => m[1]));
    const untyped = [...emitted].filter(t => !union.has(t));
    const unhandled = [...emitted, ...bridgeEvents].filter(t => !handled.has(t));
    assert(untyped.length === 0 && unhandled.length === 0,
      `adapter emits outside the union: [${untyped}]; events no frontend case handles: [${unhandled}]`);
  });

  // C6: no password material in any served asset.
  run("security: no hardcoded password in assets", () => {
    for (const f of ["app.js", "markdown.js", "index.html", "style.css"]) {
      assert(!/"password"\s*===|value === '\d{4}'/.test(file(f)), `${f} contains a password comparison`);
    }
  });

  // C2: the bridge must route every script/style index.html references
  // (markdown.js was once served by test copies but not production).
  run("assets: bridge routes everything index.html references", () => {
    const html = file("index.html");
    const bridge = file("agent-bridge.ts");
    const refs = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map(m => m[1]);
    const missing = refs.filter(r => !bridge.includes(`"/${r}"`));
    assert(missing.length === 0, `bridge has no route for: ${missing.join(", ")}`);
  });

  return { passed, failed };
}
