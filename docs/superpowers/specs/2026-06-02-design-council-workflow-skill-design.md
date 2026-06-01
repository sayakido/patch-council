# Brainstorming Prelude + Git-backed Design Review Council 设计

## 目标

本设计的目标是在现有 PatchCouncil council event loop 前增加一个轻量的 brainstorming prelude，让 AI 先通过一问一答澄清用户意图，产出第一版 `design.md`，并把该设计文档提交为 git commit。随后进入现有 council loop，让其他 agent 围绕这个 design commit 进行 review / challenge / 优化。

核心目标：

- 用户发起 topic 后，先由 lead agent 进行 brainstorming 式一问一答。
- 每次只问用户一个问题。
- 信息足够后，lead agent 产出第一版 design 文档。
- 第一版 design 文档立即形成 git commit，作为可 review 的上下文锚点。
- 现有 council loop 复用 agent turn、signal、finalize gate 等机制，但任务固定为 review / 优化 design。
- Reviewer agent 负责 review / challenge / constructive improvement，不直接修改 design。
- Lead agent 根据 review 修订 design，并提交最终或下一版 commit。
- 后续可以通过 `review commit <hash>` 的方式传递上下文。

## 非目标

v1 不包含：

- 通用 workflow action loop。
- 通用 YAML 状态机解释器。
- 任意第三方 workflow skill 安装。
- browser visual companion。
- 自动实现代码。
- 自动生成 implementation plan。
- 多个并行 design artifact。
- 在 design 未获用户确认前生成 workplan。

## 背景

Codex `brainstorming` skill 的价值不在于它有复杂运行时代码，而在于它定义了一套强约束协作协议：

```text
先理解上下文
-> 一次问一个澄清问题
-> 信息足够后形成设计
-> 写 design spec
-> 自检
-> 等用户 review
-> 再进入 implementation plan
```

PatchCouncil 不需要直接调用 Codex 本地 `.codex/skills`，但可以把这套行为模式作为内置 prelude。

现有 open council loop 适合多 agent review，但不适合在一开始澄清需求。如果 topic 本身还模糊，多 agent 会在缺少上下文时发散讨论，最后依赖 coordinator 收束。Agent Turn Signal v1 能减少过早 finalize，但不能替代用户澄清。

因此新默认流程应拆为两段：

```text
Brainstorming Prelude
-> Git-backed design draft
-> Existing Council Design Review
```

## 总体流程

```text
用户发起 topic
-> phase: brainstorming
-> lead agent 一问一答澄清需求
-> lead agent 生成 docs/designs/YYYY-MM-DD-<slug>.md
-> git commit 第一版 design
-> phase_transition brainstorming -> discussion
-> 现有 council loop review / challenge 第一版 design commit
-> lead agent 根据 review 修订 design
-> git commit 修订版 design
-> council finalize
-> 用户确认后，后续 workplan 基于最终 design commit
```

## Phase Model

新增 phase：

```text
brainstorming
```

现有 phase 保留：

```text
discussion
finalized
```

`brainstorming` phase 是单 agent prelude，不运行 coordinator loop。

`discussion` phase 复用现有 council loop，但 Council Brief 必须包含：

- 原始 topic
- brainstorming Q/A 摘要
- design artifact path
- draft design commit hash
- design 文档摘要
- 如果上下文预算允许，可包含完整 design 文档内容

## Brainstorming Prelude

### Lead Agent

`skill.yaml` 中的 `lead_agent` 只是默认值。实际使用的 lead agent 必须通过 engine 全局 agent config 解析，允许被 session/config 覆盖。

v1 默认值：

```yaml
lead_agent: codex
```

创建 session 时必须先完成 agent 可用性检查，这是所有 mode 的通用前置步骤：

- coordinator agent 必须可用。
- 本 mode 需要的 lead/reviewer agent 必须可用。
- 不可用时直接拒绝创建 session，API 返回明确错误。
- 不允许 session 创建成功后，运行到一半才因为 agent 不可用失败。

Lead agent 使用内置 prompt 包，不直接依赖 Codex 本地 `brainstorming` skill。

建议目录：

```text
apps/patchcouncil-ui/engine/skills/brainstorming-prelude/
  skill.yaml
  prompts/
    ask_or_draft.md
    design_draft.md
    design_revision.md
```

`skill.yaml` 示例：

```yaml
id: brainstorming_prelude
title: Brainstorming Prelude
version: 1

lead_agent: codex

limits:
  max_questions: 8

prompts:
  ask_or_draft: prompts/ask_or_draft.md
  design_draft: prompts/design_draft.md
  design_revision: prompts/design_revision.md
```

### Ask Or Draft Decision

每轮 brainstorming 调用 lead agent，让它决定继续问用户，还是生成 design draft。

严格 JSON：

```json
{
  "decision": "ask_user",
  "question": "这个功能的主要使用者是谁？",
  "reason": "需要明确目标用户才能判断交互和默认流程。",
  "known_context": ["用户希望替代默认 council"],
  "missing_context": ["目标用户"]
}
```

或：

```json
{
  "decision": "draft_design",
  "reason": "目标、约束和成功标准已经足够生成第一版 design。",
  "known_context": ["..."],
  "missing_context": []
}
```

规则：

- `ask_user.question` 必须只有一个问题。
- 问题必须短、具体、可回答。
- 用户回答后继续同一个 brainstorming prelude。
- 达到 `max_questions` 后，如果仍缺信息，lead agent 必须生成带 assumptions 的 design，而不是无限追问。

## Git-backed Design Artifact

第一版 design 写入项目文档目录：

```text
docs/designs/YYYY-MM-DD-<slug>.md
```

不要写到 `docs/superpowers/specs/`。`docs/superpowers` 是 Codex/Superpowers 协作过程文档；`docs/designs/` 是 PatchCouncil 产品产出的可 review artifact。

写文件前，engine 必须确保 `docs/designs/` 目录存在。

### Commit Rules

Design artifact 必须通过 git 管理。

第一版 design 生成后：

```text
git add docs/designs/YYYY-MM-DD-<slug>.md
git commit -m "docs: draft <topic> design"
```

修订版 design 生成后：

```text
git add docs/designs/YYYY-MM-DD-<slug>.md
git commit -m "docs: revise <topic> design"
```

规则：

- 只允许 stage design artifact 文件。
- 不允许 stage unrelated dirty files。
- 如果目标 design 文件之外存在 dirty changes，不阻止提交，但必须使用精确 `git add <design-path>`。
- 如果 design 文件已有用户未提交改动，engine 必须停止并请求用户确认，不可覆盖。
- commit 失败时，写 `design_commit_failed`，session 进入 waiting/error 状态，由用户决定重试或手动处理。

### Why Git Commit

Git commit 是设计上下文的稳定锚点：

- reviewer 可以直接 review `commit <hash>`。
- 用户可以用 diff 看初稿和终稿差异。
- 长讨论中无需把完整 design 反复塞入 prompt。
- workplan 可以引用最终 design commit。
- event log 只需记录 artifact path 和 commit hash，即可回溯。

## Council Design Review

Design draft commit 后进入现有 council loop。

现有 loop 保留：

```text
coordinator route
-> agent_turn_completed
-> coordinator decide
-> policy gate / finalize gate
-> finalize
```

但 discussion goal 固定为：

```text
review / challenge / optimize the design document
```

Prompt 必须告诉 coordinator：

- 当前 council 不是重新发散需求。
- 当前 council 的对象是 design artifact 和 draft commit。
- reviewer agent 应优先找风险、遗漏、歧义和不合理边界，也可以提出建设性补充。
- lead agent 可以回应 review，并在需要时修订 design。

### Reviewer Role

Reviewer agent，例如 Claude：

- review design commit / design.md。
- 输出 findings。
- 可以提出建设性补充、替代方案或新增约束。
- 不直接修改 design。
- 不生成 implementation plan。

可以复用 `agent_turn_completed.signal`：

- `blockers` 表示 design 不应通过的阻塞问题。
- `disagreements` 表示设计取舍分歧。
- `recommended_next_step` 可以建议 revise design。

### Lead Revision

Lead agent，例如 Codex：

- 根据 reviewer findings 修订 `docs/designs/...md`。
- 生成 revision commit。
- 在事件中记录 source review event 和 source commit。

v1 可以只允许 lead agent 修改 design artifact，不允许 reviewer 写文件。

## Events

新增事件：

```text
brainstorming_started
brainstorming_question_created
brainstorming_answer_received
design_file_written
design_commit_created
design_commit_failed
design_revision_written
design_revision_committed
```

现有事件继续使用：

```text
session_started
phase_transition
coordinator_decided
agent_turn_completed
policy_override
finalized
session_finished
```

### session_started

`mode=design_council` 时，`session_started` 必须快照 brainstorming prelude 的关键配置，避免后续 prompt/config 变更影响已创建 session 的可追溯性。

```json
{
  "type": "session_started",
  "mode": "design_council",
  "phase": "brainstorming",
  "config": {
    "lead_agent": "codex",
    "max_questions": 8
  }
}
```

### brainstorming_started

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

```json
{
  "type": "brainstorming_question_created",
  "phase": "brainstorming",
  "question_seq": 1,
  "agent": "codex",
  "question": "这个功能的主要使用者是谁？",
  "reason": "需要明确目标用户才能判断交互和默认流程。",
  "known_context": ["用户希望替代默认 council"],
  "missing_context": ["目标用户"]
}
```

### brainstorming_answer_received

```json
{
  "type": "brainstorming_answer_received",
  "phase": "brainstorming",
  "question_seq": 3,
  "content": "主要使用者是项目 owner，在本地 Workbench 中使用。"
}
```

### design_file_written

```json
{
  "type": "design_file_written",
  "phase": "brainstorming",
  "artifact_path": "docs/designs/2026-06-02-design-council.md",
  "generator": "codex",
  "title": "Design Council Workflow",
  "revision": 0
}
```

### design_commit_created

```json
{
  "type": "design_commit_created",
  "phase": "brainstorming",
  "artifact_path": "docs/designs/2026-06-02-design-council.md",
  "commit": "abc1234",
  "commit_message": "docs: draft design council workflow"
}
```

### design_commit_failed

```json
{
  "type": "design_commit_failed",
  "phase": "brainstorming",
  "artifact_path": "docs/designs/2026-06-02-design-council.md",
  "revision": 0,
  "stage": "commit",
  "error": "git commit failed"
}
```

### design_revision_written

```json
{
  "type": "design_revision_written",
  "phase": "discussion",
  "artifact_path": "docs/designs/2026-06-02-design-council.md",
  "source_commit": "abc1234",
  "source_review_seq": 18,
  "generator": "codex",
  "revision": 1
}
```

### design_revision_committed

```json
{
  "type": "design_revision_committed",
  "phase": "discussion",
  "artifact_path": "docs/designs/2026-06-02-design-council.md",
  "source_commit": "abc1234",
  "commit": "def5678",
  "commit_message": "docs: revise design council workflow"
}
```

## State Projection

派生 `state.json` 增加：

```json
{
  "mode": "design_council",
  "phase": "brainstorming",
  "status": "waiting_for_user",
  "waiting_for": "brainstorming_answer",
  "design": {
    "artifact_path": "docs/designs/2026-06-02-design-council.md",
    "draft_commit": "abc1234",
    "latest_commit": "def5678",
    "status": "revision_committed"
  },
  "brainstorming": {
    "question_count": 3,
    "lead_agent": "codex"
  }
}
```

`status` 新增：

```text
waiting_for_user
```

`waiting_for` v1：

```text
brainstorming_answer
```

`design.status` v1：

```text
none
file_written
draft_committed
revision_written
revision_committed
commit_failed
```

## API

创建 session：

```http
POST /api/sessions
{
  "topic": "...",
  "mode": "design_council",
  "brainstorming": {
    "lead_agent": "codex",
    "max_questions": 8
  }
}
```

如果请求未显式传入 `brainstorming`，服务端使用默认值，并在 `session_started.config` 中记录最终生效值。

回答 brainstorming 问题：

```http
POST /api/sessions/:id/brainstorming/answer
{
  "content": "..."
}
```

继续沿用现有 workplan API：

```http
POST /api/sessions/:id/workplan
```

规则：

- `mode=design_council` 时，workplan 应优先基于 `design.latest_commit`。
- 如果没有 design commit，不允许生成 workplan。

## UI

Workbench 复用现有 chat 主线程。

新增投影：

- `brainstorming_question_created`：显示为 Codex 问题。
- `brainstorming_answer_received`：显示为 Host 回答。
- `design_file_written`：显示 design artifact 卡片。
- `design_commit_created`：显示 draft commit hash。
- `design_revision_committed`：显示 revision commit hash。

当 `status=waiting_for_user` 且 `waiting_for=brainstorming_answer`：

- composer placeholder 变为 `Answer Codex's question...`。
- submit 调用 `/brainstorming/answer`。

进入 discussion phase 后：

- UI 回到现有 council chat 展示。
- design artifact 卡片固定显示当前 latest commit。

## Prompt Changes

### brainstorming ask_or_draft

必须强调：

- 一次只问一个问题。
- 不要生成实现计划。
- 不要写代码。
- 如果上下文足够，输出 `draft_design`。
- 如果 topic 太大，优先问一个帮助缩小范围的问题。

### design_draft

必须产出 Markdown design doc，包含：

- Goal
- Non-goals
- Context / assumptions
- Proposed design
- Event / state changes
- UI / API behavior
- Error handling
- Testing strategy
- Open questions

### council route / decide

当 session 从 brainstorming 进入 discussion，brief 必须说明：

```text
This council is reviewing and improving the design document.
Do not restart requirements elicitation unless the design has a blocker that only the user can answer.
Do not generate an implementation plan.
```

### Council Brief Budget

`design_council` 的 brief 不能简单沿用 open council 的小上下文预算。v1 采用保守策略：

- brief 必须包含 design artifact path、draft commit hash、latest commit hash 和 design 摘要。
- brief 应包含完整 brainstorming Q/A 摘要，而不是只保留最后几条消息。
- 如果完整 design 文档超过预算，不把全文塞入 brief。
- reviewer/lead 需要完整内容时，通过 artifact path 或 commit hash 读取 `docs/designs/...md`。
- 后续如果发现 agent runtime 无法可靠读取文件，再单独讨论是否提高 `design_council` 的 `max_context_chars`。

## Error Handling

- Lead agent ask/draft JSON parse failed：写 `coordinator_error` 或 `brainstorming_error`，允许 retry 一次。
- 用户回答为空：API 返回 400，不写事件。
- 达到 max questions：lead agent 必须 draft with assumptions。
- Design file already has unstaged changes not produced by current session：停止并请求用户确认。
- Git commit fails：写 `design_commit_failed`，session 等待用户处理或重试。
- Council review reaches finalize with unresolved blocker：沿用 Agent Turn Signal v1 finalize gate。
- 用户取消：沿用 `session_cancel_requested`。

## 与现有 Council 的关系

`design_council` 是新的默认主入口，但不是替代 event loop。

它只是在现有 council 前增加：

```text
brainstorming prelude
-> design commit
```

后半段继续使用现有 council event loop。

旧 `mode=council` 保留，用于快速开放式讨论。

## 与 Workplan 的关系

Workplan 应基于最终 design commit：

```text
design.latest_commit
-> docs/designs/...md
-> workplan_create.md
-> workplan_created
```

Workplan brief 应包含：

- design artifact path
- latest design commit
- final council summary
- unresolved blockers / disagreements

## 增量实现建议

### Milestone 1：Brainstorming Prelude

- 新增 `brainstorming` phase。
- 支持 lead agent ask_or_draft。
- 支持 waiting_for_user 和 answer API。
- 不生成 design commit。

### Milestone 2：Design Draft + Draft Commit

- 生成 `docs/designs/...md`。
- 写文件前确保 `docs/designs/` 目录存在。
- 精确 git add design path。
- commit 第一版 design。
- 事件记录 commit hash。

### Milestone 3：Council Review Existing Loop

- phase transition 到 discussion。
- Council Brief 注入 design path / commit / summary。
- reviewer review / challenge / constructive optimize design。

### Milestone 4：Design Revision + Final Commit

- lead agent 根据 review 修订 design。
- commit revision。
- final summary 引用 latest commit。

### Milestone 5：Workplan Integration

- workplan 基于 latest design commit。
- 无 design commit 时拒绝生成 workplan。

## 测试策略

Engine tests：

- `design_council` session starts in brainstorming phase。
- session 创建阶段会校验所需 agent 可用，不可用时拒绝创建。
- `session_started.config` 记录 `lead_agent` 和 `max_questions` 的最终生效值。
- ask_user 输出会写 `brainstorming_question_created`，state 变为 waiting。
- `brainstorming_question_created.question_seq` 与 answer 的 `question_seq` 对齐。
- answer API 写 `brainstorming_answer_received` 并恢复 prelude。
- draft_design 输出会写 `design_file_written`。
- 写 design 前会创建 `docs/designs/` 目录。
- draft commit 只 stage design path。
- draft commit hash 写入事件。
- draft commit 失败会写 `design_commit_failed`，且保留已落盘 design file 状态。
- phase transition 到 discussion 后，现有 council loop 正常运行。
- council brief 包含 design commit。
- revision commit 记录 source commit。
- workplan 无 design commit 时返回 409。

Prompt tests：

- ask_or_draft 要求一次只问一个问题。
- design_draft 禁止 implementation plan。
- council route/decide 明确任务是 review/优化 design。

UI / API tests：

- waiting_for_user 时 composer 调用 brainstorming answer API。
- design commit 在 UI 中可见。
- raw events 显示 design commit 事件。
- 旧 council mode 不受影响。

## Open Questions

当前固定：

- Brainstorming prelude 是单 agent。
- 默认 lead agent 是 codex。
- Design draft 和 revision 都由 lead agent 修改。
- Reviewer 不写 design 文件。
- 第一版和修订版 design 都通过 git commit 管理。

后续单独讨论：

- Git commit 是否需要用户显式授权开关。
- design artifact 路径命名规则。
- dirty worktree 下的更严格策略。
- 是否支持用户手动编辑 design 后继续 council。
- 是否支持多 reviewer。
- 是否为 `design_council` 设置独立 `max_context_chars`。
