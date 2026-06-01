# Design Council Workflow Skill 设计

## 目标

Design Council Workflow Skill 的目标是把 PatchCouncil 的默认协作方式，从“多 agent 开放式讨论后由 coordinator 收束”，演进为“以设计文档为中心的澄清、评审、修订和确认流程”。

新默认流程应借鉴 Codex `brainstorming` skill 的核心机制：

- 先澄清用户意图，再进入设计。
- 每次只向用户追问一个问题。
- 设计未被用户确认前，不进入 implementation plan，不执行代码改动。
- 设计产物必须落为可审计的 `design.md`。
- review agent 针对 `design.md` challenge，而不是针对散乱 transcript。
- lead agent 根据 challenge 修订 `design.md`。

该能力应作为 PatchCouncil 自己的 workflow skill，而不是依赖 Codex 本地 `.codex/skills` 自动触发。

## 非目标

v1 不包含：

- 通用 YAML 状态机解释器。
- 任意第三方 workflow skill 安装或插件市场。
- 直接复用 Codex 本地 `brainstorming` skill。
- browser visual companion。
- 自动实现代码。
- 自动生成 implementation plan。
- 多个并行 design artifact。
- 对旧 `council` mode 做破坏性移除。

旧 `council` mode 可以保留为 open discussion / quick discussion，但不再作为默认主入口。

## 背景

现有 council loop 的核心形态是：

```text
用户 topic
-> coordinator route
-> agent turn
-> coordinator decide
-> policy gate
-> finalize
```

Agent Turn Signal v1 已经降低了 coordinator 过早收束风险，但它仍然围绕“讨论是否成熟”判断。对于真实产品演进，用户通常需要的不是一段最终总结，而是一份可以 review、修订、批准，并继续转成 workplan 的设计文档。

Codex `brainstorming` skill 的实现方式不是运行时状态机，而是一份强约束流程协议。它要求模型按顺序完成：

```text
explore context
-> ask one clarifying question at a time
-> propose 2-3 approaches
-> present design
-> write spec
-> self-review spec
-> user review gate
-> transition to implementation plan
```

PatchCouncil 可以把这些流程约束产品化为 workflow skill。

## 核心设计

新增一个内置 workflow skill：

```text
apps/patchcouncil-ui/engine/workflows/design-council/
  skill.yaml
  prompts/
    clarify_decide.md
    design_draft.md
    design_review.md
    design_revision.md
    approval_summary.md
```

`skill.yaml` 描述角色、限制和 prompt 名称。v1 中 engine 不解释任意状态机，只加载该内置 skill 的配置和 prompt set。

示例：

```yaml
id: design_council
title: Design Council
default: true

agents:
  lead: codex
  reviewer: claude

limits:
  max_clarification_questions: 8
  max_review_rounds: 2

prompts:
  clarify_decide: prompts/clarify_decide.md
  design_draft: prompts/design_draft.md
  design_review: prompts/design_review.md
  design_revision: prompts/design_revision.md
  approval_summary: prompts/approval_summary.md
```

## Workflow

v1 固定流程：

```text
POST /api/sessions { mode: "design_council", topic }
-> workflow_skill_loaded
-> clarification loop
   -> lead agent decides ask_user or draft_design
   -> if ask_user: clarification_question_created, session waits
   -> user answers: clarification_answer_received
-> design_draft_created
-> design_review_created
-> design_revision_created
-> design_approval_requested
-> user approves or asks for another revision
-> design_approved
```

### Clarification Loop

Lead agent 每次只允许生成一个问题。

`clarify_decide.md` 输出严格 JSON：

```json
{
  "decision": "ask_user",
  "question": "这个功能的主要使用者是谁？",
  "reason": "需要明确目标用户才能判断交互复杂度。",
  "known_context": ["用户希望默认流程替代 open council"],
  "missing_context": ["目标用户", "成功标准"]
}
```

或：

```json
{
  "decision": "draft_design",
  "reason": "目标、约束和成功标准已经足够起草设计。",
  "known_context": ["..."],
  "missing_context": []
}
```

规则：

- `ask_user.question` 必须只有一个问题。
- 问题应短、具体、可回答。
- 达到 `max_clarification_questions` 后，如果仍缺关键信息，lead agent 必须生成带 assumptions 的 design draft，而不是无限追问。
- 用户回答作为结构化事件追加，不覆盖已有 transcript。

### Design Draft

Lead agent 基于 topic、clarification Q/A 和项目上下文生成 `design.md`。

Design draft 至少包含：

- Problem / Goal
- Non-goals
- Proposed workflow
- Event model
- UI behavior
- Error handling
- Compatibility / migration
- Testing strategy
- Open questions or assumptions

事件：

```json
{
  "type": "design_draft_created",
  "phase": "design",
  "artifact": {
    "path": "design.md",
    "title": "Design Council Workflow Skill",
    "content": "..."
  },
  "generator": "codex"
}
```

落盘：

```text
.project-ai/sessions/<session-id>/design.md
```

### Design Review

Reviewer agent 只 review `design.md`，不重新主导设计。

`design_review.md` 输出严格 JSON：

```json
{
  "summary": "设计方向可行，但状态命名和等待用户语义需要更明确。",
  "findings": [
    {
      "severity": "high",
      "title": "waiting state 未定义恢复路径",
      "detail": "clarification_question_created 后需要明确用户回答如何唤醒 workflow。"
    }
  ],
  "recommendation": "revise"
}
```

`recommendation` 取值：

```text
approve | revise
```

Reviewer 不直接修改 `design.md`。

### Design Revision

Lead agent 根据 review findings 生成修订版 `design.md`，并记录本轮修订摘要。

事件：

```json
{
  "type": "design_revision_created",
  "phase": "design",
  "revision": 1,
  "source_review_seq": 12,
  "artifact": {
    "path": "design.md",
    "title": "Design Council Workflow Skill",
    "content": "..."
  },
  "generator": "codex"
}
```

v1 默认最多 `max_review_rounds: 2`。达到上限后进入 user approval gate，并在 approval summary 中记录未采纳的 review concerns。

### User Approval Gate

设计经过 review / revision 后，session 进入等待用户确认状态。

事件：

```json
{
  "type": "design_approval_requested",
  "phase": "design",
  "artifact_path": "design.md",
  "summary": "请 review design.md。确认后才能生成 workplan。"
}
```

用户确认后：

```json
{
  "type": "design_approved",
  "phase": "design",
  "approved_at": "2026-06-02T10:00:00+08:00",
  "artifact_path": "design.md"
}
```

Design 未 approve 前：

- 不允许生成 workplan。
- 不允许进入 implementation plan。
- 不允许执行写文件任务。

## Session State

新增或扩展派生状态：

```json
{
  "mode": "design_council",
  "status": "waiting_for_user",
  "waiting_for": "clarification_answer",
  "workflow": {
    "skill_id": "design_council",
    "stage": "clarify",
    "clarification_count": 2,
    "review_round": 0
  },
  "has_design": false,
  "design_status": "none"
}
```

`status` 建议取值扩展：

```text
running
waiting_for_user
done
error
cancelled
```

`design_status` 建议取值：

```text
none
drafted
reviewed
revised
approval_requested
approved
```

## Event Model

新增 council-level events：

```text
workflow_skill_loaded
clarification_question_created
clarification_answer_received
design_draft_created
design_review_created
design_revision_created
design_approval_requested
design_approved
```

### workflow_skill_loaded

```json
{
  "type": "workflow_skill_loaded",
  "phase": "design",
  "skill_id": "design_council",
  "skill_version": 1,
  "lead_agent": "codex",
  "reviewer_agent": "claude"
}
```

### clarification_question_created

```json
{
  "type": "clarification_question_created",
  "phase": "design",
  "turn": 1,
  "agent": "codex",
  "question": "这个功能的主要使用者是谁？",
  "reason": "需要明确目标用户才能判断交互复杂度。",
  "known_context": [],
  "missing_context": ["目标用户"]
}
```

### clarification_answer_received

```json
{
  "type": "clarification_answer_received",
  "phase": "design",
  "question_seq": 3,
  "content": "主要使用者是项目 owner，在本地 Workbench 中使用。"
}
```

## UI Behavior

Workbench 默认创建 `design_council` session。

当 session `status=waiting_for_user` 且 `waiting_for=clarification_answer`：

- 主线程展示 lead agent 的问题。
- composer placeholder 变为 `Answer Codex's question...`。
- 用户发送内容后追加 `clarification_answer_received`，workflow 继续。

当 `design_approval_requested` 出现：

- UI 展示 design artifact。
- 提供 `Approve Design` 按钮。
- 用户也可以通过 composer 反馈修改意见；该反馈触发下一轮 revision，而不是 approve。

Raw events 继续展示完整事件。

## API

创建 session：

```http
POST /api/sessions
{
  "topic": "...",
  "mode": "design_council"
}
```

回答澄清问题：

v1 可复用现有 interjection API 的传输通道，但落事件时应写成 `clarification_answer_received`，不要把它混同为普通 `user_interjection`。

```http
POST /api/sessions/:id/answers
{
  "content": "..."
}
```

批准设计：

```http
POST /api/sessions/:id/design/approve
```

生成 workplan：

```http
POST /api/sessions/:id/workplan
```

仅当存在 `design_approved` 时允许。旧 `council` mode 可继续沿用现有 done session 规则。

## Skill Loading

v1 skill loader 只支持内置 workflow skill：

```text
design_council
```

加载过程：

1. 读取 `skill.yaml`。
2. 校验 `id`、`agents`、`limits`、`prompts`。
3. 解析 prompt 文件路径，路径必须位于该 skill 目录内。
4. 写入 `workflow_skill_loaded`。
5. Engine 根据硬编码的 `design_council` runner 执行流程。

不支持：

- 从任意目录加载 skill。
- skill 自定义 JS。
- skill 自定义状态转移代码。
- 网络下载 skill。

这样保留未来扩展空间，但 v1 不引入执行任意 workflow 的安全风险。

## Error Handling

- Lead agent 输出无法解析：写 `workflow_error` 或 `coordinator_error`，允许 retry 一次；仍失败则 session `outcome=error`。
- Lead agent 连续问重复问题：v1 不做语义去重，但 prompt 应要求避免重复；后续可加 repetition guard。
- 用户回答为空：返回 400，不追加事件。
- Reviewer 失败：允许跳过 review，但必须写 `design_review_created` 的 degraded summary，说明未完成 review。
- Design revision 失败：保留上一版 design，session 进入 `design_approval_requested`，summary 中记录 revision failure。
- 用户取消：沿用 `session_cancel_requested`，不再启动新的 agent call。

## 与现有 Council 的关系

`design_council` 是新的默认主入口。

现有 `council` mode 保留：

- 快速开放式讨论。
- 调试 agent routing。
- 不需要 design artifact 的轻量咨询。

两者共享：

- session store
- event log
- runtime adapters
- Workbench UI shell
- config loading

但 `design_council` 不复用 open council 的 coordinator loop。它有自己的 workflow runner。

## 与 Workplan 的关系

Workplan v1 当前基于 finalized discussion summary 生成计划。

Design Council 后续应让 workplan 优先基于 approved design：

```text
approved design.md
-> workplan_create.md
-> workplan_created
```

如果 session mode 是 `design_council`，没有 `design_approved` 时不允许生成 workplan。

## 测试策略

Engine smoke：

- 创建 `design_council` session 会写 `workflow_skill_loaded`。
- lead agent 输出 `ask_user` 会写 `clarification_question_created`，state 变为 `waiting_for_user`。
- 用户回答会写 `clarification_answer_received`，workflow 继续。
- 达到足够上下文后写 `design_draft_created` 和 `design.md`。
- reviewer 输出 findings 后写 `design_review_created`。
- lead agent 修订后写 `design_revision_created`。
- `design_approval_requested` 前不允许 workplan。
- `design_approved` 后允许 workplan。
- `max_clarification_questions` 达到后不无限追问。
- cancel 会停止后续 agent call。

Prompt tests：

- `clarify_decide.md` 要求一次只问一个问题。
- `clarify_decide.md` 输出 schema 包含 `ask_user | draft_design`。
- `design_review.md` 输出 findings schema。
- `design_revision.md` 明确 reviewer 不直接改设计，由 lead agent 修订。

UI / API smoke：

- waiting state 下 composer 可提交 answer。
- approval requested 下显示 `Approve Design`。
- raw events 能看到新增 workflow events。
- `POST /workplan` 在未 approve 时返回 409。

## Open Questions

v1 先固定以下决策：

- 每问一答，不批量问多个问题。
- lead agent 默认 codex，reviewer 默认 claude。
- 不接入 visual companion。
- skill loader 只加载内置 `design_council`。

留到后续讨论：

- Brief/context budget 的统一策略。
- 多个 design artifact 或 design version diff UI。
- 是否支持用户手动编辑 design.md。
- 是否把 design review 做成可配置多 reviewer。
- 是否把 workflow skill 扩展成通用状态机。
