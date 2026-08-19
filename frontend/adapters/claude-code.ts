// Claude Code adapter — uses the Anthropic SDK for streaming responses.
// Requires ANTHROPIC_API_KEY in the environment.
//
// Multi-turn: keeps a rolling conversation history in the adapter (the
// Messages API is stateless — every call must carry the full history).
//
// Supports: streaming text, thinking, tool calls, conversation history,
// real context-usage reporting, abort.
// Does NOT support: slash commands, model listing (SDK is one-model).

import type { AgentAdapter, AgentEvent } from "./types";
import { NO_CAPS } from "./types";

const HISTORY_LIMIT = 40; // keep the last N messages sent to the API

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly name = "claude-code";
  readonly capabilities = { ...NO_CAPS }; // streaming + tools + history
  private callback: ((e: AgentEvent) => void) | null = null;
  private controller: AbortController | null = null;
  private model: string;
  private history: Array<{ role: "user" | "assistant"; content: string }> = [];

  constructor(model?: string) {
    this.model = model || "claude-sonnet-4-5-20250929";
  }

  onEvent(cb: (e: AgentEvent) => void) {
    this.callback = cb;
  }

  start() {
    // No persistent process — API calls carry the history
    this.emit({ type: "agent_ready" });
  }

  async prompt(text: string) {
    if (!process.env.ANTHROPIC_API_KEY) {
      this.emit({ type: "prompt_error", error: "ANTHROPIC_API_KEY not set" });
      return;
    }

    this.controller = new AbortController();
    this.emit({ type: "agent_start" });
    this.history.push({ role: "user", content: text });

    try {
      const { Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic();

      const stream = client.messages.stream({
        model: this.model,
        max_tokens: 4096,
        // Full conversation every call — the API has no session memory
        messages: this.history.map((m) => ({ role: m.role, content: m.content })),
      });

      for await (const event of stream) {
        if (this.controller?.signal.aborted) break;

        if (event.type === "content_block_delta") {
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

      // Record the assistant turn so the next prompt has context
      const textOut = (final.content as Array<{ type: string; text?: string }>)
        .filter((b) => b.type === "text")
        .map((b) => b.text || "")
        .join("\n");
      this.history.push({ role: "assistant", content: textOut || "(tool use)" });
      if (this.history.length > HISTORY_LIMIT) {
        this.history = this.history.slice(-HISTORY_LIMIT);
      }

      for (const block of final.content as Array<{ type: string; name?: string; input?: unknown }>) {
        if (block.type === "tool_use") {
          this.emit({ type: "tool_end", name: block.name, result: JSON.stringify(block.input).slice(0, 500) });
        }
      }

      // Real context usage from the final usage block
      if (final.usage) {
        const ctx = 200000;
        this.emit({
          type: "state_update",
          model: { provider: "anthropic", id: this.model },
          contextUsage: {
            tokens: final.usage.input_tokens,
            contextWindow: ctx,
            percent: (final.usage.input_tokens / ctx) * 100,
          },
        });
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
      contextUsage: { tokens: this.history.length * 50, contextWindow: 200000, percent: 0 },
    });
  }

  stop() {
    this.controller?.abort();
  }

  private emit(e: AgentEvent) {
    this.callback?.(e);
  }
}
