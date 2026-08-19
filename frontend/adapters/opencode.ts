// opencode adapter — connects to opencode serve HTTP API.
// Supports: streaming, native web UI capabilities, model selection.
// Requires: opencode serve running on localhost (or accessible URL).

import type { AgentAdapter, AgentEvent } from "./types";

export class OpencodeAdapter implements AgentAdapter {
  readonly name = "opencode";
  private callback: ((e: AgentEvent) => void) | null = null;
  private baseUrl: string;
  private controller: AbortController | null = null;
  private sessionId: string | null = null;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || "http://127.0.0.1:4096";
  }

  onEvent(cb: (e: AgentEvent) => void) {
    this.callback = cb;
  }

  async start() {
    try {
      // Create a session
      const res = await fetch(this.baseUrl + "/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        const data = await res.json();
        if (data && typeof data === "object" && "id" in data) {
          this.sessionId = String((data as Record<string, unknown>).id);
        }
        this.emit({ type: "agent_ready" });
      } else {
        this.emit({ type: "prompt_error", error: `opencode serve not reachable at ${this.baseUrl}` });
      }
    } catch {
      this.emit({ type: "prompt_error", error: `opencode serve not reachable at ${this.baseUrl}` });
    }
  }

  async prompt(text: string) {
    if (!this.sessionId) {
      await this.start();
      if (!this.sessionId) return;
    }

    this.controller = new AbortController();
    this.emit({ type: "agent_start" });

    try {
      const res = await fetch(this.baseUrl + "/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionID: this.sessionId,
          messages: [{ role: "user", content: text }],
        }),
        signal: this.controller.signal,
      });

      if (!res.ok) {
        this.emit({ type: "prompt_error", error: `opencode API error: ${res.status}` });
        return;
      }

      // opencode returns SSE or JSON depending on configuration
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("text/event-stream")) {
        await this.consumeSSE(res);
      } else {
        const data = await res.json();
        if (data && typeof data === "object") {
          const content =
            "content" in data ? String((data as Record<string, unknown>).content) : JSON.stringify(data);
          this.emit({ type: "text_delta", content });
        }
        this.emit({ type: "agent_end" });
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        this.emit({ type: "agent_end" });
      } else {
        this.emit({ type: "prompt_error", error: String(err) });
      }
    } finally {
      this.controller = null;
    }
  }

  abort() {
    this.controller?.abort();
  }

  pollState() {
    this.emit({
      type: "state_update",
      model: { provider: "opencode", id: "default" },
      contextUsage: { tokens: 0, contextWindow: 200000, percent: 0 },
    });
  }

  stop() {
    this.controller?.abort();
  }

  private async consumeSSE(res: Response) {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data: ")) continue;
        try {
          const msg = JSON.parse(line.slice(6));
          if (msg.type === "message" && msg.content) {
            this.emit({ type: "text_delta", content: String(msg.content) });
          }
        } catch {
          // skip non-JSON SSE lines
        }
      }
    }
    this.emit({ type: "agent_end" });
  }

  private emit(e: AgentEvent) {
    this.callback?.(e);
  }
}
