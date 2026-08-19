// Universal agent event types — the contract between adapters and the bridge.
// The frontend consumes these; adapters produce them.

export interface AgentEvent {
  type:
    | "text_delta"
    | "thinking_delta"
    | "tool_start"
    | "tool_params"
    | "tool_end"
    | "agent_start"
    | "agent_end"
    | "agent_ready"
    | "agent_exited"
    | "agent_error"
    | "prompt_accepted"
    | "command_result"
    | "state_update"
    | "command_output"
    | "model_list"
    | "subagent_update"
    | "subagent_lifecycle"
    | "subagent_transcript"
    | "cost_update"
    | "prompt_error"
    | "notice";
  content?: string;
  name?: string;
  params?: Record<string, unknown>;
  result?: string;
  from?: string;
  model?: { provider: string; id: string; thinking?: { efforts?: string[] } };
  thinkingLevel?: string;
  models?: Array<{ provider: string; id: string }>;
  subagents?: SubagentProgress[];
  subagentId?: string;
  status?: string;
  sessionFile?: string;
  transcript?: SubagentMessage[];
  nextByte?: number;
  cost?: number;
}

export interface SubagentMessage {
  role: string;
  content?: Array<{ type?: string; text?: string; name?: string; thinking?: string }>;
}

export interface SubagentProgress {
  id: string;
  agent: string;
  agentSource?: string;
  modelRole?: string;
  status: string;
  task?: string;
  recentTools?: string[];
  recentOutput?: string[];
  toolCount?: number;
  requests?: number;
  tokens?: number;
  cost?: number;
  durationMs?: number;
}

// What an adapter can actually do. The bridge forwards this to the
// frontend, which shows/hides features accordingly — OMP gets the full
// UI, other agents get the parts they support.
export interface AdapterCapabilities {
  /** listModels() + model_list events → model picker */
  models: boolean;
  /** thinking-level control → /thinking picker */
  thinking: boolean;
  /** subagent progress events → Agent Hub */
  subagents: boolean;
  /** subagent transcript fetching → ▤ buttons */
  transcripts: boolean;
  /** cost_update events → cost footer */
  cost: boolean;
  /** adapter-provided slash-command autocomplete */
  commands: boolean;
  /** mid-turn interrupt */
  abort: boolean;
}

export interface CommandDef {
  cmd: string;
  desc: string;
}

const NO_CAPS: AdapterCapabilities = {
  models: false, thinking: false, subagents: false,
  transcripts: false, cost: false, commands: false, abort: true,
};
export { NO_CAPS };

export interface AgentAdapter {
  readonly name: string;
  /** Feature negotiation — what this adapter supports. */
  readonly capabilities: AdapterCapabilities;
  start(): void;
  /** Send a prompt (or slash command) to the agent. */
  prompt(text: string): void;
  /** List available models (optional — adapters without it skip the picker). */
  listModels?(): void;
  /** Fetch a subagent transcript (optional). */
  getSubagentMessages?(subagentId: string, sessionFile: string, fromByte?: number): void;
  /** Adapter-specific slash commands for autocomplete (optional). */
  commands?(): CommandDef[];
  pollState(): void;
  onEvent(callback: (event: AgentEvent) => void): void;
  /** Clean shutdown. */
  stop(): void;
}

export type AdapterFactory = (command: string) => AgentAdapter;
