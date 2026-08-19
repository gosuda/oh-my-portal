// OpenAI Codex adapter — uses the OpenAI SDK for streaming responses.
// Requires OPENAI_API_KEY in the environment.
//
// Supports: streaming text, tool calls.
// Does NOT support: slash commands, compact.

import type { AgentAdapter, AgentEvent } from "./types";
import { NO_CAPS } from "./types";

export class CodexAdapter implements AgentAdapter {
  readonly name = "codex";
  readonly capabilities = { ...NO_CAPS }; // streaming + tool calls only
  private callback: ((e: AgentEvent) => void) | null = null;
  private controller: AbortController | null = null;
  private model: string;

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

    try {
      // Dynamic import: SDK is optional — only loaded when this adapter is selected
      const { default: OpenAI } = await import("openai");
      const client = new OpenAI();

      const stream = await client.chat.completions.create(
        {
          model: this.model,
          messages: [{ role: "user", content: text }],
          stream: true,
        },
        { signal: this.controller.signal }
      );

      for await (const chunk of stream) {
        const choice = chunk.choices?.[0];
        if (!choice?.delta) continue;
        if (choice.delta.content) {
          this.emit({ type: "text_delta", content: choice.delta.content });
        }
        if (choice.delta.tool_calls) {
          for (const tc of choice.delta.tool_calls) {
            if (tc.function?.name) {
              this.emit({ type: "tool_start", name: tc.function.name });
            }
          }
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
      model: { provider: "openai", id: this.model },
      contextUsage: { tokens: 0, contextWindow: 128000, percent: 0 },
    });
  }

  stop() {
    this.controller?.abort();
  }

  private emit(e: AgentEvent) {
    this.callback?.(e);
  }
}
