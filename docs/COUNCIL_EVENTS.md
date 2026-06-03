# Council 事件模型

这个文件定义 council session 的事件日志设计。它是后续实现可视化 UI、session replay 和执行编排扩展的基础。

## 设计目标

Council 的核心价值不是只产出最终答案，而是让用户看到多个 AI 如何讨论、分歧、被策略约束，并最终收束。

事件模型要同时支持：

- 可视化 UI 渲染；
- 最小 CLI 调试输出；
- session replay；
- 可靠调试和审计；
- 未来从只读讨论扩展到任务分配和执行编排。

## 核心规则

```text
transcript.jsonl 是唯一权威事件日志。
state.json 是从事件流派生的当前状态快照。
transcript.md 是从事件流渲染的人类可读视图。
```

含义：

- 任何重要业务事实都必须能从 `transcript.jsonl` 重建。
- `state.json` 可以删除后重建，不能保存无法从事件流推导的独立状态。
- `transcript.md` 不应和事件流并行维护，而应由事件流生成。
- `agent_turn_completed` 默认落盘，并携带完整 agent 回复内容。

## 双层事件模型

事件分为两层：

```text
runtime events：adapter 层，描述某个 AI CLI 实际运行发生了什么。
council events：orchestrator / 产品层，描述 council 语义发生了什么。
```

推荐流向：

```text
Codex / Claude 原始输出
-> runtime adapter
-> runtime events
-> council orchestrator
-> council events
-> transcript.jsonl / state.json / Web Workbench
```

不要把不同 CLI 的原始输出格式直接暴露成 council event。底层差异应先由 runtime adapter 归一化。

`runtime.reply.delta` 这类流式增量属于 runtime 层，不属于 council 核心语义。UI 可以用它显示实时文本，但持久化 council log 应以 `agent_turn_completed.content` 作为完整回复事实来源。

## Runtime Events

Runtime events 是 adapter 输出。它们可以被 UI 临时消费，也可以在 debug 模式下持久化，但默认不应全部写入 council 的 `transcript.jsonl`。

第一版建议 runtime event 集合：

```text
runtime.turn.started
runtime.reply.delta
runtime.reply.completed
runtime.turn.completed
runtime.turn.failed
runtime.approval.requested
runtime.context.updated
```

### runtime.turn.started

表示某个 AI runtime 开始一轮调用。

```json
{
  "type": "runtime.turn.started",
  "runtime": "codex",
  "thread_id": "thread-1",
  "turn_id": "turn-1"
}
```

### runtime.reply.delta

表示 runtime 回复的流式增量。它取代旧设计里的 `agent_chunk`。

```json
{
  "type": "runtime.reply.delta",
  "runtime": "codex",
  "thread_id": "thread-1",
  "turn_id": "turn-1",
  "text": "部分增量内容"
}
```

默认策略：

```text
runtime.reply.delta 用于实时 UI。
runtime.reply.delta 默认不写入 transcript.jsonl。
debug 模式可以选择持久化。
```

### runtime.reply.completed

表示 runtime 完成一条 assistant 回复。

```json
{
  "type": "runtime.reply.completed",
  "runtime": "codex",
  "thread_id": "thread-1",
  "turn_id": "turn-1",
  "item_id": "item-1",
  "text": "完整回复内容"
}
```

### runtime.turn.completed

表示 runtime turn 正常结束。

```json
{
  "type": "runtime.turn.completed",
  "runtime": "codex",
  "thread_id": "thread-1",
  "turn_id": "turn-1"
}
```

### runtime.turn.failed

表示 runtime turn 失败。

```json
{
  "type": "runtime.turn.failed",
  "runtime": "claude",
  "thread_id": "thread-1",
  "turn_id": "turn-1",
  "message": "command timed out"
}
```

### runtime.approval.requested

表示 runtime 请求用户批准某个动作。Workbench v1 仍保持只读 council，不实现执行审批，但 schema 中预留该能力。

```json
{
  "type": "runtime.approval.requested",
  "runtime": "codex",
  "thread_id": "thread-1",
  "turn_id": "turn-1",
  "request_id": "approval-1",
  "kind": "command",
  "reason": "需要运行测试命令",
  "command": "pytest",
  "file_paths": [],
  "response_template": {
    "supported_commands": ["yes", "no"]
  }
}
```

### runtime.context.updated

表示 runtime 报告上下文窗口或 token 使用情况。

```json
{
  "type": "runtime.context.updated",
  "runtime": "codex",
  "thread_id": "thread-1",
  "input_tokens": 1200,
  "output_tokens": 300,
  "current_tokens": 1500,
  "context_window": 128000
}
```

## 通用字段

每个落盘 council event 都应包含：

```json
{
  "schema_version": 1,
  "seq": 0,
  "type": "session_started",
  "phase": "discussion",
  "session_id": "20260527-..."
}
```

字段说明：

- `schema_version`：事件 schema 版本。第一版固定为 `1`。
- `seq`：session 内单调递增事件序号，从 `0` 开始。
- `type`：事件类型。
- `phase`：事件发生时所在阶段。
- `session_id`：当前 session 标识。

`seq` 是权威顺序。JSONL 的物理行顺序通常相同，但 replay 和工具处理时应优先使用 `seq` 排序。

`turn` 表示 session 内的讨论轮次，从 `0` 开始。`turn: 0` 通常用于初始 route；每次 agent 发言开始时递增。coordinator 的 decide/finalize 事件应使用它正在处理或刚完成的 agent turn。

## Phase

第一版主要实现只读 discussion，但 schema 需要保留后续执行扩展路径。

建议 phase 值：

```text
brainstorming
discussion
task_assignment
execution
review
finalized
```

当前实现主要使用：

```text
brainstorming
discussion
finalized
```

`brainstorming` 仅在 `mode=design_council` 时出现。它表示 session 在生成 design draft 之前的单 agent 探索阶段。brainstorming 结束后通过 `phase_transition` 进入 `discussion`。

注意：

```text
discussion 阶段 finalized 不等于 session_finished。
session_finished 才表示整个 session 生命周期结束。
```

## Council Event 类型

当前 council event 集合：

```text
session_started
phase_transition
coordinator_turn_started
coordinator_decided
coordinator_turn_completed
policy_override
agent_turn_started
agent_turn_completed
user_interjection
session_cancel_requested
finalization_started
finalized
session_finished
agent_error
coordinator_error
session_error
workplan_generation_started      (legacy JSON, 保留但不再用于新流程)
workplan_created                 (legacy JSON, 保留但不再用于新流程)
workplan_generation_failed
workplan_draft_started
workplan_draft_written
workplan_draft_committed
workplan_draft_commit_failed
workplan_review_started
workplan_review_completed
workplan_author_response_started
workplan_author_response_completed
workplan_revision_written
workplan_revision_committed
workplan_revision_commit_failed
workplan_approval_requested
workplan_approved
workplan_approval_rejected
brainstorming_started
brainstorming_question_created
brainstorming_answer_received
design_file_written
design_commit_created
design_commit_failed
design_revision_written
design_revision_committed
```

## Workplan Council v1 事件

Workplan Council v1 从已提交的 design artifact 生成 writing-plans 风格 Markdown workplan，经过 council review / author response / revision 后等待用户批准。所有新 workplan 事件使用 `phase: "finalized"`，表示它们是 discussion 收束后的 post-discussion artifact lifecycle；`phase` 不表达 workplan 自身的 draft/review/revision 状态。

Workplan 事件不修正 `session_finished.outcome`。调用方应通过派生状态里的 `state.workplan.status`、`state.workplan.latest_commit` 和 `state.waiting_for` 判断计划产物状态。

### 生成流程

```text
workplan_draft_started
  -> workplan_draft_written
  -> workplan_draft_committed (or workplan_draft_commit_failed)
  -> workplan_review_started
  -> (agent_turn_completed by reviewer)
  -> workplan_review_completed
  -> (if blocker or revise recommendation: workplan_author_response_started -> agent_turn_completed by author -> workplan_author_response_completed)
  -> (if author accepts or partially accepts: workplan_revision_written -> workplan_revision_committed)
  -> (if author rejects: continue review loop without writing a revision)
  -> workplan_approval_requested
  -> (user action: workplan_approved | workplan_approval_rejected)
```

### 事件说明

#### workplan_draft_started

Author agent (codex) 开始根据 source design 起草 workplan。

```json
{
  "type": "workplan_draft_started",
  "phase": "finalized",
  "generator": "codex",
  "source_design_path": "docs/designs/2026-06-02-topic.md",
  "source_design_commit": "abc1234"
}
```

#### workplan_draft_written

Workplan Markdown 已写入文件系统并通过合同扫描。

```json
{
  "type": "workplan_draft_written",
  "phase": "finalized",
  "artifact_path": "docs/workplans/2026-06-02-topic.md",
  "generator": "codex",
  "source_design_commit": "abc1234",
  "title": "Topic Implementation Plan",
  "revision": 0
}
```

#### workplan_draft_committed / workplan_draft_commit_failed

Workplan 已通过 git commit（或 commit 失败）。

```json
{
  "type": "workplan_draft_committed",
  "artifact_path": "docs/workplans/2026-06-02-topic.md",
  "source_design_commit": "abc1234",
  "commit": "def5678",
  "commit_message": "docs: draft topic workplan"
}
```

#### workplan_review_started / workplan_review_completed

Coordinator 路由 reviewer agent，reviewer 完成审查。`requires_revision` 表示 review 提出了 blocker 或 revise 建议，需要 author response；是否真的写 revision 由 author response 的 `decision` 和 `revision_required` 决定。

```json
{
  "type": "workplan_review_completed",
  "artifact_path": "docs/workplans/2026-06-02-topic.md",
  "workplan_commit": "def5678",
  "reviewer": "claude",
  "source_agent_turn_seq": 20,
  "requires_revision": true
}
```

#### workplan_author_response_started / workplan_author_response_completed

Author (codex) 回应 reviewer findings。`decision` 取 `accept` / `partially_accept` / `reject`。Author response 也会写入一条 `agent_turn_completed`，让 reviewer、coordinator 和 UI 都能看到 author 是否采纳建议以及理由；它本身不写文件。

```json
{
  "type": "workplan_author_response_completed",
  "artifact_path": "docs/workplans/2026-06-02-topic.md",
  "workplan_commit": "def5678",
  "author": "codex",
  "source_review_seq": 20,
  "source_agent_turn_seq": 21,
  "decision": "partially_accept",
  "revision_required": true
}
```

#### workplan_revision_written / workplan_revision_committed / workplan_revision_commit_failed

Author 根据 reviewer 反馈修订 workplan 并重新 commit。只有 author response 为 `accept` 或 `partially_accept` 且 `revision_required: true` 时才应写 revision。`latest_commit` 取最后一个 `workplan_draft_committed` 或 `workplan_revision_committed` 的 `commit`。

#### workplan_approval_requested

Review loop 完成，等待 Host 批准。

```json
{
  "type": "workplan_approval_requested",
  "phase": "finalized",
  "artifact_path": "docs/workplans/2026-06-02-topic.md",
  "workplan_commit": "ghi9012",
  "requested_at": "2026-06-02T10:05:00+08:00"
}
```

#### workplan_approved / workplan_approval_rejected

Host 批准或拒绝 workplan。批准或拒绝前必须校验派生状态为 `status: "waiting_for_user"` 且 `waiting_for: "workplan_approval"`，避免异步生成过程中被并发 approve/reject。

```json
{
  "type": "workplan_approved",
  "phase": "finalized",
  "artifact_path": "docs/workplans/2026-06-02-topic.md",
  "approved_commit": "ghi9012",
  "approved_at": "2026-06-02T10:06:00+08:00"
}
```

### Legacy JSON workplan

旧 `workplan_created` 事件（legacy JSON workplan v1）在新流程中不再发出。旧 session 可能仍包含该事件，消费者必须兼容。

旧字段 `has_workplan` / `workplan_status` 仅用于 legacy JSON workplan 兼容。新 UI 和 API 应优先读取 `state.workplan`。

### 派生状态中的 workplan

```json
{
  "workplan": {
    "artifact_path": "docs/workplans/2026-06-02-topic.md",
    "source_design_commit": "abc1234",
    "draft_commit": "def5678",
    "latest_commit": "ghi9012",
    "approved_commit": null,
    "status": "awaiting_approval",
    "title": "Topic Implementation Plan",
    "revision": 1
  }
}
```

`status` 取值：`none`、`drafting`、`draft_written`、`draft_committed`、`reviewing`、`reviewed`、`author_responding`、`author_responded`、`revision_written`、`revision_committed`、`draft_commit_failed`、`revision_commit_failed`、`awaiting_approval`、`approved`、`rejected`、`failed`、`legacy_json_created`。

`waiting_for_user` 状态新增 `"workplan_approval"`：当 workplan 处于 `awaiting_approval` 时，session status 应为 `waiting_for_user`，`waiting_for` 设为 `"workplan_approval"`。

## session_started

表示 session 创建。它必须是 `seq: 0`。

示例：

```json
{
  "schema_version": 1,
  "seq": 0,
  "type": "session_started",
  "phase": "discussion",
  "session_id": "20260527-001",
  "started_at": "2026-05-27T10:00:00+08:00",
  "topic": "讨论下一步优先级",
  "mode": "council",
  "config": {
    "council": {
      "max_turns": 3,
      "min_distinct_agents": 2,
      "max_context_chars": 2500,
      "max_transcript_chars": 2500,
      "max_message_chars": 800
    },
    "agents": {
      "codex": {
        "command": "codex",
        "input_mode": "stdin",
        "capabilities": ["plan", "synthesize", "review", "judge"],
        "roles": ["coordinator", "agent"],
        "enabled": true
      },
      "claude": {
        "command": "claude",
        "input_mode": "argument",
        "capabilities": ["challenge", "implement", "fix"],
        "roles": ["agent"],
        "enabled": true
      }
    }
  },
  "capabilities": {
    "can_execute": false,
    "requires_user_confirmation_before_write": true
  },
  "agents": [
    {
      "id": "codex",
      "command": "codex",
      "roles": ["coordinator", "agent"]
    },
    {
      "id": "claude",
      "command": "claude",
      "roles": ["agent"]
    }
  ]
}
```

`session_started` 保存启动时配置和 agent 快照。replay 旧 session 时，不应依赖当前配置文件。`/config` 修改只影响之后新建的 session，不热更新 running session。

Continue/Fork session 可以额外包含 source metadata：

```json
{
  "source_session_id": "20260527-001",
  "source_summary": "上一轮 council 已确认 Workbench v1 使用聊天式 UI。",
  "source_transcript_path": ".project-ai/sessions/20260527-001/transcript.jsonl"
}
```

## phase_transition

表示 session 从一个 phase 进入另一个 phase。

示例：

```json
{
  "schema_version": 1,
  "seq": 17,
  "type": "phase_transition",
  "phase": "task_assignment",
  "session_id": "20260527-001",
  "from": "discussion",
  "to": "task_assignment",
  "trigger": "coordinator",
  "reason": "discussion produced an actionable workplan"
}
```

`trigger` 表示谁触发切换，`reason` 表示为什么切换。

第一版只读 council 不一定需要产生该事件，但 schema 应先定义。

## coordinator_turn_started

表示 coordinator 开始一次路由、决策或总结判断。

示例：

```json
{
  "schema_version": 1,
  "seq": 1,
  "type": "coordinator_turn_started",
  "phase": "discussion",
  "session_id": "20260527-001",
  "turn": 0,
  "coordinator": "codex",
  "purpose": "route"
}
```

`purpose` 可取：

```text
route
decide
finalize
```

## coordinator_turn_completed

表示 coordinator 的一次调用结束。它记录调用生命周期，不表达决策内容。

示例：

```json
{
  "schema_version": 1,
  "seq": 3,
  "type": "coordinator_turn_completed",
  "phase": "discussion",
  "session_id": "20260527-001",
  "turn": 0,
  "coordinator": "codex",
  "purpose": "route",
  "status": "ok",
  "duration_ms": 5320
}
```

`status` 可取：

```text
ok
error
```

成功时，通常先记录 `coordinator_decided`，再用 `coordinator_turn_completed` 以 `status: "ok"` 闭合本次调用。

如果 coordinator 调用或解析失败，应先记录 `coordinator_error`，再用 `coordinator_turn_completed` 以 `status: "error"` 闭合本次调用。

## coordinator_decided

表示 coordinator 完成一次决策。

示例：

```json
{
  "schema_version": 1,
  "seq": 2,
  "type": "coordinator_decided",
  "phase": "discussion",
  "session_id": "20260527-001",
  "turn": 0,
  "coordinator": "codex",
  "decision": "continue",
  "next_agent": "codex",
  "role": "先建立问题框架",
  "reason": "需要先给出结构化判断",
  "raw_output_path": ".project-ai/sessions/20260527-001/coordinator_route_raw.md"
}
```

`decision` 可取：

```text
continue
finalize
abort
```

## policy_override

表示策略层覆盖 coordinator 决策。

示例：

```json
{
  "schema_version": 1,
  "seq": 6,
  "type": "policy_override",
  "phase": "discussion",
  "session_id": "20260527-001",
  "turn": 1,
  "policy": "min_distinct_agents",
  "original_decision": "finalize",
  "new_decision": "continue",
  "selected_agent": "claude",
  "reason": "min_distinct_agents=2 未满足，且尚未达到 max_turns"
}
```

`policy_override` 说明策略发生了什么；真正开始的 agent turn 仍由 `agent_turn_started` 表示。

当前会出现的 policy 包括：

- `min_distinct_agents`：coordinator 想 finalize，但不同 agent 发言数不足。
- `finalize_gate`：coordinator 想 finalize，但 latest agent signals 仍有 blockers、全部 not_ready，或存在 `disagree + not_ready`。
- `finalize_gate_fallback`：finalize gate 已连续覆盖到 `finalize_gate_max_overrides`，且没有尚未发言的 enabled agent，engine 允许 fallback finalize，并在 reason 中记录未解决问题。
- `avoid_coordinator_first_agent`：enabled agent 数大于 1 时，首轮避免 coordinator 自己作为第一个发言 agent。

## agent_turn_started

表示一个 agent 发言开始。

示例：

```json
{
  "schema_version": 1,
  "seq": 7,
  "type": "agent_turn_started",
  "phase": "discussion",
  "session_id": "20260527-001",
  "turn": 2,
  "agent": "claude",
  "role": "从实现可行性角度挑战方案",
  "selected_by": "policy",
  "selection_reason": "min_distinct_agents=2 未满足，强制选择尚未发言的 agent"
}
```

`selected_by` 第一版支持：

```text
coordinator
policy
user
```

`user` 是未来用户手动介入讨论时的预留值。

## agent_turn_completed

表示 agent 发言完成。它是 runtime events 提升到 council 语义后的产物，必须携带完整回复内容，因为 `transcript.jsonl` 是唯一权威日志。

示例：

```json
{
  "schema_version": 1,
  "seq": 9,
  "type": "agent_turn_completed",
  "phase": "discussion",
  "session_id": "20260527-001",
  "turn": 2,
  "agent": "claude",
  "content": "完整回复 Markdown...",
  "content_length": 1234,
  "duration_ms": 18420,
  "signal": {
    "stance": "mixed",
    "confidence": "medium",
    "finalize_readiness": "not_ready",
    "blockers": [
      { "type": "question", "text": "失败后是否允许重试？" }
    ],
    "agreements": [],
    "disagreements": [],
    "recommended_next_step": "继续讨论 blocker"
  }
}
```

新 session 的 agent turn 应包含 `signal`。旧 session 可能没有该字段，消费者必须兼容缺失。

`content` 是展示给用户的自然语言 analysis，不再是 agent 输出的完整 JSON。完整结构化判断保存在 `signal` 中：

- `stance`: `agree` / `disagree` / `mixed`
- `confidence`: `low` / `medium` / `high`
- `finalize_readiness`: `ready` / `not_ready`
- `blockers`: 不解决就不应 finalize 的 issue/question
- `agreements` / `disagreements`: 本轮明确同意或不同意的点
- `recommended_next_step`: agent 建议的下一步

Finalize gate 使用每个 agent 的最新 signal 判断是否允许收束。`disagree + ready` 不阻止 finalize，但 finalization brief 必须包含 latest signal 摘要，便于 final summary 记录 disagreements。

replay 默认可以一次性展示 `content`。如果 debug 日志包含 `runtime.reply.delta`，未来也可以模拟流式 replay。

## user_interjection

表示 Host 在 running session 中追加的指令。它是 council 层事件，默认落盘。Interjection 不打断当前正在运行的 agent 或 coordinator 调用；engine 在下一个安全决策点把它纳入 Council Brief。

示例：

```json
{
  "schema_version": 1,
  "seq": 10,
  "type": "user_interjection",
  "phase": "discussion",
  "session_id": "20260527-001",
  "turn": 2,
  "content": "请把取消语义也纳入讨论。",
  "created_at": "2026-05-27T10:02:20+08:00"
}
```

Workbench 默认把该事件投影为右侧 Host 气泡。

## session_cancel_requested

表示 Host 请求取消 running session。取消对 UI 立即生效，runtime 终止是 best-effort。该事件出现后，engine 不应再启动新的 coordinator 或 agent turn；当前调用返回或被终止后，session 以 `outcome: "cancelled"` 收束。

示例：

```json
{
  "schema_version": 1,
  "seq": 11,
  "type": "session_cancel_requested",
  "phase": "discussion",
  "session_id": "20260527-001",
  "requested_at": "2026-05-27T10:02:40+08:00",
  "reason": "user"
}
```

## finalization_started

表示 coordinator 开始生成当前阶段的总结。

示例：

```json
{
  "schema_version": 1,
  "seq": 12,
  "type": "finalization_started",
  "phase": "discussion",
  "session_id": "20260527-001",
  "turn_count": 3
}
```

## finalized

表示当前 phase 收束。第一版中通常表示 discussion 收束。

示例：

```json
{
  "schema_version": 1,
  "seq": 13,
  "type": "finalized",
  "phase": "discussion",
  "session_id": "20260527-001",
  "summary": "建议优先补齐 council 上下文压缩和策略层测试。",
  "next_steps": [
    "补 context compression 单元测试",
    "补 min_distinct_agents 策略测试",
    "更新 README 中的 council 用法"
  ]
}
```

`finalized` 不等于 `session_finished`。未来 discussion 收束后可以继续进入 `task_assignment` 或 `execution`。

## session_finished

表示整个 session 生命周期结束。

示例：

```json
{
  "schema_version": 1,
  "seq": 14,
  "type": "session_finished",
  "phase": "finalized",
  "session_id": "20260527-001",
  "finished_at": "2026-05-27T10:03:12+08:00",
  "outcome": "discussion_only",
  "duration_ms": 192000,
  "turn_count": 3,
  "distinct_agents": ["codex", "claude"],
  "error_count": 0
}
```

`outcome` 第一版建议值：

```text
discussion_only
execution_completed
error
cancelled
```

Workplan 是 discussion 结束后的派生产物，不修正 `session_finished.outcome`。旧 JSON workplan 可继续通过 `has_workplan` 和 `workplan_status` 兼容读取；新 Workplan Council v1 应通过 `state.workplan` 判断 artifact、commit、approval 和失败状态。

## Design Council 事件

`mode=design_council` 在标准 council 流程前增加 brainstorming prelude。brainstorming 阶段由单个 lead agent 询问澄清问题，产出 git-backed design 文档，然后通过 `phase_transition` 进入 `discussion` 进行 council 审查。

### brainstorming_started

表示 brainstorming prelude 开始。

```json
{
  "type": "brainstorming_started",
  "phase": "brainstorming",
  "lead_agent": "codex",
  "skill_id": "brainstorming_prelude",
  "max_questions": 8
}
```

### brainstorming_question_created

Lead agent 提出一个澄清问题。使用 `question_seq` 而非 `turn`，避免与 council discussion turns 混淆。

```json
{
  "type": "brainstorming_question_created",
  "phase": "brainstorming",
  "question_seq": 1,
  "agent": "codex",
  "question": "主要使用者是谁？",
  "reason": "需要确定目标用户。",
  "known_context": [],
  "missing_context": ["目标用户"]
}
```

### brainstorming_answer_received

Host 回答了 brainstorming question。

```json
{
  "type": "brainstorming_answer_received",
  "phase": "brainstorming",
  "question_seq": 1,
  "content": "Web UI 是主要交互界面。"
}
```

### design_file_written

Design artifact 已写入文件系统。写入和 git commit 是两个独立事件。

```json
{
  "type": "design_file_written",
  "phase": "brainstorming",
  "artifact_path": "docs/designs/2026-06-01-topic.md",
  "generator": "codex",
  "title": "topic",
  "revision": 0
}
```

### design_commit_created

Design artifact 已通过 git commit。commit 只 stage 设计文件。

```json
{
  "type": "design_commit_created",
  "phase": "brainstorming",
  "artifact_path": "docs/designs/2026-06-01-topic.md",
  "commit": "abc1234",
  "commit_message": "docs: draft topic design"
}
```

### design_commit_failed

Design commit 尝试失败。

```json
{
  "type": "design_commit_failed",
  "phase": "brainstorming",
  "artifact_path": "docs/designs/2026-06-01-topic.md",
  "revision": 0,
  "stage": "commit",
  "error": "git commit failed"
}
```

### design_revision_written / design_revision_committed

Reviewer 反馈后的 revision。`source_commit` 记录被修订的 commit。

```json
{
  "type": "design_revision_written",
  "artifact_path": "docs/designs/2026-06-01-topic.md",
  "source_commit": "abc1234",
  "source_review_seq": 12,
  "generator": "codex",
  "revision": 1
}
```

```json
{
  "type": "design_revision_committed",
  "artifact_path": "docs/designs/2026-06-01-topic.md",
  "source_commit": "abc1234",
  "commit": "def5678",
  "commit_message": "docs: revise topic design"
}
```

### 派生状态中的 design

```json
{
  "design": {
    "artifact_path": "docs/designs/2026-06-01-topic.md",
    "draft_commit": "abc1234",
    "latest_commit": "def5678",
    "status": "revision_committed"
  }
}
```

`status` 取值：`none`、`file_written`、`revision_written`、`draft_committed`、`revision_committed`、`commit_failed`。

### waiting_for_user 状态

当存在未回答的 brainstorming question 时，`status` 应被设为 `waiting_for_user`，`waiting_for` 设为 `"brainstorming_answer"`。engine 暂停，等待 Host 通过 `/brainstorming/answer` API 提交回答，然后 resume。

当 workplan 处于 `awaiting_approval` 时，`status` 应被设为 `waiting_for_user`，`waiting_for` 设为 `"workplan_approval"`。Host 可通过 `/workplan/approve` 或 `/workplan/reject` API 批准或拒绝。

## 错误事件

错误必须是一等事件，不能只依赖异常日志。

错误事件通用字段：

```text
message
recoverable
action
details
```

`action` 记录系统如何处理该错误，而不只是记录错误本身。

### agent_error

用于 agent 调用失败、超时、崩溃或输出不可用。

```json
{
  "schema_version": 1,
  "seq": 10,
  "type": "agent_error",
  "phase": "discussion",
  "session_id": "20260527-001",
  "turn": 2,
  "agent": "claude",
  "message": "command timed out",
  "recoverable": true,
  "action": "fallback_finalize",
  "details": {
    "timeout_seconds": 120,
    "exit_code": null
  }
}
```

### coordinator_error

用于 coordinator 调用失败、决策解析失败或格式错误。

```json
{
  "schema_version": 1,
  "seq": 11,
  "type": "coordinator_error",
  "phase": "discussion",
  "session_id": "20260527-001",
  "turn": 2,
  "message": "failed to parse coordinator decision",
  "recoverable": true,
  "action": "fallback_finalize",
  "details": {
    "raw_output_path": ".project-ai/sessions/20260527-001/coordinator_decide_raw.md"
  }
}
```

### session_error

用于整个 session 无法继续。

```json
{
  "schema_version": 1,
  "seq": 12,
  "type": "session_error",
  "phase": "discussion",
  "session_id": "20260527-001",
  "message": "no available agents",
  "recoverable": false,
  "action": "abort",
  "details": {}
}
```

## 默认落盘策略

默认写入 `transcript.jsonl`：

```text
session_started
phase_transition
coordinator_turn_started
coordinator_decided
coordinator_turn_completed
policy_override
agent_turn_started
agent_turn_completed
user_interjection
session_cancel_requested
finalization_started
finalized
session_finished
workplan_generation_started
workplan_created
workplan_generation_failed
workplan_draft_started
workplan_draft_written
workplan_draft_committed
workplan_draft_commit_failed
workplan_review_started
workplan_review_completed
workplan_author_response_started
workplan_author_response_completed
workplan_revision_written
workplan_revision_committed
workplan_revision_commit_failed
workplan_approval_requested
workplan_approved
workplan_approval_rejected
agent_error
coordinator_error
session_error
```

默认不写入 `transcript.jsonl`：

```text
runtime.reply.delta
```

`runtime.reply.delta` 可以在 debug 模式打开持久化，但第一版不应默认开启。

## 派生文件

### state.json

`state.json` 是快速查询用 snapshot，主要服务：

```text
aictl session list
aictl session status <id>
```

它可以包含：

```json
{
  "session_id": "20260527-001",
  "status": "waiting_for_user",
  "phase": "finalized",
  "topic": "讨论下一步优先级",
  "started_at": "2026-05-27T10:00:00+08:00",
  "finished_at": "2026-05-27T10:03:12+08:00",
  "turn_count": 3,
  "distinct_agents": ["codex", "claude"],
  "last_seq": 14,
  "outcome": "discussion_only",
  "error_count": 0,
  "waiting_for": "workplan_approval",
  "has_workplan": false,
  "workplan_status": "none",
  "workplan": {
    "artifact_path": "docs/workplans/2026-06-02-topic.md",
    "source_design_commit": "abc1234",
    "draft_commit": "def5678",
    "latest_commit": "ghi9012",
    "approved_commit": null,
    "status": "awaiting_approval",
    "title": "Topic Implementation Plan",
    "revision": 1
  }
}
```

`state.json` 必须能从 `transcript.jsonl` 重建。

`status` 建议取值：

```text
running
waiting_for_user
cancelling
done
error
cancelled
```

`waiting_for_user` 表示 engine 需要 Host 输入才可继续。当前可能出现在 `mode=design_council` 的 brainstorming 阶段（`waiting_for: "brainstorming_answer"`），也可能出现在 Workplan Council v1 等待用户批准阶段（`waiting_for: "workplan_approval"`）。

`workplan_status` 是 legacy JSON workplan v1 的兼容字段。新 Workplan Council v1 应读取 `workplan.status`，建议取值：

```text
none
drafting
draft_written
draft_committed
reviewing
reviewed
author_responding
author_responded
revision_written
revision_committed
draft_commit_failed
revision_commit_failed
awaiting_approval
approved
rejected
failed
legacy_json_created
```

### transcript.md

`transcript.md` 是人类可读视图，应从 `transcript.jsonl` 渲染生成。

如果 session 中断，也应能根据已有事件生成不完整 transcript，并在末尾标注错误或中断原因。

## Replay 行为

`aictl session replay <id>` 应读取 `transcript.jsonl`，按 `seq` 排序，然后把事件喂给和实时 CLI 相同或兼容的 renderer。

默认 replay 行为：

- `agent_turn_completed` 一次性展示完整 agent 回复；
- `user_interjection` 展示为 Host 消息；
- `session_cancel_requested` 展示取消请求和后续 cancelled outcome；
- `policy_override` 显示策略覆盖原因；
- 错误事件显示错误和系统处理动作；
- `phase_transition` 显示阶段切换；
- `session_finished` 显示 outcome summary。

如果 debug 日志中包含 `runtime.reply.delta`，未来可以支持模拟流式 replay。

## 未来扩展：执行编排

当前已支持只读 council discussion、Design Council，以及从 latest design commit 生成并 review Markdown Workplan 的 Workplan Council v1。未来如果支持“AI 按已批准 workplan 分工执行”，应继续使用同一个 session 事件日志，而不是另建一套日志系统。

未来可增加事件：

```text
task_assigned
task_started
task_progress
task_completed
task_failed
review_started
review_completed
fix_requested
```

建议演进路径：

```text
1. 只读 council 可观察化（已支持）
2. 从 design latest commit 生成 Markdown workplan，并经过 council review / 用户批准（已支持）
3. 用户确认后执行 workplan
4. 多 agent 分工执行、汇总和 review
```

涉及写文件时，必须由 session capability 和用户确认共同约束。
