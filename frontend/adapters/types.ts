// Universal agent event types — the contract between adapters and the bridge.
// The frontend consumes these; adapters produce them.

export interface AgentEvent {
  type:
    | "text_delta"
    | "thinking_delta"
    | "tool_start"
    | "tool_end"
    | "agent_start"
    | "agent_end"
    | "agent_ready"
    | "agent_exited"
    | "state_update"
    | "command_output"
    | "command_result"
    | "model_list"
    | "prompt_error"
    | "notice";
  models?: Array<{ provider: string; id: string }>;
  content?: string;
  name?: string;
  params?: Record<string, unknown>;
  result?: string;
  from?: string;
  model?: { provider: string; id: string };
  contextUsage?: { tokens: number; contextWindow: number; percent: number };
  error?: string;
  code?: number;
}

export interface AgentAdapter {
  readonly name: string;
  /** Start the agent process or connection. Called once on first client. */
  start(): void;
  /** Send a prompt (or slash command) to the agent. */
  prompt(text: string): void;
  /** Abort the current agent turn. */
  abort(): void;
  /** Request current state (model, context usage). */
  pollState(): void;
  /** List available models (optional — adapters without it skip the picker). */
  listModels?(): void;
  onEvent(callback: (event: AgentEvent) => void): void;
  /** Clean shutdown. */
  stop(): void;
}

export type AdapterFactory = (command: string) => AgentAdapter;
