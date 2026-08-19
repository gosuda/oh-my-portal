// Simple adapter — runs any CLI agent via subprocess and streams stdout.
// Works with every agent but without tool cards, slash commands, or
// subagent events. Conversation state depends on the CLI itself:
// agents that keep their own session (e.g. `claude -p --continue`)
// stay multi-turn; stateless CLIs reset each prompt.
// Use this as the universal fallback; upgrade to a native adapter when available.

import type { AgentAdapter, AgentEvent } from "./types";
import { NO_CAPS } from "./types";
import { spawn, type ChildProcess } from "child_process";

export class SimpleAdapter implements AgentAdapter {
  readonly name = "simple";
  readonly capabilities = { ...NO_CAPS };
  private proc: ChildProcess | null = null;
  private callback: ((e: AgentEvent) => void) | null = null;
  private command: string;
  private output = "";

  constructor(command: string) {
    this.command = command;
  }

  onEvent(cb: (e: AgentEvent) => void) {
    this.callback = cb;
  }

  start() {
    // No persistent process — each prompt spawns fresh
  }

  prompt(text: string) {
    this.emit({ type: "agent_start" });
    this.output = "";
    this.proc = spawn(this.command, ["-p", text], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
    });

    // Stream line-by-line instead of buffering the whole output
    let buf = "";
    this.proc.stdout!.on("data", (c: Buffer) => {
      buf += c.toString("utf-8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl + 1);
        buf = buf.slice(nl + 1);
        this.output += line;
        this.emit({ type: "text_delta", content: line });
      }
    });
    // Surface stderr as an error card when the process fails
    let errBuf = "";
    this.proc.stderr!.on("data", (c: Buffer) => { errBuf += c.toString("utf-8"); });

    this.proc.on("close", (code) => {
      if (buf) { this.output += buf; this.emit({ type: "text_delta", content: buf }); }
      if (code !== 0 && code !== null && errBuf.trim()) {
        this.emit({ type: "agent_error", error: errBuf.trim().slice(0, 4000) });
      }
      this.emit({ type: "agent_end" });
      this.proc = null;
    });
  }

  abort() {
    this.proc?.kill();
    this.proc = null;
    this.emit({ type: "agent_end" });
  }

  pollState() {
    // Not supported in simple mode
  }

  stop() {
    this.proc?.kill();
    this.proc = null;
  }

  private emit(e: AgentEvent) {
    this.callback?.(e);
  }
}
