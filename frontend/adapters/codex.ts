// OpenAI Codex adapter — uses the OpenAI SDK for streaming responses.
// Requires OPENAI_API_KEY in the environment.
//
// Multi-turn: keeps a rolling conversation history in the adapter (the
// Chat Completions API is stateless — every call must carry the history).
//
// Supports: streaming text, tool calls, conversation history, abort.
// Does NOT support: slash commands, thinking, model listing.

import type { AgentAdapter, AgentEvent } from "./types";
import { NO_CAPS } from "./types";

const HISTORY_LIMIT = 40; // keep the last N messages sent to the API

export class CodexAdapter implements AgentAdapter {
  readonly name = "codex";
  readonly capabilities = { ...NO_CAPS }; // streaming + tool calls + history
  private callback: ((e: AgentEvent) => void) | null = null;
  private controller: AbortController | null = null;
  private model: string;
  private history: Array<{ role: "user" | "assistant"; content: string }> = [];

  constructor(model?: string) {
    this.model = model || "gpt-4o";
  }

  onEvent(cb: (e: AgentEvent) => void) {
    this.callback = cb;
  }

  start() {
    this.emit({ type: "agent_ready" });
  }

  async prompt(text: string) {
    if (!process.env.OPENAI_API_KEY) {
      this.emit({ type: "prompt_error", error: "OPENAI_API_KEY not set" });
      return;
    }

    this.controller = new AbortController();
    this.emit({ type: "agent_start" });
    this.history.push({ role: "user", content: text });

    try {
      // Dynamic import: SDK is optional — only loaded when this adapter is selected
      const { default: OpenAI } = await import("openai");
      const client = new OpenAI();

      const stream = await client.chat.completions.create(
        {
          model: this.model,
          // Full conversation every call — the API has no session memory
          messages: this.history.map((m) => ({ role: m.role, content: m.content })),
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: this.controller.signal }
      );

      let textOut = "";
      let usage: { prompt_tokens?: number } | null = null;

      for await (const chunk of stream) {
        const choice = chunk.choices?.[0];
        if (chunk.usage) usage = chunk.usage;
        if (!choice?.delta) continue;
        if (choice.delta.content) {
          textOut += choice.delta.content;
          this.emit({ type: "text_delta", content: choice.delta.content });
        }
        if (choice.delta.tool_calls) {
          for (const tc of choice.delta.tool_calls) {
            if (tc.function?.name) {
              this.emit({ type: "tool_start", name: tc.function.name });
              this.emit({ type: "tool_end", name: tc.function.name, result: tc.function.arguments?.slice(0, 500) || "" });
            }
          }
        }
      }

      // Record the assistant turn so the next prompt has context
      this.history.push({ role: "assistant", content: textOut || "(tool call)" });
      if (this.history.length > HISTORY_LIMIT) {
        this.history = this.history.slice(-HISTORY_LIMIT);
      }

      if (usage?.prompt_tokens) {
        const ctx = 128000;
        this.emit({
          type: "state_update",
          model: { provider: "openai", id: this.model },
          contextUsage: {
            tokens: usage.prompt_tokens,
            contextWindow: ctx,
            percent: (usage.prompt_tokens / ctx) * 100,
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
      model: { provider: "openai", id: this.model },
      contextUsage: { tokens: this.history.length * 50, contextWindow: 128000, percent: 0 },
    });
  }

  stop() {
    this.controller?.abort();
  }

  private emit(e: AgentEvent) {
    this.callback?.(e);
  }
}
