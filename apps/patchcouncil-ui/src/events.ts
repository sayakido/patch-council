export type Phase =
  | "discussion"
  | "task_assignment"
  | "execution"
  | "review"
  | "finalized";

export type SessionStatus = "running" | "done" | "error" | "cancelled";

export type RuntimeEvent =
  | RuntimeTurnStarted
  | RuntimeReplyDelta
  | RuntimeReplyCompleted
  | RuntimeTurnCompleted
  | RuntimeTurnFailed
  | RuntimeApprovalRequested
  | RuntimeContextUpdated;

export interface RuntimeTurnStarted {
  type: "runtime.turn.started";
  runtime: string;
  thread_id: string;
  turn_id: string;
}

export interface RuntimeReplyDelta {
  type: "runtime.reply.delta";
  runtime: string;
  thread_id: string;
  turn_id: string;
  text: string;
}

export interface RuntimeReplyCompleted {
  type: "runtime.reply.completed";
  runtime: string;
  thread_id: string;
  turn_id: string;
  item_id?: string;
  text: string;
}

export interface RuntimeTurnCompleted {
  type: "runtime.turn.completed";
  runtime: string;
  thread_id: string;
  turn_id: string;
}

export interface RuntimeTurnFailed {
  type: "runtime.turn.failed";
  runtime: string;
  thread_id: string;
  turn_id?: string;
  message: string;
}

export interface RuntimeApprovalRequested {
  type: "runtime.approval.requested";
  runtime: string;
  thread_id: string;
  turn_id?: string;
  request_id: string;
  kind: "command" | "mcp_tool_call" | "mcp_elicitation";
  reason: string;
  command: string;
  file_paths: string[];
  response_template?: {
    supported_commands: string[];
  };
}

export interface RuntimeContextUpdated {
  type: "runtime.context.updated";
  runtime: string;
  thread_id: string;
  input_tokens?: number;
  output_tokens?: number;
  current_tokens?: number;
  context_window?: number;
}

export type CouncilEvent =
  | SessionStarted
  | PhaseTransition
  | CoordinatorTurnStarted
  | CoordinatorDecided
  | CoordinatorTurnCompleted
  | PolicyOverride
  | AgentTurnStarted
  | AgentTurnCompleted
  | FinalizationStarted
  | Finalized
  | SessionFinished
  | AgentError
  | CoordinatorError
  | SessionError;

export interface CouncilEventBase {
  schema_version: 1;
  seq: number;
  type: string;
  phase: Phase;
  session_id: string;
}

export interface SessionStarted extends CouncilEventBase {
  type: "session_started";
  seq: 0;
  started_at: string;
  topic: string;
  mode: "council" | "orchestrate";
  config: Record<string, unknown>;
  capabilities: {
    can_execute: boolean;
    requires_user_confirmation_before_write: boolean;
  };
  agents: Array<{
    id: string;
    command: string;
    roles: string[];
  }>;
}

export interface PhaseTransition extends CouncilEventBase {
  type: "phase_transition";
  from: Phase;
  to: Phase;
  trigger: "coordinator" | "policy" | "user" | "system";
  reason: string;
}

export interface CoordinatorTurnStarted extends CouncilEventBase {
  type: "coordinator_turn_started";
  turn: number;
  coordinator: string;
  purpose: "route" | "decide" | "finalize";
}

export interface CoordinatorDecided extends CouncilEventBase {
  type: "coordinator_decided";
  turn: number;
  coordinator: string;
  decision: "continue" | "finalize" | "abort";
  next_agent?: string;
  role?: string;
  reason: string;
  raw_output_path?: string;
}

export interface CoordinatorTurnCompleted extends CouncilEventBase {
  type: "coordinator_turn_completed";
  turn: number;
  coordinator: string;
  purpose: "route" | "decide" | "finalize";
  status: "ok" | "error";
  duration_ms: number;
}

export interface PolicyOverride extends CouncilEventBase {
  type: "policy_override";
  turn: number;
  policy: string;
  original_decision: string;
  new_decision: string;
  selected_agent?: string;
  reason: string;
}

export interface AgentTurnStarted extends CouncilEventBase {
  type: "agent_turn_started";
  turn: number;
  agent: string;
  role: string;
  selected_by: "coordinator" | "policy" | "user";
  selection_reason: string;
}

export interface AgentTurnCompleted extends CouncilEventBase {
  type: "agent_turn_completed";
  turn: number;
  agent: string;
  content: string;
  content_length: number;
  duration_ms: number;
}

export interface FinalizationStarted extends CouncilEventBase {
  type: "finalization_started";
  turn_count: number;
}

export interface Finalized extends CouncilEventBase {
  type: "finalized";
  summary: string;
  next_steps: string[];
}

export interface SessionFinished extends CouncilEventBase {
  type: "session_finished";
  finished_at: string;
  outcome: "discussion_only" | "workplan_created" | "execution_completed" | "error" | "cancelled";
  duration_ms: number;
  turn_count: number;
  distinct_agents: string[];
  error_count: number;
}

export interface AgentError extends CouncilEventBase {
  type: "agent_error";
  turn?: number;
  agent: string;
  message: string;
  recoverable: boolean;
  action: string;
  details: Record<string, unknown>;
}

export interface CoordinatorError extends CouncilEventBase {
  type: "coordinator_error";
  turn?: number;
  message: string;
  recoverable: boolean;
  action: string;
  details: Record<string, unknown>;
}

export interface SessionError extends CouncilEventBase {
  type: "session_error";
  message: string;
  recoverable: boolean;
  action: string;
  details: Record<string, unknown>;
}

export interface SessionSnapshot {
  session_id: string;
  status: SessionStatus;
  phase: Phase;
  topic: string;
  started_at: string;
  finished_at: string | null;
  turn_count: number;
  distinct_agents: string[];
  last_seq: number;
  outcome: SessionFinished["outcome"] | null;
  error_count: number;
}
