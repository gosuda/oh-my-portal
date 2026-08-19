// Simple adapter — runs any CLI agent via subprocess and returns full output.
// Works with every agent but without streaming, tool cards, or session commands.
// Use this as the universal fallback; upgrade to a native adapter when available.

import type { AgentAdapter, AgentEvent } from "./types";
import { NO_CAPS } from "./types";

export class SimpleAdapter implements AgentAdapter {
  readonly name = "simple";
  readonly capabilities = { ...NO_CAPS };
  private proc: ChildProcess | null = null;
  private callback: ((e: AgentEvent) => void) | null = null;
  private command: string;

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
    this.proc = spawn(this.command, ["-p", text], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
    });

    let output = "";
    this.proc.stdout!.on("data", (c: Buffer) => {
      output += c.toString("utf-8");
    });

    this.proc.on("close", (code) => {
      this.emit({ type: "text_delta", content: output });
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
