// Claude Code adapter — uses the Anthropic SDK for streaming responses.
// Requires ANTHROPIC_API_KEY in the environment.
//
// Supports: streaming text, tool use, model selection, thinking.
// Does NOT support: slash commands (SDK doesn't process them), compact.

import type { AgentAdapter, AgentEvent } from "./types";

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly name = "claude-code";
  private callback: ((e: AgentEvent) => void) | null = null;
  private controller: AbortController | null = null;
  private model: string;

  constructor(model?: string) {
    this.model = model || "claude-sonnet-4-5-20250929";
  }

  onEvent(cb: (e: AgentEvent) => void) {
    this.callback = cb;
  }

  start() {
    // No persistent process — API calls are stateless
    this.emit({ type: "agent_ready" });
  }

  async prompt(text: string) {
    if (!process.env.ANTHROPIC_API_KEY) {
      this.emit({ type: "prompt_error", error: "ANTHROPIC_API_KEY not set" });
      return;
    }

    this.controller = new AbortController();
    this.emit({ type: "agent_start" });

    try {
      const { Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic();

      const stream = client.messages.stream({
        model: this.model,
        max_tokens: 4096,
        messages: [{ role: "user", content: text }],
      });

      for await (const event of stream) {
        if (this.controller?.signal.aborted) break;

        if (event.type === "content_block_start" && event.content_block.type === "text") {
          // Text block starting
        } else if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            this.emit({ type: "text_delta", content: event.delta.text });
          } else if (event.delta.type === "thinking_delta") {
            this.emit({ type: "thinking_delta", content: event.delta.thinking });
          }
        } else if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
          const block = event.content_block as { name?: string };
          this.emit({ type: "tool_start", name: block.name || "tool" });
        }
      }

      const final = await stream.finalMessage();
      // Emit tool results
      for (const block of final.content) {
        if (block.type === "tool_use") {
          this.emit({ type: "tool_end", name: block.name, result: JSON.stringify(block.input).slice(0, 500) });
        }
      }

      this.emit({ type: "agent_end" });
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
      model: { provider: "anthropic", id: this.model },
      contextUsage: { tokens: 0, contextWindow: 200000, percent: 0 },
    });
  }

  stop() {
    this.controller?.abort();
  }

  private emit(e: AgentEvent) {
    this.callback?.(e);
  }
}
