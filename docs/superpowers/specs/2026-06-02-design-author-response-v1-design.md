# Design Author Response v1

## 背景

Design Council Workflow v1 已经能完成：

- brainstorming prelude。
- 写入 `docs/designs/...md`。
- git commit design draft。
- 进入 council loop 让 reviewer review / challenge / improve design。
- reviewer signal 有 blocker 或 `recommended_next_step` 包含 `revise` 时，由 lead agent 写 `design_revision_written` / `design_revision_committed`。

当前问题是：reviewer 提出问题后，engine 会直接调用 `reviseDesignFromLatestReview()`。lead agent 可能在 `design_revision.md` 内部自行判断哪些建议值得采纳，但这个判断不可见、不可审计，也没有作为回复返回给 reviewer / coordinator。

这和 Workplan Council v1 已确定的 author-response 模型不一致。Design artifact 同样需要让 author 对 review 做明确回应：采纳、部分采纳或不采纳。

## 目标

Design Author Response v1 的目标是把 Design Council 的 revision 流程改成：

```text
reviewer review design
-> reviewer 输出 agent_turn_completed.signal
-> 如有 blocker 或 revise 建议，lead 先输出 author response 和 signal
-> [accept 或 partially_accept 且 revision_required=true] lead 修订 design 并提交 revision commit
-> [reject 或 revision_required=false] 不写 design artifact，回到 council decide
-> coordinator 根据 reviewer 和 lead 的最新 signal 决定继续 review、让其他 agent 评估或 finalize
```

核心要求：

- lead 不应静默修改 design。
- lead 必须明确 `accept | partially_accept | reject`。
- lead 不采纳 reviewer 建议时，必须说明原因。
- lead 的回应必须写入 `agent_turn_completed.signal`，让 finalize gate 能看到 lead 的最新立场。
- `design_revision.md` 只能在 lead author response 决定需要 revision 后运行。
- reviewer 仍然不写 artifact。
- 用户交互方式不变；这是 council 内部 artifact review 语义修正。

## 非目标

- 不改变 brainstorming prelude。
- 不改变 design artifact 的目录和 Markdown contract。
- 不要求用户批准 design。用户批准仍是 Workplan Council 的门槛。
- 不改 Workplan Council v1 已设计的 author-response 流程。
- 不引入新的 UI 大改版；Workbench 只需要能展示 author response 事件。

## 现有行为

当前 `CouncilEngine.run()` 中，agent turn 完成后有这段逻辑：

```js
const hasBlocker = signal && Array.isArray(signal.blockers) && signal.blockers.length > 0;
const recommendRevise = signal && typeof signal.recommended_next_step === "string" && /revise/i.test(signal.recommended_next_step);
if (hasBlocker || recommendRevise) {
  await this.reviseDesignFromLatestReview(topic, reviewEvent);
}
```

`reviseDesignFromLatestReview()` 读取 latest design file / commit，把 reviewer content 和 signal 拼成 findings，直接渲染 `design_revision.md`，写入同一路径并提交 revision commit。

这会造成三个问题：

- lead 对 review 的判断没有事件表达。
- lead 不采纳某个 reviewer 建议时没有回复。
- finalize gate 只看到 reviewer 的 `agent_turn_completed.signal`，看不到 lead 对 blocker 的处理态度。

## 新流程

### Review Trigger

触发条件保持不变：

- reviewer signal 有 `blockers`。
- 或 reviewer signal 的 `recommended_next_step` 包含 `revise`。

但触发动作从“直接 revision”改为“lead author response”。

### Lead Author Response

新增 prompt：`apps/patchcouncil-ui/engine/prompts/design_author_response.md`。

输入：

- source design path。
- source design commit。
- 当前 design 文档。
- reviewer content。
- reviewer signal。

输出严格 JSON：

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

- `decision=accept` 表示 reviewer 建议成立，lead 会修订 design。
- `decision=partially_accept` 表示部分采纳，lead 必须说明采纳和不采纳的边界。
- `decision=reject` 表示不采纳，lead 必须说明 reviewer finding 为什么不适用于当前 design / project constraints。
- `revision_required=false` 表示 lead 认为无需写 artifact。此时不能运行 `design_revision.md`。
- 如果仍有 unresolved blocker，`finalize_readiness` 必须是 `not_ready`。

author response 同时写入一条 `agent_turn_completed(agent=lead_agent, signal=...)`。这条 agent turn 是 lead 对 reviewer 的正式回应，进入 transcript 和 finalize gate。

### Optional Revision

`design_revision.md` 不再负责判断是否采纳 review。它只负责在 author response 已决定 revision 后，输出完整 revised Markdown design。

revision prompt 输入应增加：

- author response JSON。
- author signal JSON。
- source review seq。
- latest design path / commit。

运行条件：

```text
decision in ["accept", "partially_accept"] && revision_required === true
```

其他情况不写文件、不提交 commit，回到 council decide。

## Event Model

新增事件：

```text
design_author_response_started
design_author_response_completed
```

### design_author_response_started

```json
{
  "type": "design_author_response_started",
  "phase": "discussion",
  "session_id": "20260602-abc",
  "artifact_path": "docs/designs/2026-06-02-feature.md",
  "design_commit": "abc123",
  "author": "codex",
  "source_review_seq": 12
}
```

> `phase` 由 engine 在运行时根据 `this.phase` 自动填充。Author response 在 council discussion loop 中触发，此时 phase 已是 `"discussion"`。上例中的 `"discussion"` 仅作示意。

### design_author_response_completed

```json
{
  "type": "design_author_response_completed",
  "phase": "discussion",
  "session_id": "20260602-abc",
  "artifact_path": "docs/designs/2026-06-02-feature.md",
  "design_commit": "abc123",
  "author": "codex",
  "source_review_seq": 12,
  "source_agent_turn_seq": 13,
  "decision": "partially_accept",
  "revision_required": true
}
```

`phase` 继续沿用当前 Design Council 事件流中的 phase（此时为 `"discussion"`），不新增 artifact-specific phase。

`source_agent_turn_seq` 指向 author response 过程中产出的 `agent_turn_completed(agent=lead_agent)` 事件的 seq，用于将 author response 事件与对应的 lead agent turn 关联。

`design_revision_written.source_review_seq` 继续指向 reviewer 的 original review event，而不是 author response event。revision event 可额外记录 `source_author_response_seq`，方便审计是哪次 lead response 触发 revision。

## State Projection

`state.design.status` 新增：

- `author_responding`
- `author_responded`

派生规则：

- `design_author_response_started` 后：`author_responding`。
- `design_author_response_completed` 后：`author_responded`。
- 如果后续出现 `design_revision_written` / `design_revision_committed`，按现有 revision 状态覆盖。
- 如果 author response reject 后没有 revision，状态停留在 `author_responded`，直到后续 reviewer turn 或 finalize。

## Transcript / UI

Transcript 应渲染：

- author。
- artifact path。
- design commit。
- decision。
- revision_required。

Workbench 不需要新增复杂控件。中间态展示为：

- `author_responding`：lead responding to design review。
- `author_responded`：lead responded to design review。

finalize 后仍按现有 session status 展示。

## 与 Workplan Council 的关系

Design Author Response 和 Workplan Author Response 保持同构：

- review 不直接修改 artifact。
- author 先回应 review。
- accept / partially_accept 才可能 revision。
- reject 必须说明原因并回到 council loop。
- author response 写 `agent_turn_completed.signal`。

差异：

- Design Council 不需要用户批准。
- Design Council 的 phase 仍跟随 brainstorming/finalized session lifecycle。
- Workplan Council 的 artifact 完成后进入 `waiting_for_user=workplan_approval`。

## 测试策略

Unit / smoke tests：

- author response event constants 存在。
- author response started / completed 可以派生 `state.design.status`。
- transcript 渲染 author response decision。
- fake runtime 覆盖 reviewer 提出 revise -> lead partially_accept -> design revision committed。
- fake runtime 覆盖 reviewer 提出 revise -> lead reject -> 不写 `design_revision_written`，但写 `agent_turn_completed(agent=lead)` 和 `design_author_response_completed`。
- finalize gate 可以看到 reviewer 和 lead 两个 distinct signals。

Prompt tests：

- `design_author_response.md` 要求 strict JSON。
- `design_author_response.md` 包含 `accept | partially_accept | reject`。
- `design_author_response.md` 禁止修改文件、禁止输出 revised design。
- `design_revision.md` 包含 author response / author signal 输入。

## 迁移

旧 session 不需要迁移。已有 `design_revision_written` / `design_revision_committed` 事件仍按旧语义 replay。

新逻辑上线后，新的 design revision 必须经过 `design_author_response_completed`。如果遇到旧 transcript 没有该事件但已有 revision event，state 和 transcript 仍应兼容读取。

## Self-Review

- Spec coverage：覆盖 trigger、author response、optional revision、events、state、transcript/UI、tests 和 migration。
- Placeholder scan：无占位要求。
- Type consistency：事件名、状态名、decision 字段和 Workplan Council author-response 模型一致。
- Scope check：仅修正 Design Council review/revision 语义，不触碰 workplan 执行和用户批准流程。
