// OMP RPC adapter — bridges omp --mode rpc JSON-RPC to universal AgentEvents.
// This is the reference adapter; others follow the same interface.

import type { AgentAdapter, AgentEvent } from "./types";
import { spawn, type ChildProcess } from "child_process";

export class OmpRpcAdapter implements AgentAdapter {
  readonly name = "omp-rpc";
  private proc: ChildProcess | null = null;
  private stdin: NodeJS.WritableStream | null = null;
  private buffer = "";
  private callback: ((e: AgentEvent) => void) | null = null;
  private command: string;

  constructor(command?: string) {
    this.command = command ?? "omp";
  }

  onEvent(cb: (e: AgentEvent) => void) {
    this.callback = cb;
  }

  start() {
    if (this.proc) return;
    this.proc = spawn(this.command, ["--mode", "rpc"], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
    });
    this.stdin = this.proc.stdin;
    this.proc.stdout!.on("data", (chunk: Buffer) => this.onStdout(chunk));
    this.proc.on("exit", (code) => {
      this.proc = null;
      this.stdin = null;
      this.emit({ type: "agent_exited", code: code ?? 0 });
    });
  }

  prompt(text: string) {
    this.write({ id: `p-${Date.now()}`, type: "prompt", message: text });
  }

  abort() {
    this.write({ id: `a-${Date.now()}`, type: "abort" });
  }

  pollState() {
    this.write({ id: `s-${Date.now()}`, type: "get_state" });
  }

  listModels() {
    this.write({ id: `m-${Date.now()}`, type: "get_available_models" });
  }
  
  stop() {
    this.proc?.kill();
    this.proc = null;
    this.stdin = null;
  }

  // ── Internal ─────────────────────────────────────────────────────

  private write(obj: Record<string, unknown>) {
    if (!this.stdin) this.start();
    this.stdin?.write(JSON.stringify(obj) + "\n");
  }

  private emit(e: AgentEvent) {
    this.callback?.(e);
  }

  private onStdout(chunk: Buffer) {
    this.buffer += chunk.toString("utf-8");
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      try {
        this.translate(JSON.parse(line));
      } catch {
        // non-JSON line, skip
      }
    }
  }

  private translate(msg: Record<string, unknown>) {
    const m = msg as Record<string, unknown> & {
      type?: string;
      assistantMessageEvent?: { type?: string; delta?: string };
      data?: Record<string, unknown>;
      success?: boolean;
      command?: string;
      error?: string;
      toolName?: string;
      result?: { content?: unknown };
    };

    switch (m.type) {
      case "ready":
        this.emit({ type: "agent_ready" });
        setTimeout(() => this.pollState(), 300);
        break;

      case "agent_start":
        this.emit({ type: "agent_start" });
        break;

      case "agent_end":
        this.emit({ type: "agent_end" });
        this.pollState();
        break;

      case "message_update": {
        const e = m.assistantMessageEvent;
        if (!e) break;
        if (e.type === "text_delta" && e.delta) {
          this.emit({ type: "text_delta", content: e.delta });
        } else if (e.type === "thinking_delta" && e.delta) {
          this.emit({ type: "thinking_delta", content: e.delta });
        }
        break;
      }

      case "tool_execution_start":
        this.emit({ type: "tool_start", name: m.toolName || "tool", params: m.input || {} });
        break;

      case "tool_execution_end":
        this.emit({
          type: "tool_end",
          name: m.toolName || "tool",
          result: this.summarize(m.result),
        });
        break;

      case "command_output":
        this.emit({
          type: "command_output",
          content: (m.content as string) || (m.output as string) || "",
        });
        break;

      case "response":
        if (m.command === "prompt") {
          if (m.success) {
            this.emit({ type: "prompt_accepted" });
            const data = m.data as { agentInvoked?: boolean } | undefined;
            if (data?.agentInvoked === false) {
              this.emit({ type: "command_result" });
              // Slash command may have changed model/compact state — refresh footer
              this.pollState();
            }
          } else {
            this.emit({ type: "prompt_error", error: m.error || "prompt failed" });
          }
        } else if (m.command === "get_state" && m.success) {
          const d = m.data as {
            model?: { provider: string; id: string };
            contextUsage?: { tokens: number; contextWindow: number; percent: number };
          } | undefined;
          if (d) {
            this.emit({ type: "state_update", model: d.model, contextUsage: d.contextUsage });
          }
        } else if (m.command === "get_available_models" && m.success) {
          const d = m.data as { models?: Array<{ provider: string; id: string }> } | undefined;
          this.emit({ type: "model_list", models: d?.models || [] } as AgentEvent & { models: unknown[] });
        }
        break;

      case "notice":
        this.emit({ type: "notice", content: (m as { message?: string }).message || "" });
        break;
    }
  }

  private summarize(result: unknown): string {
    if (!result || typeof result !== "object") return "";
    const r = result as { content?: unknown; error?: string };
    if (r.error) return "Error: " + r.error;
    if (Array.isArray(r.content)) {
      return (r.content as { type?: string; text?: string }[])
        .filter((c) => c.type === "text")
        .map((c) => c.text || "")
        .join("\n")
        .slice(0, 2000);
    }
    if (typeof r.content === "string") return r.content.slice(0, 2000);
    return JSON.stringify(result).slice(0, 500);
  }
}
