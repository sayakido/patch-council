const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const sessionRoot = path.join(root, "mock-sessions");

function writeSession(sessionId, state, events) {
  const dir = path.join(sessionRoot, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(dir, "transcript.jsonl"), events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
}

function baseEvent(seq, type, phase = "discussion") {
  return {
    schema_version: 1,
    seq,
    type,
    phase,
    session_id: "mock-council-001",
  };
}

const startedAt = "2026-05-27T10:00:00+08:00";
const finishedAt = "2026-05-27T10:03:12+08:00";

const events = [
  {
    ...baseEvent(0, "session_started"),
    started_at: startedAt,
    topic: "下一步应该优先改进 PatchCouncil 的什么？",
    mode: "council",
    config: {
      max_turns: 3,
      min_distinct_agents: 2,
      max_context_chars: 2500,
      max_transcript_chars: 2500,
      max_message_chars: 800,
    },
    capabilities: {
      can_execute: false,
      requires_user_confirmation_before_write: true,
    },
    agents: [
      { id: "codex", command: "codex", roles: ["coordinator", "agent"] },
      { id: "opencode", command: "opencode", roles: ["agent"] },
    ],
  },
  {
    ...baseEvent(1, "coordinator_turn_started"),
    turn: 0,
    coordinator: "codex",
    purpose: "route",
  },
  {
    ...baseEvent(2, "coordinator_decided"),
    turn: 0,
    coordinator: "codex",
    decision: "continue",
    next_agent: "codex",
    role: "先建立问题框架",
    reason: "用户的问题是方向判断，先需要结构化拆解。",
  },
  {
    ...baseEvent(3, "coordinator_turn_completed"),
    turn: 0,
    coordinator: "codex",
    purpose: "route",
    status: "ok",
    duration_ms: 4300,
  },
  {
    ...baseEvent(4, "agent_turn_started"),
    turn: 1,
    agent: "codex",
    role: "先建立问题框架",
    selected_by: "coordinator",
    selection_reason: "需要先说明 CLI 黑箱和 UI 观察台之间的取舍。",
  },
  {
    ...baseEvent(5, "agent_turn_completed"),
    turn: 1,
    agent: "codex",
    content: "我的判断是：不要在 CLI 上做复杂渲染。真正有价值的是事件管线和可视化 UI。CLI 应该只是启动、调试和自动化入口。",
    content_length: 61,
    duration_ms: 12800,
  },
  {
    ...baseEvent(6, "coordinator_turn_started"),
    turn: 1,
    coordinator: "codex",
    purpose: "decide",
  },
  {
    ...baseEvent(7, "coordinator_decided"),
    turn: 1,
    coordinator: "codex",
    decision: "finalize",
    reason: "Codex 已经给出方向，用户要求简短。",
  },
  {
    ...baseEvent(8, "coordinator_turn_completed"),
    turn: 1,
    coordinator: "codex",
    purpose: "decide",
    status: "ok",
    duration_ms: 3600,
  },
  {
    ...baseEvent(9, "policy_override"),
    turn: 1,
    policy: "min_distinct_agents",
    original_decision: "finalize",
    new_decision: "continue",
    selected_agent: "opencode",
    reason: "min_distinct_agents=2 未满足，且尚未达到 max_turns。",
  },
  {
    ...baseEvent(10, "agent_turn_started"),
    turn: 2,
    agent: "opencode",
    role: "从实现可行性角度挑战方案",
    selected_by: "policy",
    selection_reason: "策略要求至少两个不同 agent 参与。",
  },
  {
    ...baseEvent(11, "agent_turn_completed"),
    turn: 2,
    agent: "opencode",
    content: "我赞成先做 UI spike，但建议用 mock events，不要马上接真实 CLI。这样可以先验证 timeline、状态面板和事件 schema 是否好用。",
    content_length: 63,
    duration_ms: 15400,
  },
  {
    ...baseEvent(12, "finalization_started"),
    turn_count: 2,
  },
  {
    ...baseEvent(13, "finalized"),
    summary: "下一步先做 Node/TypeScript UI spike，用 mock council events 验证可视化体验；真实 runtime integration 留到 checkpoint 后决定。",
    next_steps: [
      "定义 TypeScript 事件类型",
      "生成 mock session",
      "实现 session list、timeline 和 work/status panel",
      "checkpoint 后决定 Node 全栈或 Python engine + Node UI",
    ],
  },
  {
    ...baseEvent(14, "session_finished", "finalized"),
    finished_at: finishedAt,
    outcome: "discussion_only",
    duration_ms: 192000,
    turn_count: 2,
    distinct_agents: ["codex", "opencode"],
    error_count: 0,
  },
];

const state = {
  session_id: "mock-council-001",
  status: "done",
  phase: "finalized",
  topic: "下一步应该优先改进 PatchCouncil 的什么？",
  started_at: startedAt,
  finished_at: finishedAt,
  turn_count: 2,
  distinct_agents: ["codex", "opencode"],
  last_seq: 14,
  outcome: "discussion_only",
  error_count: 0,
};

writeSession("mock-council-001", state, events);
console.log(`wrote mock session ${path.join(sessionRoot, "mock-council-001")}`);

// --- Design council mock session ---
const dcEvents = [
  {
    ...baseEvent(0, "session_started", "brainstorming"),
    started_at: "2026-06-01T10:00:00+08:00",
    topic: "为 PatchCouncil 设计新的事件管线",
    mode: "design_council",
    config: {},
    capabilities: {},
    agents: [
      { id: "codex", command: "codex", roles: ["coordinator", "agent"] },
      { id: "claude", command: "claude", roles: ["agent"] },
    ],
  },
  {
    ...baseEvent(1, "brainstorming_started", "brainstorming"),
    lead_agent: "codex",
    skill_id: "brainstorming_prelude",
    max_questions: 8,
  },
  {
    ...baseEvent(2, "brainstorming_question_created", "brainstorming"),
    question_seq: 1,
    agent: "codex",
    question: "事件管线的主要使用者是 CLI 还是 Web UI？",
    reason: "需要确定目标用户。",
    known_context: [],
    missing_context: ["目标用户"],
  },
  {
    ...baseEvent(3, "brainstorming_answer_received", "brainstorming"),
    question_seq: 1,
    content: "Web UI 是主要交互界面，CLI 用于自动化。",
  },
  {
    ...baseEvent(4, "brainstorming_question_created", "brainstorming"),
    question_seq: 2,
    agent: "codex",
    question: "需要支持实时推送还是轮询即可？",
    reason: "影响架构选择。",
    known_context: ["Web UI 是主要交互界面"],
    missing_context: ["实时性需求"],
  },
  {
    ...baseEvent(5, "brainstorming_answer_received", "brainstorming"),
    question_seq: 2,
    content: "轮询足够，不需要 WebSocket。",
  },
  {
    ...baseEvent(6, "design_file_written", "brainstorming"),
    artifact_path: "docs/designs/2026-06-01-event-pipeline.md",
    generator: "codex",
    title: "为 PatchCouncil 设计新的事件管线",
    revision: 0,
  },
  {
    ...baseEvent(7, "design_commit_created", "brainstorming"),
    artifact_path: "docs/designs/2026-06-01-event-pipeline.md",
    commit: "abc1234",
    commit_message: "docs: draft event-pipeline design",
  },
  {
    ...baseEvent(8, "phase_transition", "brainstorming"),
    from: "brainstorming",
    to: "discussion",
    trigger: "design_commit_created",
    reason: "Design draft committed; entering council review.",
  },
  {
    ...baseEvent(9, "coordinator_turn_started", "discussion"),
    turn: 0,
    coordinator: "codex",
    purpose: "route",
  },
  {
    ...baseEvent(10, "coordinator_decided", "discussion"),
    turn: 0,
    coordinator: "codex",
    decision: "continue",
    next_agent: "claude",
    role: "reviewer",
    reason: "review committed design",
  },
  {
    ...baseEvent(11, "agent_turn_started", "discussion"),
    turn: 1,
    agent: "claude",
    role: "reviewer",
    selected_by: "coordinator",
  },
  {
    ...baseEvent(12, "agent_turn_completed", "discussion"),
    turn: 1,
    agent: "claude",
    content: "事件管线设计方向正确，但缺少错误处理流程和重试机制。",
    signal: {
      stance: "mixed",
      confidence: "medium",
      finalize_readiness: "not_ready",
      blockers: [{ type: "issue", text: "Need error handling flow." }],
      agreements: ["Event schema is clean."],
      disagreements: ["Missing error handling."],
      recommended_next_step: "revise design with error handling",
    },
  },
  {
    ...baseEvent(13, "design_revision_written", "discussion"),
    artifact_path: "docs/designs/2026-06-01-event-pipeline.md",
    source_commit: "abc1234",
    source_review_seq: 12,
    generator: "codex",
    revision: 1,
  },
  {
    ...baseEvent(14, "design_revision_committed", "discussion"),
    artifact_path: "docs/designs/2026-06-01-event-pipeline.md",
    source_commit: "abc1234",
    commit: "def5678",
    commit_message: "docs: revise event-pipeline design",
  },
  {
    ...baseEvent(15, "finalization_started", "discussion"),
    turn_count: 1,
  },
  {
    ...baseEvent(16, "finalized", "discussion"),
    summary: "事件管线设计审查完成。核心决策：使用 JSONL 事件流 + 轮询，支持 schema 版本化。",
    next_steps: ["generate workplan", "实现事件管线"],
  },
  {
    ...baseEvent(17, "session_finished", "finalized"),
    finished_at: "2026-06-01T10:15:00+08:00",
    outcome: "discussion_only",
    duration_ms: 900000,
    turn_count: 1,
    distinct_agents: ["claude"],
    error_count: 0,
  },
];

const dcState = {
  session_id: "mock-design-council-002",
  status: "done",
  phase: "finalized",
  topic: "为 PatchCouncil 设计新的事件管线",
  started_at: "2026-06-01T10:00:00+08:00",
  finished_at: "2026-06-01T10:15:00+08:00",
  turn_count: 1,
  distinct_agents: ["claude"],
  last_seq: 17,
  outcome: "discussion_only",
  error_count: 0,
  waiting_for: null,
  brainstorming: {
    question_count: 2,
    lead_agent: "codex",
  },
  design: {
    artifact_path: "docs/designs/2026-06-01-event-pipeline.md",
    draft_commit: "abc1234",
    latest_commit: "def5678",
    status: "revision_committed",
  },
};

writeSession("mock-design-council-002", dcState, dcEvents);
console.log(`wrote mock session ${path.join(sessionRoot, "mock-design-council-002")}`);
