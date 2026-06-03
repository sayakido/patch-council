# Design Author Response v1 实现计划

> **给 agentic workers：** 必须使用子技能：`superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，按任务逐步实现本计划。步骤使用 checkbox（`- [ ]`）语法追踪。

**目标：** 让 Design Council 的 lead agent 在写 design revision 前，先显式回应 reviewer findings。

**架构：** 继续以 `transcript.jsonl` 作为唯一事实源。新增 design author-response 事件和 `design_author_response.md` prompt，并修改现有 `CouncilEngine` design revision hook：reviewer 的 blocker/revise signal 先触发 lead author response，只有 lead 明确采纳或部分采纳并要求 revision 时才运行 `design_revision.md`。

**技术栈：** Node.js CommonJS、PatchCouncil 现有 event log、`CouncilEngine`、native prompt templates、`npm run check`、`npm run smoke`、`npm run runtime:fake`。

---

## 规格来源

`docs/superpowers/specs/2026-06-02-design-author-response-v1-design.md`

## 文件结构

- 修改： `apps/patchcouncil-ui/engine/events.js` - 新增 design author-response 事件常量和构造函数。
- 修改： `apps/patchcouncil-ui/engine/session-store.js` - 派生 `state.design.status` 的 author response 状态，并渲染 transcript。
- 创建： `apps/patchcouncil-ui/engine/prompts/design_author_response.md` - lead 对 reviewer findings 的回应 prompt。
- 修改： `apps/patchcouncil-ui/engine/prompts/design_revision.md` - 增加 author response 输入，并说明只在 accept / partially_accept 后运行。
- 修改： `apps/patchcouncil-ui/engine/council.js` - 把直接 revision hook 改成 author response + optional revision。
- 修改： `apps/patchcouncil-ui/server.js` - 更新 fake runtime，让它能响应新的 prompt。
- 修改： `apps/patchcouncil-ui/public/app.js` - 在 Workbench 中展示 design author-response 进度文字。
- 修改： `apps/patchcouncil-ui/scripts/council-smoke.js` - 增加事件、状态、prompt 和 council flow smoke tests。
- 修改： `docs/COUNCIL_EVENTS.md` - 记录新增事件和旧 session 兼容策略。
- 修改： `docs/DECISIONS.md` - 更新 Design Council 决策说明。
- 修改： `docs/AI_CONTEXT.md` - 更新架构摘要。

## 任务 1: 事件、State 和 Transcript

**文件：**
- 修改： `apps/patchcouncil-ui/engine/events.js`
- 修改： `apps/patchcouncil-ui/engine/session-store.js`
- 修改： `apps/patchcouncil-ui/scripts/council-smoke.js`

- [ ] **步骤 1: 写事件常量失败测试**

在 `apps/patchcouncil-ui/scripts/council-smoke.js` 中扩展 design event constants 测试，新增：

```js
async function testDesignAuthorResponseEventConstants() {
  setupTest("design author response event constants");

  assert.equal(EVENTS.DESIGN_AUTHOR_RESPONSE_STARTED, "design_author_response_started");
  assert.equal(EVENTS.DESIGN_AUTHOR_RESPONSE_COMPLETED, "design_author_response_completed");

  teardownTest();
  pass();
}
```

在 `main()` 的其他 event constants 测试附近调用。

- [ ] **步骤 2: 运行 smoke 确认失败**

运行：

```powershell
cd apps\patchcouncil-ui
npm run smoke
```

预期： 失败，错误包含 `DESIGN_AUTHOR_RESPONSE_STARTED` 不存在。

- [ ] **步骤 3: 增加事件常量和构造函数**

在 `apps/patchcouncil-ui/engine/events.js` 的 `EVENTS` 中新增：

```js
  DESIGN_AUTHOR_RESPONSE_STARTED: "design_author_response_started",
  DESIGN_AUTHOR_RESPONSE_COMPLETED: "design_author_response_completed",
```

新增构造函数：

```js
function designAuthorResponseStarted(sessionId, seq, phase, artifactPath, designCommit, author, sourceReviewSeq) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.DESIGN_AUTHOR_RESPONSE_STARTED, phase), {
    artifact_path: artifactPath,
    design_commit: designCommit,
    author,
    source_review_seq: sourceReviewSeq,
  });
}

function designAuthorResponseCompleted(sessionId, seq, phase, artifactPath, designCommit, author, sourceReviewSeq, sourceAgentTurnSeq, decision, revisionRequired) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.DESIGN_AUTHOR_RESPONSE_COMPLETED, phase), {
    artifact_path: artifactPath,
    design_commit: designCommit,
    author,
    source_review_seq: sourceReviewSeq,
    source_agent_turn_seq: sourceAgentTurnSeq,
    decision,
    revision_required: Boolean(revisionRequired),
  });
}
```

在 `module.exports` 中导出这两个函数。

- [ ] **步骤 4: 写 state / transcript 失败测试**

在 `council-smoke.js` 中新增：

```js
async function testDesignAuthorResponseDerivesStateAndTranscript() {
  setupTest("design author response derives state and transcript");

  const store = new SessionStore(testDir);
  const session = store.createSession("design author response");
  const base = {
    schema_version: 1,
    session_id: session.id,
    phase: "brainstorming",
  };

  store.appendEvent(session.dir, {
    ...base,
    seq: 0,
    type: EVENTS.SESSION_STARTED,
    started_at: "2026-06-02T10:00:00+08:00",
    topic: "design author response",
    mode: "design_council",
    config: {},
    capabilities: {},
    agents: [],
  });
  store.appendEvent(session.dir, { ...base, seq: 1, type: EVENTS.DESIGN_FILE_WRITTEN, artifact_path: "docs/designs/feature.md", generator: "codex", title: "Feature Design", revision: 0 });
  store.appendEvent(session.dir, { ...base, seq: 2, type: EVENTS.DESIGN_COMMIT_CREATED, artifact_path: "docs/designs/feature.md", commit: "abc123", commit_message: "docs: draft feature design" });
  store.appendEvent(session.dir, { ...base, seq: 3, type: EVENTS.DESIGN_AUTHOR_RESPONSE_STARTED, artifact_path: "docs/designs/feature.md", design_commit: "abc123", author: "codex", source_review_seq: 10 });

  let state = store.deriveState(session.dir);
  assert.equal(state.design.status, "author_responding");

  store.appendEvent(session.dir, { ...base, seq: 4, type: EVENTS.DESIGN_AUTHOR_RESPONSE_COMPLETED, artifact_path: "docs/designs/feature.md", design_commit: "abc123", author: "codex", source_review_seq: 10, source_agent_turn_seq: 11, decision: "reject", revision_required: false });

  state = store.deriveState(session.dir);
  const transcript = store.generateTranscript(session.dir);
  assert.equal(state.design.status, "author_responded");
  assert.match(transcript, /Design author response completed/);
  assert.match(transcript, /reject/);

  teardownTest();
  pass();
}
```

在 `main()` 中调用。

- [ ] **步骤 5: 运行 smoke 确认 state 失败**

运行：

```powershell
cd apps\patchcouncil-ui
npm run smoke
```

预期： 失败，因为 `state.design.status` 还不认识 author-response 事件。

- [ ] **步骤 6: 更新 state 派生**

在 `SessionStore.deriveState()` 中，把 latest design lifecycle event 的查找扩展为包含 author-response：

```js
    const latestDesignLifecycleEvent = [...allEvents].reverse().find((e) =>
      e.type === "design_revision_committed" ||
      e.type === "design_revision_written" ||
      e.type === "design_author_response_completed" ||
      e.type === "design_author_response_started" ||
      e.type === "design_commit_created" ||
      e.type === "design_file_written" ||
      e.type === "design_commit_failed"
    );
```

状态映射增加：

```js
    if (latestDesignLifecycleEvent) {
      const designStatusByType = {
        design_file_written: "file_written",
        design_commit_created: "draft_committed",
        design_author_response_started: "author_responding",
        design_author_response_completed: "author_responded",
        design_revision_written: "revision_written",
        design_revision_committed: "revision_committed",
        design_commit_failed: "commit_failed",
      };
      designStatus = designStatusByType[latestDesignLifecycleEvent.type] || designStatus;
    }
```

保留现有 `latest_commit`、`artifact_path`、`draft_commit` 派生逻辑不变（`state.design` 当前只有这四个字段：`artifact_path`、`draft_commit`、`latest_commit`、`status`）。

- [ ] **步骤 7: 渲染 transcript 事件**

在 `generateTranscript()` switch 中加入：

```js
        case "design_author_response_started":
          lines.push("## Design author response started");
          lines.push("");
          lines.push(`**Path:** ${event.artifact_path}`);
          lines.push(`**Commit:** ${event.design_commit}`);
          lines.push(`**Author:** ${event.author}`);
          lines.push("");
          break;

        case "design_author_response_completed":
          lines.push("## Design author response completed");
          lines.push("");
          lines.push(`**Path:** ${event.artifact_path}`);
          lines.push(`**Commit:** ${event.design_commit}`);
          lines.push(`**Author:** ${event.author}`);
          lines.push(`**Decision:** ${event.decision}`);
          lines.push(`**Revision required:** ${event.revision_required ? "yes" : "no"}`);
          lines.push("");
          break;
```

- [ ] **步骤 8: 运行检查**

运行：

```powershell
cd apps\patchcouncil-ui
npm run smoke
```

预期： 新增 event/state/transcript 测试 通过。

- [ ] **步骤 9: 提交**

运行：

```powershell
git add apps/patchcouncil-ui/engine/events.js apps/patchcouncil-ui/engine/session-store.js apps/patchcouncil-ui/scripts/council-smoke.js
git commit -m "feat: record design author responses"
```

预期： commit 成功。

## 任务 2: Prompts

**文件：**
- 创建： `apps/patchcouncil-ui/engine/prompts/design_author_response.md`
- 修改： `apps/patchcouncil-ui/engine/prompts/design_revision.md`
- 修改： `apps/patchcouncil-ui/scripts/council-smoke.js`

- [ ] **步骤 1: 写 prompt contract 失败测试**

在 `council-smoke.js` 中新增：

```js
async function testDesignAuthorResponsePromptsRenderContract() {
  setupTest("design author response prompts render contract");

  const response = prompts.renderPrompt("design_author_response.md", {
    source_design_path: "docs/designs/feature.md",
    source_design_commit: "abc123",
    design: "# Feature Design",
    review: "Need explicit API behavior.",
    signal: JSON.stringify({ recommended_next_step: "revise design" }, null, 2),
  });
  assert.match(response, /accept \| partially_accept \| reject/);
  assert.match(response, /revision_required/);
  assert.match(response, /Do not modify files/i);
  assert.match(response, /strict JSON/i);

  const revision = prompts.renderPrompt("design_revision.md", {
    design: "# Feature Design",
    findings: "Need explicit API behavior.",
    author_response: JSON.stringify({ decision: "partially_accept" }, null, 2),
    author_signal: JSON.stringify({ recommended_next_step: "revise design" }, null, 2),
  });
  assert.match(revision, /author response/i);
  assert.match(revision, /full revised Markdown design/i);

  teardownTest();
  pass();
}
```

在 `main()` 中调用。

- [ ] **步骤 2: 运行 smoke 确认 prompt 失败**

运行：

```powershell
cd apps\patchcouncil-ui
npm run smoke
```

预期： 失败，因为 `design_author_response.md` 不存在。

- [ ] **步骤 3: 创建 design_author_response.md**

创建 `apps/patchcouncil-ui/engine/prompts/design_author_response.md`：

```markdown
You are the lead author of a PatchCouncil design artifact.

Review the reviewer findings and decide whether to accept, partially accept, or reject them.

Source design path: {{ source_design_path }}
Source design commit: {{ source_design_commit }}

Current design:

{{ design }}

Reviewer findings:

{{ review }}

Reviewer signal:

{{ signal }}

Do not modify files.
Do not output a revised design.
Do not generate an implementation plan.
Do not write code.
This response is visible to the reviewer and coordinator.

Return strict JSON only:

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

Rules:
- Use "accept" when the reviewer finding is correct and the design should be revised.
- Use "partially_accept" when some reviewer points are correct and others should be rejected with reasons.
- Use "reject" only when the reviewer finding is not technically valid for the current design or project constraints.
- When decision is "reject", explain the disagreement clearly in reason and analysis so the reviewer can respond.
- When decision is "accept" or "partially_accept", revision_required should normally be true.
- If a blocker remains unresolved, finalize_readiness must be "not_ready".
```

- [ ] **步骤 4: 更新 design_revision.md**

把 `apps/patchcouncil-ui/engine/prompts/design_revision.md` 替换为：

```markdown
Revise the Markdown design doc using reviewer findings and the lead author response.

Only run this prompt after the lead author response decision is "accept" or "partially_accept".

Current design:
{{design}}

Reviewer findings:
{{findings}}

Author response:
{{author_response}}

Author signal:
{{author_signal}}

Rules:
- Return the full revised Markdown design document.
- Do not output a patch.
- Do not output only changed sections.
- Preserve accurate existing decisions.
- Apply only reviewer findings accepted by the author response.
- Preserve rejected design choices when the author response explains why they should remain.
- Do not generate an implementation plan.
- Do not write code.
```

- [ ] **步骤 5: 运行检查**

运行：

```powershell
cd apps\patchcouncil-ui
npm run smoke
npm run check
```

预期： prompt contract test 通过，语法检查 通过。

- [ ] **步骤 6: 提交**

运行：

```powershell
git add apps/patchcouncil-ui/engine/prompts/design_author_response.md apps/patchcouncil-ui/engine/prompts/design_revision.md apps/patchcouncil-ui/scripts/council-smoke.js
git commit -m "feat: add design author response prompt"
```

预期： commit 成功。

## 任务 3: CouncilEngine Author Response Hook

**文件：**
- 修改： `apps/patchcouncil-ui/engine/council.js`
- 修改： `apps/patchcouncil-ui/scripts/council-smoke.js`

- [ ] **步骤 1: 写 accept / partially_accept 流程失败测试**

更新现有 `testDesignRevisionCommittedAfterReview()`，让 fake runtime 在 revision prompt 前先响应 author response prompt：

```js
{ match: (prompt) => prompt.includes("Review the reviewer findings and decide whether to accept"), response: { ok: true, text: JSON.stringify({
  decision: "partially_accept",
  reason: "API behavior should be explicit; implementation details remain out of scope.",
  revision_required: true,
  stance: "mixed",
  confidence: "high",
  finalize_readiness: "not_ready",
  blockers: [{ type: "issue", text: "Need explicit API behavior." }],
  agreements: ["Add API behavior."],
  disagreements: ["Do not add implementation plan details."],
  recommended_next_step: "revise design",
  analysis: "Revise the design with accepted API behavior only."
}) } },
```

新增断言：

```js
assert.ok(events.some((e) => e.type === EVENTS.DESIGN_AUTHOR_RESPONSE_COMPLETED && e.decision === "partially_accept"));
assert.ok(events.some((e) => e.type === EVENTS.AGENT_TURN_COMPLETED && e.agent === "codex" && e.signal && e.signal.recommended_next_step === "revise design"));
```

- [ ] **步骤 2: 写 reject 流程失败测试**

新增：

```js
async function testDesignAuthorResponseRejectSkipsRevision() {
  setupTest("design author response reject skips revision");

  const config = JSON.parse(JSON.stringify(MINIMAL_CONFIG));
  config.design_council = { lead_agent: "codex", max_questions: 8 };
  config.council.min_distinct_agents = 1;
  config.council.max_turns = 3;

  // NOTE: reviewer uses revise recommendation WITHOUT blockers so the finalize
  // gate passes cleanly after lead rejects.  When a reviewer DOES have blockers
  // and the lead rejects, the reviewer's blockers remain in latestSignalsByAgent
  // and the finalize gate will block — the council then continues discussion,
  // which is correct collaborative behavior (coordinator routes another agent to
  // break the tie or the reviewer responds to the lead's rejection).
  const { events } = await runEngine(config, [
    { match: (p) => p.includes("brainstorming") || p.includes("一次只问一个问题"), response: { ok: true, text: JSON.stringify({ decision: "draft_design", reason: "ok", known_context: [], missing_context: [] }) } },
    { match: (p) => p.includes("Markdown design doc"), response: { ok: true, text: "# Feature Design\n\n## Goal\n\nKeep existing API scope.\n" } },
    { match: isRoutePrompt, response: { ok: true, text: JSON.stringify({ decision: "continue", next_agent: "claude", role: "reviewer", reason: "review design" }) } },
    { match: isAgentTurnPrompt, response: { ok: true, text: JSON.stringify({ stance: "agree", confidence: "high", finalize_readiness: "ready", blockers: [], agreements: ["Design scope is appropriate."], disagreements: ["Implementation details missing."], recommended_next_step: "revise design", analysis: "Reviewer suggests adding implementation detail guidance." }) } },
    { match: (prompt) => prompt.includes("Review the reviewer findings and decide whether to accept"), response: { ok: true, text: JSON.stringify({
      decision: "reject",
      reason: "Implementation details belong in workplan, not design.",
      revision_required: false,
      stance: "disagree",
      confidence: "high",
      finalize_readiness: "ready",
      blockers: [],
      agreements: [],
      disagreements: ["Do not add implementation details to design."],
      recommended_next_step: "continue review",
      analysis: "The design should preserve abstraction and let Workplan Council handle implementation details."
    }) } },
    { match: isDecidePrompt, response: { ok: true, text: JSON.stringify({ decision: "finalize", next_agent: null, role: null, reason: "lead rejected invalid review finding" }) } },
    { match: isFinalizePrompt, response: { ok: true, text: JSON.stringify({ consensus: "Design reviewed.", disagreements: "Implementation detail request rejected by lead.", recommended_next_step: "generate workplan", needs_confirmation: false, next_steps: ["generate workplan"] }) } },
  ]);

  assert.ok(events.some((e) => e.type === EVENTS.DESIGN_AUTHOR_RESPONSE_COMPLETED && e.decision === "reject"));
  assert.equal(events.some((e) => e.type === EVENTS.DESIGN_REVISION_WRITTEN), false);
  assert.equal(events.some((e) => e.type === EVENTS.DESIGN_REVISION_COMMITTED), false);

  teardownTest();
  pass();
}
```

> **关于 finalize gate 与 blocker 的交互：** 本测试中 reviewer 使用 `recommended_next_step: "revise"` 而非 blockers 来触发 author response，因此 lead reject 后 gate 直接放行。生产场景中，如果 reviewer 提出了 blocker 而 lead 拒绝，reviewer 的 blocker 仍会在 `latestSignalsByAgent` 中，导致 finalize gate 阻止收束。此时 council 会通过 `finalize_gate` policy override 继续讨论（coordinator 可路由到其他 agent，或让 reviewer 回应 lead 的拒绝理由），直到 `finalize_gate_max_overrides` 耗尽或 blocker 被解决。这是正确的协作行为，不需要在 v1 中修改 gate 逻辑。

在 `main()` 中调用。

- [ ] **步骤 3: 运行 smoke 确认失败**

运行：

```powershell
cd apps\patchcouncil-ui
npm run smoke
```

预期： 失败，因为 engine 仍然直接调用 revision。

- [ ] **步骤 4: 增加 author response parser**

在 `apps/patchcouncil-ui/engine/council.js` 中新增：

```js
function parseAuthorResponse(text) {
  const parsed = JSON.parse(String(text || "").trim());
  const decision = ["accept", "partially_accept", "reject"].includes(parsed.decision)
    ? parsed.decision
    : "reject";
  return {
    decision,
    reason: String(parsed.reason || parsed.analysis || "Lead did not accept the review as written."),
    revision_required: Boolean(parsed.revision_required),
    stance: parsed.stance || (decision === "reject" ? "disagree" : "mixed"),
    confidence: parsed.confidence || "medium",
    finalize_readiness: parsed.finalize_readiness || "not_ready",
    blockers: Array.isArray(parsed.blockers) ? parsed.blockers : [],
    agreements: Array.isArray(parsed.agreements) ? parsed.agreements : [],
    disagreements: Array.isArray(parsed.disagreements) ? parsed.disagreements : [],
    recommended_next_step: parsed.recommended_next_step || (decision === "reject" ? "continue review" : "revise design"),
    analysis: String(parsed.analysis || parsed.reason || ""),
  };
}
```

只有在测试需要直接覆盖 parser 时才导出；否则保持 local helper。

- [ ] **步骤 5: 增加 respondToDesignReview()**

在 `CouncilEngine` 中新增：

```js
  async respondToDesignReview(reviewEvent) {
    const latestFile = [...this.eventLog].reverse().find((e) => e.type === events.EVENTS.DESIGN_FILE_WRITTEN || e.type === events.EVENTS.DESIGN_REVISION_WRITTEN);
    const latestCommit = [...this.eventLog].reverse().find((e) => e.type === events.EVENTS.DESIGN_REVISION_COMMITTED || e.type === events.EVENTS.DESIGN_COMMIT_CREATED);
    if (!latestFile || !latestCommit) return null;

    const dc = resolveDesignCouncilConfig(this.config, this.brainstormingConfig);
    const agents = availableAgents(this.config.agents);
    const author = dc.lead_agent;
    const currentDesign = fs.readFileSync(latestFile.artifact_path, "utf8");
    const signalText = reviewEvent.signal ? JSON.stringify(reviewEvent.signal, null, 2) : "";

    this.emitEvent(events.EVENTS.DESIGN_AUTHOR_RESPONSE_STARTED, {
      artifact_path: latestFile.artifact_path,
      design_commit: latestCommit.commit,
      author,
      source_review_seq: reviewEvent.seq,
    });

    const prompt = this.prompts.renderPrompt("design_author_response.md", {
      source_design_path: latestFile.artifact_path,
      source_design_commit: latestCommit.commit,
      design: currentDesign,
      review: reviewEvent.content || "",
      signal: signalText,
    });
    const result = await this.runAgent(author, agents[author], prompt);
    if (!result.ok) return null;

    const response = parseAuthorResponse(result.text || "");
    const authorSignal = {
      stance: response.stance,
      confidence: response.confidence,
      finalize_readiness: response.finalize_readiness,
      blockers: response.blockers,
      agreements: response.agreements,
      disagreements: response.disagreements,
      recommended_next_step: response.recommended_next_step,
      analysis: response.analysis,
    };

    const authorTurn = this.emitEvent(events.EVENTS.AGENT_TURN_COMPLETED, {
      turn: this.turnCount + 1,
      agent: author,
      content: response.reason,
      content_length: response.reason.length,
      duration_ms: 0,
      signal: authorSignal,
    });
    this.turnCount++;
    this.spokenAgents.add(author);

    this.emitEvent(events.EVENTS.DESIGN_AUTHOR_RESPONSE_COMPLETED, {
      artifact_path: latestFile.artifact_path,
      design_commit: latestCommit.commit,
      author,
      source_review_seq: reviewEvent.seq,
      source_agent_turn_seq: authorTurn.seq,
      decision: response.decision,
      revision_required: response.revision_required,
    });

    return { response, authorSignal, authorTurn, latestFile, latestCommit };
  }
```

- [ ] **步骤 6: 更新 revision 触发逻辑**

把直接调用：

```js
await this.reviseDesignFromLatestReview(topic, reviewEvent);
```

替换为：

```js
const authorResponse = await this.respondToDesignReview(reviewEvent);
if (
  authorResponse &&
  authorResponse.response.revision_required &&
  (authorResponse.response.decision === "accept" || authorResponse.response.decision === "partially_accept")
) {
  await this.reviseDesignFromLatestReview(topic, reviewEvent, authorResponse);
}
```

- [ ] **步骤 7: 更新 reviseDesignFromLatestReview signature**

把：

```js
async reviseDesignFromLatestReview(topic, reviewEvent) {
```

改为：

```js
async reviseDesignFromLatestReview(topic, reviewEvent, authorResponse) {
```

渲染 revision prompt 时传入 author response：

```js
const prompt = this.prompts.renderPrompt("design_revision.md", {
  design: currentDesign,
  findings,
  author_response: authorResponse ? JSON.stringify(authorResponse.response, null, 2) : "",
  author_signal: authorResponse ? JSON.stringify(authorResponse.authorSignal, null, 2) : "",
});
```

在 `DESIGN_REVISION_WRITTEN` 事件中增加：

```js
source_author_response_seq: authorResponse?.authorTurn?.seq || null,
```

- [ ] **步骤 8: 运行检查**

运行：

```powershell
cd apps\patchcouncil-ui
npm run check
npm run smoke
```

预期： 两项都 通过。accept/partial 测试会提交 revision；reject 测试会跳过 revision。

- [ ] **步骤 9: 提交**

运行：

```powershell
git add apps/patchcouncil-ui/engine/council.js apps/patchcouncil-ui/scripts/council-smoke.js
git commit -m "feat: gate design revisions on author response"
```

预期： commit 成功。

## 任务 4: Fake Runtime 和 Workbench Status

**文件：**
- 修改： `apps/patchcouncil-ui/server.js`
- 修改： `apps/patchcouncil-ui/public/app.js`
- 修改： `apps/patchcouncil-ui/scripts/smoke-test.js`

- [ ] **步骤 1: 写 smoke 失败检查**

在 `apps/patchcouncil-ui/scripts/smoke-test.js` 获取 `/app.js` 后新增：

```js
    if (!appJs.includes("lead responding to design review")) {
      throw new Error("app js missing design author response status");
    }
```

在 fake runtime design session 的 smoke 验证中，断言 transcript 包含 author response：

```js
    if (!transcript.includes("Design author response completed")) {
      throw new Error("transcript missing design author response");
    }
```

沿用现有 smoke session fixture 风格，不新增 HTTP endpoint。

- [ ] **步骤 2: 更新 fake runtime**

在 `server.js` fake runtime 分支中，在 `design_revision.md` 处理前加入：

```js
      if (prompt.includes("Review the reviewer findings and decide whether to accept")) {
        return { ok: true, text: JSON.stringify({
          decision: "accept",
          reason: "Reviewer finding is valid for the design artifact.",
          revision_required: true,
          stance: "agree",
          confidence: "high",
          finalize_readiness: "not_ready",
          blockers: [],
          agreements: ["Apply reviewer finding."],
          disagreements: [],
          recommended_next_step: "revise design",
          analysis: "The lead accepts the review and will revise the design."
        }) };
      }
```

- [ ] **步骤 3: 更新 Workbench design status 文案**

在 `public/app.js` 中，找到 design status 文案派生位置，新增：

```js
    author_responding: "lead responding to design review",
    author_responded: "lead responded to design review",
```

如果当前实现不是 map，而是 inline branch，就加显式分支：

```js
  if (session.design.status === "author_responding") return "lead responding to design review";
  if (session.design.status === "author_responded") return "lead responded to design review";
```

- [ ] **步骤 4: 运行 smoke**

运行：

```powershell
cd apps\patchcouncil-ui
npm run smoke
npm run runtime:fake
```

预期： 两项都 通过，fake design council session 在 revision 前包含 author response。

- [ ] **步骤 5: 提交**

运行：

```powershell
git add apps/patchcouncil-ui/server.js apps/patchcouncil-ui/public/app.js apps/patchcouncil-ui/scripts/smoke-test.js
git commit -m "feat: show design author response progress"
```

预期： commit 成功。

## 任务 5: Docs

**文件：**
- 修改： `docs/COUNCIL_EVENTS.md`
- 修改： `docs/DECISIONS.md`
- 修改： `docs/AI_CONTEXT.md`

- [ ] **步骤 1: 更新 event docs**

在 `docs/COUNCIL_EVENTS.md` 中做以下更新：

**a) 事件类型总列表**（"Council Event 类型" section，约第 248-290 行）：在 `design_revision_committed` 之后新增：
```text
design_author_response_started
design_author_response_completed
```

**b) Design Council 事件 section**（`design_revision_written / design_revision_committed` 附近）：加入新事件说明：
```markdown
### design_author_response_started / design_author_response_completed

Reviewer 提出 blocker 或 revise 建议后，lead agent 先回应 review，而不是直接静默修改 design。回应会产生一条 `agent_turn_completed(agent=lead_agent, signal=...)`，用于让 coordinator 和 finalize gate 看到 lead 对 review 的采纳、部分采纳或不采纳立场。
```

补充与 spec 一致的 JSON 示例。

**c) 派生状态中的 design**（"派生状态中的 design" section，约第 989 行）：`status` 取值列表增加：
```text
author_responding
author_responded
```

**d) 默认落盘策略**（"默认落盘策略" section，约第 1076-1112 行）：在默认写入列表中加入：
```text
design_author_response_started
design_author_response_completed
```

- [ ] **步骤 2: 更新 decisions**

在 `docs/DECISIONS.md` 中，把旧流程：

```markdown
-> lead agent 根据 blocker 或 revise 建议修订 design 并提交 revision commit
```

替换为：

```markdown
-> lead agent 先回应 reviewer findings，明确 accept / partially_accept / reject
-> 只有 accept 或 partially_accept 且需要修订时，lead 才修订 design 并提交 revision commit
```

- [ ] **步骤 3: 更新 AI context**

在 `docs/AI_CONTEXT.md` 中，把：

```markdown
-> [mode=design_council 且有 blocker] 触发 design revision
```

替换为：

```markdown
-> [mode=design_council 且 reviewer 有 blocker/revise] 触发 lead author response
-> [lead accept/partially_accept 且 revision_required] 触发 design revision
```

- [ ] **步骤 4: 运行 docs grep**

运行：

```powershell
rg -n "直接.*revision|根据 blocker|触发 design revision|design_author_response" docs apps/patchcouncil-ui/engine
```

预期： 当前架构文档中不再保留旧的 direct-revision 表述；新的 `design_author_response` 出现在 event docs、AI context、prompts 和 engine code 中。

- [ ] **步骤 5: 运行最终检查**

运行：

```powershell
cd apps\patchcouncil-ui
npm run check
npm run smoke
```

预期： 两项都 通过。

- [ ] **步骤 6: 提交**

运行：

```powershell
git add docs/COUNCIL_EVENTS.md docs/DECISIONS.md docs/AI_CONTEXT.md
git commit -m "docs: document design author response"
```

预期： commit 成功。

## 自检

- Spec coverage：`2026-06-02-design-author-response-v1-design.md` 中的事件、状态、prompt、engine 行为、UI/status、测试和 docs 要求都已映射到任务。
- Placeholder scan：无占位语言或未指定命令。
- Type consistency：事件名使用 `DESIGN_AUTHOR_RESPONSE_STARTED/COMPLETED`；状态名使用 `author_responding/author_responded`；decision values 和 Workplan Council author response 一致。
- Scope check：计划只修改 Design Council review/revision 行为；Workplan approval 和代码执行不在范围内。


