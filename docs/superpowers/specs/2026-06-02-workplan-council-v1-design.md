# Workplan Council v1 设计

## 目标

Workplan Council v1 的目标是把现有轻量 JSON workplan 生成器升级为一个 git-backed、可 review、需用户批准的 Markdown implementation plan 流程。

新 workplan 必须从 `design_council` 产出的 latest design commit 生成。AI_A 按照 writing-plans 风格的计划契约起草 Markdown workplan，AI_B 通过现有 council loop review / challenge / improve，AI_A 先回应 review 并决定采纳、部分采纳或不采纳；只有采纳或部分采纳时才修订 workplan 并形成 latest workplan commit。系统随后等待用户批准该 workplan，但 v1 不执行代码。

核心目标：

- workplan 来源必须是 `design.latest_commit`，而不是开放式 discussion summary。
- workplan 是 Markdown artifact，路径位于 `docs/workplans/YYYY-MM-DD-<slug>.md`。
- workplan 内容遵守 writing-plans 风格：文件边界、任务拆分、checkbox 步骤、具体命令和预期结果、无占位。
- review / revision 复用现有 design council 的 council loop、agent signal、finalize gate 和 policy override。
- AI_B 只 review workplan，不直接修改文件。
- AI_A 负责 draft、review response 和必要 revision，并为每个 artifact 版本创建 git commit。
- 用户批准是 workplan 完成后的硬门槛；批准前不允许进入后续代码执行。

## 非目标

v1 不包含：

- 代码执行。
- 按 workplan 自动修改项目文件。
- task assignment / execution / review phase 的实现。
- 用户逐 task 审批。
- 多个并行 workplan artifact。
- 继续保留旧 `workplan_created.workplan` JSON 产物作为新入口。
- 运行时直接依赖本机 Codex / Superpowers 的 `writing-plans/SKILL.md` 文件。

旧 JSON Workplan v1 将被废弃。新 session 的 `Generate Workplan` 只走 Workplan Council v1。现有测试、UI 和文档中关于 `workplan_created.workplan.tasks[]` 的逻辑应替换为 Markdown artifact 逻辑。

## 背景

当前 Workplan v1 通过 `engine/prompts/workplan_create.md` 单次调用 AI，输出严格 JSON：

```text
done session
-> workplan_generation_started
-> workplan_created(workplan JSON)
```

这个设计适合作为执行编排前的最小台阶，但它不是用户现在想要的协作形态。用户希望 workplan 本身也经历类似 design council 的流程：

```text
AI_A 起草
-> AI_B review
-> AI_A 回应 review，决定采纳 / 部分采纳 / 不采纳
-> [采纳或部分采纳时] AI_A 修订
-> 用户批准
```

同时，workplan 不应从泛化 discussion 直接生成，而应从已经通过 design council review 的 design artifact 生成。design commit 是上下文锚点，workplan commit 是后续执行的计划锚点。

`superpowers:writing-plans` skill 提供了很好的计划质量标准：完整文件边界、bite-sized tasks、TDD、明确命令、预期结果、无 TBD / TODO / 泛泛描述。PatchCouncil 应参考这份 contract，但不应把运行时绑到用户机器上的 Codex skill 文件。因此 v1 采用 PatchCouncil-native skill pack，把 writing-plans 的核心规则内置到 prompt 和 review 标准中。

## 总体流程

```text
design_council session 已完成
-> state.design.latest_commit 存在
-> 用户点击 Generate Workplan
-> AI_A 读取 latest design artifact / commit
-> AI_A 按 writing-plans contract 生成 Markdown workplan draft
-> 写入 docs/workplans/YYYY-MM-DD-<slug>.md
-> git commit draft workplan
-> 复用 council loop review / challenge workplan
-> AI_B 输出 review 和 signal
-> 如有 blocker 或 revise 建议，AI_A 输出 author response 和 signal
-> [采纳或部分采纳时] AI_A 修订 workplan
-> [采纳或部分采纳时] git commit revised workplan
-> [不采纳时] 回到 council decide，让 reviewer / coordinator 看到 AI_A 的理由
-> council finalize workplan review
-> workplan_approval_requested
-> session status = waiting_for_user, waiting_for = workplan_approval
-> 用户 approve 或 reject
```

批准后只记录批准事实：

```text
workplan_approved
```

v1 不会自动进入 execution。后续“按 workplan 实现代码”单独设计。

## Phase 约定

Workplan Council v1 发生在 design discussion 已经收束之后。它是 post-discussion artifact lifecycle，不引入新的 top-level phase。

因此本组 workplan 事件统一使用：

```text
phase = finalized
```

含义：

- `phase` 仍表示 session 的讨论阶段已经结束，而不是 workplan 自身的 draft / review / revision 状态。
- workplan 自身生命周期通过事件类型和 `state.workplan.status` 表达。
- 这延续旧 Workplan v1 的 post-discussion artifact 语义，但 artifact 生命周期从单次 JSON 生成扩展为 draft / review / revision / approval。

后续如果代码执行阶段落地，再单独启用 `task_assignment`、`execution`、`review` 等 phase。Workplan Council v1 不提前占用这些 phase。

## 与 Design Council 的关系

Workplan Council v1 应复用 Design Council 的核心形态，而不是发明独立 review 状态机。

Design Council：

```text
brainstorming
-> design draft
-> design commit
-> council review design
-> design revision commit
-> finalized
```

Workplan Council：

```text
design latest commit
-> workplan draft
-> workplan commit
-> council review workplan
-> workplan revision commit
-> approval requested
```

复用点：

- coordinator route / decide / finalize。
- `agent_turn_completed.signal`。
- finalize gate。
- `policy_override`。
- reviewer 只 review，不写 artifact。
- lead / author agent 负责回应 review，决定是否修订；只有采纳或部分采纳建议时才写 revision。
- artifact path + commit hash 作为上下文锚点。
- Workbench chat/event 投影。

差异点：

- review 对象从 design document 变成 implementation plan。
- brief 必须强调“不要实现代码”。
- finalize 后不是 `session_finished` 的终点，而是进入 `waiting_for_user: workplan_approval`。
- workplan 只能从 design latest commit 生成。

### Review Loop 边界

Workplan review 走完整 coordinator route / decide / finalize 机制，而不是固定一次 AI_B review。

规则：

- 首轮 reviewer 仍由 coordinator 路由选择；策略层可以像 Design Council 一样避免退化为单 agent。
- `workplan_review.md` 是通用 reviewer prompt，任何被选中的 reviewer agent 都使用同一 contract。
- `min_distinct_agents` 和 `finalize_gate_max_overrides` 继续适用；AI_A 的 author response 也写入 `agent_turn_completed.signal`，因此 finalize gate 可以同时看到 reviewer 和 author 的最新立场。
- 允许多轮 review。每个 reviewer 发言仍由 `agent_turn_started` / `agent_turn_completed` 记录；`workplan_review_started` / `workplan_review_completed` 只是标记某次 review turn 的 artifact 边界。
- 如果 latest review signal 包含 blocker，engine 不请求用户批准，先触发 AI_A author response。AI_A 必须明确 `accept` / `partially_accept` / `reject`，并解释理由。
- 如果 AI_A 采纳或部分采纳 review，engine 写 revision artifact 并继续 review / decide。
- 如果 AI_A 不采纳 review，engine 不写 revision artifact；该回应作为 `agent_turn_completed` 进入 transcript，由 coordinator 决定继续让 reviewer 反驳、让其他 agent 评估，或在无 blocker 时 finalize。
- 如果 latest review signal 没有 blocker，coordinator finalize 后才写 `workplan_approval_requested`。

这意味着 Workplan Council 不是“AI_B 一票通过”的流程，而是复用现有 council loop 的多轮审查机制，只是审查对象换成 workplan artifact。

## Native Skill Pack

新增 PatchCouncil 内置 skill pack：

```text
apps/patchcouncil-ui/engine/skills/workplan-council/
  skill.yaml
  prompts/
    workplan_draft.md
    workplan_review.md
    workplan_author_response.md
    workplan_revision.md
    workplan_finalize.md
```

`skill.yaml` 建议：

```yaml
id: workplan_council
title: Workplan Council
version: 1

source_artifact: design
artifact: workplan
artifact_dir: docs/workplans
author_agent: codex
reviewer_policy: council_loop

required_contract:
  format: markdown
  style: writing-plans
  requires_user_approval: true
  execution_allowed: false
```

这份 skill pack 参考 `superpowers:writing-plans`，但运行时不读取或依赖 `.codex/plugins/.../writing-plans/SKILL.md`。原因：

- PatchCouncil 产品行为应独立于本机 Codex 插件安装状态。
- skill contract 需要随项目版本管理。
- prompt 和测试需要稳定可回放。

## Workplan Contract

workplan artifact 是 Markdown 文档，必须符合以下规则。

### 文件路径

默认路径：

```text
docs/workplans/YYYY-MM-DD-<slug>.md
```

不要写到 `docs/superpowers/plans/`。`docs/superpowers/plans/` 是当前开发协作过程文档；`docs/workplans/` 是 PatchCouncil 产品产出的用户 workplan artifact。

### 文档头部

每份 workplan 必须以类似结构开始：

```markdown
# <Feature Name> Implementation Plan

> For agentic workers: This plan is generated by PatchCouncil Workplan Council. Execute only after user approval.

**Source Design:** docs/designs/<file>.md
**Source Design Commit:** <commit>
**Goal:** <one sentence>
**Architecture:** <2-3 sentence approach>
**Tech Stack:** <key technologies>

---
```

可以使用中文内容，但标题结构必须稳定，便于后续执行器解析。

### 文件边界

workplan 必须在任务前列出文件边界：

```markdown
## File Structure

- Create: `path/to/new-file.js` - responsibility.
- Modify: `path/to/existing-file.js` - responsibility.
- Test: `path/to/test.js` - coverage.
```

如果某个文件不确定，必须写明不确定原因，不能留空或写 TBD。

### 任务结构

每个任务必须是可独立验证的工程改动：

```markdown
### Task 1: Workplan Events

**Files:**
- Modify: `apps/patchcouncil-ui/engine/events.js`
- Modify: `apps/patchcouncil-ui/scripts/council-smoke.js`

- [ ] **Step 1: Write the failing test**

...

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run smoke`
Expected: FAIL with ...

- [ ] **Step 3: Implement the minimal change**

...

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run smoke`
Expected: PASS

- [ ] **Step 5: Commit**

Run: `git add ... && git commit -m "..."`
```

规则：

- 每个任务必须包含 checkbox 步骤。
- 每个任务必须包含至少一个验证命令或人工验证步骤。
- 命令必须来自项目实际支持的命令，优先使用 `npm run check`、`npm run smoke`、`npm run runtime:fake`。
- 不得编造不存在的命令。
- 不得使用 `TBD`、`TODO`、`implement later`、`add appropriate error handling`、`write tests for this` 等占位。
- 不得让一个任务覆盖整个功能。
- 不得把纯机械编辑拆成过多细碎任务。
- 不得要求执行代码实现；workplan 只描述未来执行步骤。

### 自检

workplan 末尾必须包含 self-review：

```markdown
## Self-Review

- Spec coverage: ...
- Placeholder scan: ...
- Type / naming consistency: ...
- Scope check: ...
```

AI_A 在 draft 和 revision 时都必须执行这个自检，并把结果写入文档。

## Prompt 设计

### workplan_draft.md

输入：

- 原始 topic。
- design artifact path。
- design latest commit。
- design 文档内容或摘要。
- final design council summary。
- unresolved blockers / disagreements。
- 项目上下文和支持命令。

输出：

- Markdown workplan。
- 不输出 JSON。
- 不输出 Markdown fence。
- 不执行命令。
- 不修改代码。

关键约束：

```text
You are drafting a writing-plans-style implementation plan from an approved design artifact.
Do not implement code.
Do not ask follow-up questions.
If information is missing, make conservative assumptions and record them in risks/self-review.
```

### workplan_review.md

reviewer 检查：

- 是否真实基于 source design。
- 是否遗漏 design requirement。
- 是否任务过大或过碎。
- 是否文件边界清晰。
- 是否每个 task 有具体验证。
- 是否存在 TBD / TODO / 泛泛步骤。
- 是否编造命令。
- 是否不小心要求执行代码。
- 是否批准前就假设会执行。

review 输出仍使用 `agent_turn_completed.content` + `signal`：

- `blockers`：必须修订后才能请求用户批准的问题。
- `disagreements`：可带入最终总结的分歧。
- `recommended_next_step`：通常是 revise / ready for approval。

### workplan_revision.md

AI_A revision 只能在 author response 决定 `accept` 或 `partially_accept` 后运行。它读取：

- source design path。
- source design commit。
- source design 文档内容或摘要。
- 当前 workplan 文件。
- latest workplan commit。
- reviewer content。
- reviewer signal。
- author response。
- author signal。

输出修订后的完整 Markdown workplan。不要输出 patch，不要只输出片段。

### workplan_author_response.md

AI_A 读取：

- source design path。
- source design commit。
- 当前 workplan 文件。
- latest workplan commit。
- reviewer content。
- reviewer signal。

输出严格 JSON，作为 `agent_turn_completed` 的 content + signal 来源：

```json
{
  "decision": "accept | partially_accept | reject",
  "reason": "string",
  "revision_required": true,
  "stance": "agree | disagree | mixed",
  "confidence": "low | medium | high",
  "finalize_readiness": "ready | not_ready",
  "blockers": [{ "type": "issue | question", "text": "string" }],
  "agreements": ["string"],
  "disagreements": ["string"],
  "recommended_next_step": "string",
  "analysis": "string"
}
```

规则：

- `decision=accept` 或 `partially_accept` 时，通常 `revision_required=true`。
- `decision=reject` 时，必须在 `reason` / `analysis` 中解释为什么不采纳 reviewer 建议。
- 不采纳不等于忽略 reviewer；该回应会展示给 reviewer 和 coordinator。
- author response 本身不写文件。只有后续 revision prompt 才能写 workplan artifact。

### workplan_finalize.md

coordinator 在 workplan review loop 中使用独立 finalize prompt，而不是直接复用 design finalize prompt。

输入：

- source design path / commit。
- latest workplan path / commit。
- latest reviewer signals。
- unresolved blockers / disagreements。

输出仍使用现有 coordinator JSON 决策格式，但判断标准是：

- workplan 是否覆盖 source design 的实现需求。
- workplan 是否符合 writing-plans contract。
- 是否存在未解决 blocker。
- 是否可以请求用户批准。

如果可以请求批准，engine 写 `workplan_approval_requested`；如果仍有 blocker，engine 继续 route reviewer 或触发 AI_A revision。

## Event Model

废弃新流程中的旧事件语义：

```text
workplan_created(workplan JSON)
```

新增事件：

```text
workplan_draft_started
workplan_draft_written
workplan_draft_committed
workplan_review_started
workplan_review_completed
workplan_author_response_started
workplan_author_response_completed
workplan_revision_written
workplan_revision_committed
workplan_draft_commit_failed
workplan_revision_commit_failed
workplan_approval_requested
workplan_approved
workplan_approval_rejected
workplan_generation_failed
```

### workplan_draft_started

```json
{
  "type": "workplan_draft_started",
  "phase": "finalized",
  "session_id": "20260602-abc",
  "generator": "codex",
  "source_design_path": "docs/designs/2026-06-02-feature.md",
  "source_design_commit": "abc123"
}
```

### workplan_draft_written

```json
{
  "type": "workplan_draft_written",
  "phase": "finalized",
  "session_id": "20260602-abc",
  "artifact_path": "docs/workplans/2026-06-02-feature.md",
  "generator": "codex",
  "source_design_commit": "abc123",
  "title": "Feature Implementation Plan",
  "revision": 0
}
```

### workplan_draft_committed

```json
{
  "type": "workplan_draft_committed",
  "phase": "finalized",
  "session_id": "20260602-abc",
  "artifact_path": "docs/workplans/2026-06-02-feature.md",
  "source_design_commit": "abc123",
  "commit": "def456",
  "commit_message": "docs: draft feature workplan"
}
```

### workplan_draft_commit_failed / workplan_revision_commit_failed

如果 workplan 文件已经写入，但 git commit 失败，需要用独立事件表达“artifact 已落盘但未形成 commit”。不要只写泛化 `workplan_generation_failed`，否则 state 无法准确区分 `draft_written` 和 commit failure。

```json
{
  "type": "workplan_draft_commit_failed",
  "phase": "finalized",
  "session_id": "20260602-abc",
  "artifact_path": "docs/workplans/2026-06-02-feature.md",
  "source_design_commit": "abc123",
  "stage": "draft_commit",
  "error": "git commit failed"
}
```

```json
{
  "type": "workplan_revision_commit_failed",
  "phase": "finalized",
  "session_id": "20260602-abc",
  "artifact_path": "docs/workplans/2026-06-02-feature.md",
  "source_design_commit": "abc123",
  "source_workplan_commit": "def456",
  "stage": "revision_commit",
  "error": "git commit failed"
}
```

### workplan_review_started / workplan_review_completed

review 可以复用现有 `agent_turn_completed` 表达 reviewer 发言。新增 workplan review 事件用于明确 review 对象和边界：

```json
{
  "type": "workplan_review_started",
  "phase": "finalized",
  "session_id": "20260602-abc",
  "artifact_path": "docs/workplans/2026-06-02-feature.md",
  "workplan_commit": "def456",
  "reviewer": "claude"
}
```

```json
{
  "type": "workplan_review_completed",
  "phase": "finalized",
  "session_id": "20260602-abc",
  "artifact_path": "docs/workplans/2026-06-02-feature.md",
  "workplan_commit": "def456",
  "reviewer": "claude",
  "source_agent_turn_seq": 24,
  "requires_revision": true
}
```

### workplan_author_response_started / workplan_author_response_completed

当 reviewer 提出 blocker 或 revise 建议后，AI_A 必须先回应 review，而不是直接静默修文件。

author response 同时写入一条 `agent_turn_completed(agent=AI_A, signal=...)`，用于让 UI 展示 AI_A 的理由，并让 finalize gate 看到 author 的最新立场。

```json
{
  "type": "workplan_author_response_started",
  "phase": "finalized",
  "session_id": "20260602-abc",
  "artifact_path": "docs/workplans/2026-06-02-feature.md",
  "workplan_commit": "def456",
  "author": "codex",
  "source_review_seq": 24
}
```

```json
{
  "type": "workplan_author_response_completed",
  "phase": "finalized",
  "session_id": "20260602-abc",
  "artifact_path": "docs/workplans/2026-06-02-feature.md",
  "workplan_commit": "def456",
  "author": "codex",
  "source_review_seq": 24,
  "source_agent_turn_seq": 25,
  "decision": "partially_accept",
  "revision_required": true
}
```

### workplan_revision_written / workplan_revision_committed

```json
{
  "type": "workplan_revision_written",
  "phase": "finalized",
  "session_id": "20260602-abc",
  "artifact_path": "docs/workplans/2026-06-02-feature.md",
  "source_design_commit": "abc123",
  "source_workplan_commit": "def456",
  "source_review_seq": 24,
  "generator": "codex",
  "revision": 1
}
```

```json
{
  "type": "workplan_revision_committed",
  "phase": "finalized",
  "session_id": "20260602-abc",
  "artifact_path": "docs/workplans/2026-06-02-feature.md",
  "source_design_commit": "abc123",
  "source_workplan_commit": "def456",
  "commit": "ghi789",
  "commit_message": "docs: revise feature workplan"
}
```

### workplan_approval_requested

```json
{
  "type": "workplan_approval_requested",
  "phase": "finalized",
  "session_id": "20260602-abc",
  "artifact_path": "docs/workplans/2026-06-02-feature.md",
  "workplan_commit": "ghi789",
  "requested_at": "2026-06-02T14:00:00+08:00"
}
```

该事件使 session 派生状态进入：

```text
status = waiting_for_user
waiting_for = workplan_approval
```

### workplan_approved

```json
{
  "type": "workplan_approved",
  "phase": "finalized",
  "session_id": "20260602-abc",
  "artifact_path": "docs/workplans/2026-06-02-feature.md",
  "approved_commit": "ghi789",
  "approved_at": "2026-06-02T14:05:00+08:00",
  "approved_by": "host"
}
```

### workplan_approval_rejected

```json
{
  "type": "workplan_approval_rejected",
  "phase": "finalized",
  "session_id": "20260602-abc",
  "artifact_path": "docs/workplans/2026-06-02-feature.md",
  "workplan_commit": "ghi789",
  "rejected_at": "2026-06-02T14:05:00+08:00",
  "reason": "用户希望调整任务拆分"
}
```

reject 后不自动重生成。用户可以通过 Continue/Fork 或后续专门的 revision 入口继续讨论。

## Migration

旧 JSON Workplan v1 不作为新入口保留，但旧 session 的事件日志仍可能包含：

```text
workplan_generation_started
workplan_created
workplan_generation_failed
```

迁移策略：

- 新流程不再写 `workplan_created(workplan JSON)`。
- `workplan_created` 不改语义，不复用为 Markdown workplan ready 事件，避免同名事件双重含义。
- state derivation 和 transcript renderer 可以继续兼容读取旧 session 中的 `workplan_created`，但 UI 新入口不再生成它。
- tests 应覆盖“旧事件可读”和“新入口不写旧事件”两个行为。
- 后续如果决定清理旧代码，应在单独迁移任务中删除旧 JSON parser / validator / prompt，并保留 replay 兼容层。

## State Projection

`state.json` 增加 `workplan` 投影：

```json
{
  "workplan": {
    "artifact_path": "docs/workplans/2026-06-02-feature.md",
    "source_design_commit": "abc123",
    "draft_commit": "def456",
    "latest_commit": "ghi789",
    "approved_commit": null,
    "status": "awaiting_approval",
    "title": "Feature Implementation Plan",
    "revision": 1
  },
  "waiting_for": "workplan_approval"
}
```

`latest_commit` 派生规则：

- 没有 commit 事件时为 `null`。
- draft 后 review 前，取最后一个 `workplan_draft_committed.commit`。
- revision 后，取最后一个 `workplan_revision_committed.commit`。
- 总规则是取最后一个 workplan `*_committed` 事件中的 `commit`。
- `approved_commit` 只来自 `workplan_approved.approved_commit`，不等同于 latest commit，除非用户批准了当前 latest commit。

`workplan.status` 取值：

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
```

派生规则：

- 没有 workplan 事件：`none`。
- `workplan_draft_started` 后：`drafting`。
- `workplan_draft_written` 后：`draft_written`。
- `workplan_draft_committed` 后：`draft_committed`。
- `workplan_review_started` 后：`reviewing`。
- `workplan_review_completed` 后：`reviewed`。
- `workplan_author_response_started` 后：`author_responding`。
- `workplan_author_response_completed` 后：`author_responded`。
- `workplan_revision_written` 后：`revision_written`。
- `workplan_revision_committed` 后：`revision_committed`。
- `workplan_draft_commit_failed` 后：`draft_commit_failed`。
- `workplan_revision_commit_failed` 后：`revision_commit_failed`。
- `workplan_approval_requested` 后：`awaiting_approval`，session `status=waiting_for_user`。
- `workplan_approved` 后：`approved`，session 可以回到 `done`，但不执行代码。
- `workplan_approval_rejected` 后：`rejected`。
- `workplan_generation_failed` 后：`failed`。

## API

### 生成 workplan

```http
POST /api/sessions/:id/workplan
```

规则：

- session 必须存在。
- session 必须是 `mode=design_council`。
- session 必须有 `state.design.latest_commit`。
- 如果已有 workplan 且状态不是 `failed` / `rejected`，返回 `409`。
- `rejected` 状态下允许重新调用该接口生成新的 workplan attempt；新 attempt 必须引用同一个或更新后的 `design.latest_commit`，并生成新的 draft/revision commit。
- 如果 design latest commit 与现有 workplan 的 `source_design_commit` 不一致，旧 workplan 视为基于旧 design；必须重新生成或明确重新批准新 design 下的 workplan。
- 生成过程异步执行，先返回 `202`。
- 生成失败写 `workplan_generation_failed`。

成功响应：

```json
{
  "session_id": "20260602-abc",
  "status": "generating"
}
```

### 批准 workplan

```http
POST /api/sessions/:id/workplan/approve
```

规则：

- 必须存在 `workplan_approval_requested`。
- session 当前状态必须是 `waiting_for_user`。
- `waiting_for` 必须是 `workplan_approval`。
- 当前 latest workplan commit 必须等于 approval request 中的 commit。
- 已批准时返回 `409`。
- 批准只写事件，不执行代码。

### 拒绝 workplan

```http
POST /api/sessions/:id/workplan/reject
{
  "reason": "string"
}
```

规则：

- 必须存在 `workplan_approval_requested`。
- session 当前状态必须是 `waiting_for_user`。
- `waiting_for` 必须是 `workplan_approval`。
- 拒绝只写事件，不自动 revision。
- reject 后允许再次调用 `POST /api/sessions/:id/workplan` 重新生成 workplan；不新增专门 revision API。

## Git Rules

Workplan artifact 必须通过 git 管理。

draft：

```text
git add docs/workplans/YYYY-MM-DD-<slug>.md
git commit -m "docs: draft <topic> workplan"
```

revision：

```text
git add docs/workplans/YYYY-MM-DD-<slug>.md
git commit -m "docs: revise <topic> workplan"
```

规则：

- 只允许 stage workplan artifact 文件。
- 不允许 stage unrelated dirty files。
- dirty worktree 不阻止提交，但必须精确 `git add <workplan-path>`。
- 如果 workplan 文件已有用户未提交改动，engine 必须停止并写失败事件，不可覆盖。
- commit 失败写 `workplan_draft_commit_failed` 或 `workplan_revision_commit_failed`；如果失败发生在文件写入之前，才写泛化 `workplan_generation_failed`。
- 写文件前，engine 必须确保 `docs/workplans/` 目录存在。

## UI

Workbench 在已完成的 design council session 中展示 Workplan 面板。

状态：

```text
design latest commit exists + no workplan -> Generate Workplan
drafting/reviewing/revising -> 显示生成中 / review 中 / 修订中
awaiting_approval -> 显示 artifact path、commit hash、Approve / Reject
approved -> 显示 approved commit
rejected -> 显示 rejected reason，并提示 Continue/Fork
failed -> 显示失败原因和重试入口
```

中间状态归并展示：

- `drafting`、`draft_written`、`draft_committed`：显示为“生成 workplan draft”进度。
- `reviewing`、`reviewed`：显示为“review workplan”进度。
- `author_responding`、`author_responded`：显示为“author responding to review”进度或回应摘要。
- `revision_written`、`revision_committed`：显示为“修订 workplan”进度。
- `draft_commit_failed`、`revision_commit_failed`、`failed`：显示失败原因和可重试入口。
- `awaiting_approval`：显示 artifact path、latest commit、Approve / Reject。

Workplan 卡片展示：

- title。
- artifact path。
- source design commit。
- latest workplan commit。
- review 状态。
- approval 状态。

如果 workplan 文件存在，UI 可以提供打开路径或显示摘要。v1 不要求在浏览器中渲染完整 Markdown。

## Error Handling

- session 不是 `design_council`：`409`。
- 缺少 design latest commit：`409`。
- design artifact 文件不存在：写 `workplan_generation_failed`。
- draft prompt 输出为空：写 `workplan_generation_failed`。
- draft 内容不符合基本 contract：写 `workplan_generation_failed` 或交给 reviewer 标记 blocker。
- workplan 文件已有用户改动：写 `workplan_generation_failed`，action 为 `ask_user_to_resolve_dirty_workplan`。
- git commit 失败：写 `workplan_generation_failed`。
- reviewer runtime 失败：写 `workplan_generation_failed`。
- reviewer 有 blocker：不请求 approval，AI_A 先产生 author response；采纳或部分采纳时 revision 后继续 review/finalize gate，不采纳时直接回到 coordinator decide。
- approval request 后用户 reject：写 `workplan_approval_rejected`，不自动执行任何后续动作。

## 测试策略

Engine / event tests：

- 新 workplan 事件常量和构造函数存在。
- `state.workplan` 能从事件流派生。
- `workplan_approval_requested` 派生 `status=waiting_for_user` 和 `waiting_for=workplan_approval`。
- `workplan_approved` 派生 `workplan.status=approved`，但不触发 execution。
- `workplan_approval_rejected` 派生 `workplan.status=rejected`。
- `latest_commit` 取最后一个 workplan `*_committed` 事件。
- 缺少 design latest commit 时，生成 workplan 返回 `409`。
- 旧 `workplan_created.workplan` JSON 逻辑不再作为新入口出现。

Artifact tests：

- draft 写入 `docs/workplans/...md`。
- draft commit 只 stage workplan path。
- revision commit 只 stage workplan path。
- dirty workplan 文件不被覆盖。
- transcript 渲染 workplan artifact path、commit 和 approval 状态。
- fake runtime 集成测试覆盖：AI_A draft -> AI_B review -> AI_A author response -> [必要时] AI_A revision -> coordinator finalize -> approval requested。
- author response 必须写 `agent_turn_completed(agent=AI_A)`，让 finalize gate 能看到 AI_A 对 review 的立场。
- 多轮 review 时，每轮 reviewer turn 都写 `agent_turn_completed`，并用 `workplan_review_started` / `workplan_review_completed` 绑定 artifact commit。

Prompt / contract tests：

- draft prompt 明确要求 writing-plans-style Markdown。
- draft prompt 禁止代码执行。
- review prompt 检查 TBD / TODO / 泛泛步骤。
- review prompt 检查是否从 source design 生成。
- author response prompt 检查 AI_A 是否明确采纳 / 部分采纳 / 不采纳 reviewer 建议。
- revision prompt 要求输出完整 Markdown，不输出 patch。
- revision prompt 必须包含 source design path / commit。
- finalize prompt 判断是否可以请求用户批准，而不是判断是否可以执行代码。

Server API tests：

- `POST /api/sessions/:id/workplan` 对有 design commit 的 design council session 返回 `202`。
- 普通 council session 返回 `409`。
- 无 design commit 的 design council session 返回 `409`。
- 已 awaiting approval / approved 的 session 再生成返回 `409`。
- `POST /api/sessions/:id/workplan/approve` 在 awaiting approval 时写 `workplan_approved`。
- approve 已批准 workplan 返回 `409`。
- reject 写 `workplan_approval_rejected`。

UI smoke：

- 有 design latest commit 且无 workplan 时显示 `Generate Workplan`。
- awaiting approval 时显示 `Approve` / `Reject`。
- approved 后不显示执行入口。
- failed 后显示失败原因。

## 后续

Workplan Council v1 完成后，下一阶段可以单独设计代码执行：

```text
approved workplan commit
-> task assignment
-> execution
-> review
-> fix
-> task completed
```

该阶段应只消费 `workplan.approved_commit`，不能消费未批准 workplan。

## Open Questions

当前固定：

- workplan 必须从 design latest commit 生成。
- workplan 是 Markdown artifact。
- workplan 需要 AI_B review。
- AI_A 负责 draft、author response 和必要 revision。
- reviewer 不写文件。
- 用户批准前不执行代码。
- 旧 JSON workplan 新入口废弃。

后续可单独讨论：

- 是否允许用户手动编辑 workplan 后重新进入 review。
- 是否在 UI 中渲染完整 Markdown。
- 是否支持多个 reviewer。
- 是否支持为 Workplan Council 设置独立 context budget。
