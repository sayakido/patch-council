# Workplan Council v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有 JSON workplan 生成器替换为从 design latest commit 生成、经 council review/revision、最终等待用户批准的 Markdown workplan artifact 流程。

**Architecture:** Workplan Council v1 继续把 `transcript.jsonl` 作为唯一事实源，新增 workplan artifact 事件和 `state.workplan` 投影。生成入口仍是 `POST /api/sessions/:id/workplan`，但实现改为 `workplan-council` native skill pack + git-backed Markdown artifact + coordinator-routed review / author-response / optional-revision loop，approval/reject 通过独立 API 写事件，不触发代码执行。

**Tech Stack:** Node.js CommonJS、内置 `fs/path/http`、vanilla JS/CSS、JSONL event log、现有 `CouncilEngine` helper、`npm run check`、`npm run smoke`、`npm run runtime:fake`。

---

## 规格来源

实现以下 staged 设计：

```text
docs/superpowers/specs/2026-06-02-workplan-council-v1-design.md
```

固定规则：

- 新入口不再写 `workplan_created(workplan JSON)`。
- 旧 session 中已有 `workplan_created` 仍可被 state/transcript 读取。
- 新 workplan 必须来自 `design_council` 的 `state.design.latest_commit`。
- Workplan artifact 写入 `docs/workplans/YYYY-MM-DD-<slug>.md`。
- Workplan review 复用 coordinator route / decide / finalize、agent signal、finalize gate 和 policy override；review 后如需修改，先由 author response 决定采纳、部分采纳或不采纳。
- Workplan review 使用独立 reviewer distinct-agent 策略：默认至少 1 个 reviewer；如果 config 显式设置 `workplan_council.min_distinct_reviewers`，则按该值执行。
- 用户批准前不执行代码。
- Reject 后允许重新调用 `POST /api/sessions/:id/workplan` 生成新的 attempt，不新增 revision API。

## 文件结构

- Modify: `apps/patchcouncil-ui/engine/events.js` - 增加 Workplan Council v1 事件常量和构造函数，保留旧 workplan 事件常量。
- Modify: `apps/patchcouncil-ui/engine/session-store.js` - 增加 `state.workplan` 派生、approval waiting 状态、Markdown transcript 渲染，保留旧 JSON workplan 兼容。
- Replace: `apps/patchcouncil-ui/engine/workplan.js` - 废弃 JSON parser/validator 主入口，改为 Markdown artifact council service。
- Create: `apps/patchcouncil-ui/engine/workplan-artifact.js` - workplan 路径、目录、dirty check、写文件、git commit、contract scan 等纯 helper。
- Create: `apps/patchcouncil-ui/engine/prompts/workplan_draft.md` - writing-plans 风格 draft prompt。
- Create: `apps/patchcouncil-ui/engine/prompts/workplan_review.md` - reviewer prompt。
- Create: `apps/patchcouncil-ui/engine/prompts/workplan_author_response.md` - author 对 review 的采纳 / 部分采纳 / 不采纳回应 prompt。
- Create: `apps/patchcouncil-ui/engine/prompts/workplan_revision.md` - 仅在 author 采纳或部分采纳 review 后运行的 revision prompt。
- Create: `apps/patchcouncil-ui/engine/prompts/workplan_finalize.md` - workplan approval finalize prompt。
- Modify: `apps/patchcouncil-ui/server.js` - 替换 workplan 生成 API 行为，新增 approve/reject API，更新 fake runtime。
- Modify: `apps/patchcouncil-ui/public/app.js` - 用 artifact 状态替换 JSON task 卡片，增加 approve/reject UI。
- Modify: `apps/patchcouncil-ui/public/styles.css` - 调整 Workplan 卡片状态样式。
- Modify: `apps/patchcouncil-ui/scripts/council-smoke.js` - 增加 event/state/helper/service 集成测试。
- Modify: `apps/patchcouncil-ui/scripts/smoke-test.js` - 增加 HTTP/UI smoke。
- Modify: `apps/patchcouncil-ui/package.json` - 将新 helper 纳入 `npm run check`。
- Modify: `docs/COUNCIL_EVENTS.md` - 记录新事件、phase 约定、旧 JSON 迁移。
- Modify: `docs/ROADMAP.md` - 更新 workplan 方向。
- Modify: `apps/patchcouncil-ui/README.md` - 更新 API 和 Workbench 能力。
- Modify: `README.md` - 更新顶层说明。

## Task 1: Workplan Council 事件常量与构造函数

**Files:**
- Modify: `apps/patchcouncil-ui/engine/events.js`
- Modify: `apps/patchcouncil-ui/scripts/council-smoke.js`

- [ ] **Step 1: 写事件常量失败测试**

在 `apps/patchcouncil-ui/scripts/council-smoke.js` 中替换现有 `testWorkplanEventConstants()` 的断言，让它检查新旧事件并存：

```js
async function testWorkplanEventConstants() {
  setupTest("workplan council event constants");

  assert.equal(EVENTS.WORKPLAN_GENERATION_STARTED, "workplan_generation_started");
  assert.equal(EVENTS.WORKPLAN_CREATED, "workplan_created");
  assert.equal(EVENTS.WORKPLAN_GENERATION_FAILED, "workplan_generation_failed");

  assert.equal(EVENTS.WORKPLAN_DRAFT_STARTED, "workplan_draft_started");
  assert.equal(EVENTS.WORKPLAN_DRAFT_WRITTEN, "workplan_draft_written");
  assert.equal(EVENTS.WORKPLAN_DRAFT_COMMITTED, "workplan_draft_committed");
  assert.equal(EVENTS.WORKPLAN_DRAFT_COMMIT_FAILED, "workplan_draft_commit_failed");
  assert.equal(EVENTS.WORKPLAN_REVIEW_STARTED, "workplan_review_started");
  assert.equal(EVENTS.WORKPLAN_REVIEW_COMPLETED, "workplan_review_completed");
  assert.equal(EVENTS.WORKPLAN_AUTHOR_RESPONSE_STARTED, "workplan_author_response_started");
  assert.equal(EVENTS.WORKPLAN_AUTHOR_RESPONSE_COMPLETED, "workplan_author_response_completed");
  assert.equal(EVENTS.WORKPLAN_REVISION_WRITTEN, "workplan_revision_written");
  assert.equal(EVENTS.WORKPLAN_REVISION_COMMITTED, "workplan_revision_committed");
  assert.equal(EVENTS.WORKPLAN_REVISION_COMMIT_FAILED, "workplan_revision_commit_failed");
  assert.equal(EVENTS.WORKPLAN_APPROVAL_REQUESTED, "workplan_approval_requested");
  assert.equal(EVENTS.WORKPLAN_APPROVED, "workplan_approved");
  assert.equal(EVENTS.WORKPLAN_APPROVAL_REJECTED, "workplan_approval_rejected");

  teardownTest();
  pass();
}
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```powershell
cd apps\patchcouncil-ui
npm run smoke
```

Expected: FAIL，错误包含 `WORKPLAN_DRAFT_STARTED` 或其他新常量不存在。

- [ ] **Step 3: 增加事件常量**

在 `apps/patchcouncil-ui/engine/events.js` 的 `EVENTS` 中保留旧三项，并新增：

```js
  WORKPLAN_DRAFT_STARTED: "workplan_draft_started",
  WORKPLAN_DRAFT_WRITTEN: "workplan_draft_written",
  WORKPLAN_DRAFT_COMMITTED: "workplan_draft_committed",
  WORKPLAN_DRAFT_COMMIT_FAILED: "workplan_draft_commit_failed",
  WORKPLAN_REVIEW_STARTED: "workplan_review_started",
  WORKPLAN_REVIEW_COMPLETED: "workplan_review_completed",
  WORKPLAN_AUTHOR_RESPONSE_STARTED: "workplan_author_response_started",
  WORKPLAN_AUTHOR_RESPONSE_COMPLETED: "workplan_author_response_completed",
  WORKPLAN_REVISION_WRITTEN: "workplan_revision_written",
  WORKPLAN_REVISION_COMMITTED: "workplan_revision_committed",
  WORKPLAN_REVISION_COMMIT_FAILED: "workplan_revision_commit_failed",
  WORKPLAN_APPROVAL_REQUESTED: "workplan_approval_requested",
  WORKPLAN_APPROVED: "workplan_approved",
  WORKPLAN_APPROVAL_REJECTED: "workplan_approval_rejected",
```

- [ ] **Step 4: 增加构造函数**

在 `events.js` 中加入这些构造函数：

```js
function workplanDraftStarted(sessionId, seq, phase, generator, sourceDesignPath, sourceDesignCommit) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.WORKPLAN_DRAFT_STARTED, phase), {
    generator,
    source_design_path: sourceDesignPath,
    source_design_commit: sourceDesignCommit,
  });
}

function workplanDraftWritten(sessionId, seq, phase, artifactPath, generator, sourceDesignCommit, title, revision) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.WORKPLAN_DRAFT_WRITTEN, phase), {
    artifact_path: artifactPath,
    generator,
    source_design_commit: sourceDesignCommit,
    title,
    revision,
  });
}

function workplanDraftCommitted(sessionId, seq, phase, artifactPath, sourceDesignCommit, commit, commitMessage) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.WORKPLAN_DRAFT_COMMITTED, phase), {
    artifact_path: artifactPath,
    source_design_commit: sourceDesignCommit,
    commit,
    commit_message: commitMessage,
  });
}

function workplanDraftCommitFailed(sessionId, seq, phase, artifactPath, sourceDesignCommit, stage, error) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.WORKPLAN_DRAFT_COMMIT_FAILED, phase), {
    artifact_path: artifactPath,
    source_design_commit: sourceDesignCommit,
    stage,
    error,
  });
}

function workplanReviewStarted(sessionId, seq, phase, artifactPath, workplanCommit, reviewer) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.WORKPLAN_REVIEW_STARTED, phase), {
    artifact_path: artifactPath,
    workplan_commit: workplanCommit,
    reviewer,
  });
}

function workplanReviewCompleted(sessionId, seq, phase, artifactPath, workplanCommit, reviewer, sourceAgentTurnSeq, requiresRevision) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.WORKPLAN_REVIEW_COMPLETED, phase), {
    artifact_path: artifactPath,
    workplan_commit: workplanCommit,
    reviewer,
    source_agent_turn_seq: sourceAgentTurnSeq,
    requires_revision: Boolean(requiresRevision),
  });
}

function workplanAuthorResponseStarted(sessionId, seq, phase, artifactPath, workplanCommit, author, sourceReviewSeq) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.WORKPLAN_AUTHOR_RESPONSE_STARTED, phase), {
    artifact_path: artifactPath,
    workplan_commit: workplanCommit,
    author,
    source_review_seq: sourceReviewSeq,
  });
}

function workplanAuthorResponseCompleted(sessionId, seq, phase, artifactPath, workplanCommit, author, sourceReviewSeq, sourceAgentTurnSeq, decision, revisionRequired) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.WORKPLAN_AUTHOR_RESPONSE_COMPLETED, phase), {
    artifact_path: artifactPath,
    workplan_commit: workplanCommit,
    author,
    source_review_seq: sourceReviewSeq,
    source_agent_turn_seq: sourceAgentTurnSeq,
    decision,
    revision_required: Boolean(revisionRequired),
  });
}

function workplanRevisionWritten(sessionId, seq, phase, artifactPath, sourceDesignCommit, sourceWorkplanCommit, sourceReviewSeq, generator, revision) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.WORKPLAN_REVISION_WRITTEN, phase), {
    artifact_path: artifactPath,
    source_design_commit: sourceDesignCommit,
    source_workplan_commit: sourceWorkplanCommit,
    source_review_seq: sourceReviewSeq,
    generator,
    revision,
  });
}

function workplanRevisionCommitted(sessionId, seq, phase, artifactPath, sourceDesignCommit, sourceWorkplanCommit, commit, commitMessage) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.WORKPLAN_REVISION_COMMITTED, phase), {
    artifact_path: artifactPath,
    source_design_commit: sourceDesignCommit,
    source_workplan_commit: sourceWorkplanCommit,
    commit,
    commit_message: commitMessage,
  });
}

function workplanRevisionCommitFailed(sessionId, seq, phase, artifactPath, sourceDesignCommit, sourceWorkplanCommit, stage, error) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.WORKPLAN_REVISION_COMMIT_FAILED, phase), {
    artifact_path: artifactPath,
    source_design_commit: sourceDesignCommit,
    source_workplan_commit: sourceWorkplanCommit,
    stage,
    error,
  });
}

function workplanApprovalRequested(sessionId, seq, phase, artifactPath, workplanCommit, requestedAt) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.WORKPLAN_APPROVAL_REQUESTED, phase), {
    artifact_path: artifactPath,
    workplan_commit: workplanCommit,
    requested_at: requestedAt,
  });
}

function workplanApproved(sessionId, seq, phase, artifactPath, approvedCommit, approvedAt, approvedBy) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.WORKPLAN_APPROVED, phase), {
    artifact_path: artifactPath,
    approved_commit: approvedCommit,
    approved_at: approvedAt,
    approved_by: approvedBy,
  });
}

function workplanApprovalRejected(sessionId, seq, phase, artifactPath, workplanCommit, rejectedAt, reason) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.WORKPLAN_APPROVAL_REJECTED, phase), {
    artifact_path: artifactPath,
    workplan_commit: workplanCommit,
    rejected_at: rejectedAt,
    reason,
  });
}
```

在 `module.exports` 中导出这些函数。

- [ ] **Step 5: 运行检查**

Run:

```powershell
cd apps\patchcouncil-ui
npm run smoke
```

Expected: `workplan council event constants` PASS；后续任务相关测试仍未加入。

- [ ] **Step 6: 提交**

Run:

```powershell
git add apps/patchcouncil-ui/engine/events.js apps/patchcouncil-ui/scripts/council-smoke.js
git commit -m "feat: add workplan council events"
```

Expected: commit succeeds.

## Task 2: State 派生与 Transcript 渲染

**Files:**
- Modify: `apps/patchcouncil-ui/engine/session-store.js`
- Modify: `apps/patchcouncil-ui/scripts/council-smoke.js`

- [ ] **Step 1: 写新 workplan state 失败测试**

在 `council-smoke.js` 中新增：

```js
async function testWorkplanCouncilStateAndTranscriptEvents() {
  setupTest("workplan council events derive state and transcript");

  const store = new SessionStore(testDir);
  const session = store.createSession("workplan council");
  const base = {
    schema_version: 1,
    session_id: session.id,
    phase: "finalized",
  };
  store.appendEvent(session.dir, {
    schema_version: 1,
    seq: 0,
    type: EVENTS.SESSION_STARTED,
    phase: "brainstorming",
    session_id: session.id,
    started_at: "2026-06-02T10:00:00+08:00",
    topic: "workplan council",
    mode: "design_council",
    config: {},
    capabilities: {},
    agents: [],
  });
  store.appendEvent(session.dir, { ...base, seq: 1, type: EVENTS.SESSION_FINISHED, finished_at: "2026-06-02T10:01:00+08:00", outcome: "discussion_only", duration_ms: 1, turn_count: 0, distinct_agents: [], error_count: 0 });
  store.appendEvent(session.dir, { ...base, seq: 2, type: EVENTS.WORKPLAN_DRAFT_WRITTEN, artifact_path: "docs/workplans/2026-06-02-feature.md", generator: "codex", source_design_commit: "abc123", title: "Feature Implementation Plan", revision: 0 });
  store.appendEvent(session.dir, { ...base, seq: 3, type: EVENTS.WORKPLAN_DRAFT_COMMITTED, artifact_path: "docs/workplans/2026-06-02-feature.md", source_design_commit: "abc123", commit: "def456", commit_message: "docs: draft feature workplan" });
  store.appendEvent(session.dir, { ...base, seq: 4, type: EVENTS.WORKPLAN_REVIEW_COMPLETED, artifact_path: "docs/workplans/2026-06-02-feature.md", workplan_commit: "def456", reviewer: "claude", source_agent_turn_seq: 10, requires_revision: true });
  store.appendEvent(session.dir, { ...base, seq: 5, type: EVENTS.WORKPLAN_AUTHOR_RESPONSE_COMPLETED, artifact_path: "docs/workplans/2026-06-02-feature.md", workplan_commit: "def456", author: "codex", source_review_seq: 4, source_agent_turn_seq: 11, decision: "partially_accept", revision_required: true });
  store.appendEvent(session.dir, { ...base, seq: 6, type: EVENTS.WORKPLAN_REVISION_COMMITTED, artifact_path: "docs/workplans/2026-06-02-feature.md", source_design_commit: "abc123", source_workplan_commit: "def456", commit: "ghi789", commit_message: "docs: revise feature workplan" });
  store.appendEvent(session.dir, { ...base, seq: 7, type: EVENTS.WORKPLAN_APPROVAL_REQUESTED, artifact_path: "docs/workplans/2026-06-02-feature.md", workplan_commit: "ghi789", requested_at: "2026-06-02T10:02:00+08:00" });

  let state = store.deriveState(session.dir);
  assert.equal(state.status, "waiting_for_user");
  assert.equal(state.waiting_for, "workplan_approval");
  assert.equal(state.workplan.status, "awaiting_approval");
  assert.equal(state.workplan.artifact_path, "docs/workplans/2026-06-02-feature.md");
  assert.equal(state.workplan.draft_commit, "def456");
  assert.equal(state.workplan.latest_commit, "ghi789");
  assert.equal(state.workplan.approved_commit, null);

  store.appendEvent(session.dir, { ...base, seq: 8, type: EVENTS.WORKPLAN_APPROVED, artifact_path: "docs/workplans/2026-06-02-feature.md", approved_commit: "ghi789", approved_at: "2026-06-02T10:03:00+08:00", approved_by: "host" });
  state = store.deriveState(session.dir);
  const transcript = store.generateTranscript(session.dir);

  assert.equal(state.status, "done");
  assert.equal(state.waiting_for, null);
  assert.equal(state.workplan.status, "approved");
  assert.equal(state.workplan.approved_commit, "ghi789");
  assert.match(transcript, /Workplan approval requested/);
  assert.match(transcript, /docs\/workplans\/2026-06-02-feature\.md/);
  assert.match(transcript, /ghi789/);

  teardownTest();
  pass();
}
```

在 `main()` 中 `testWorkplanStateAndTranscriptEvents()` 后调用该测试。

- [ ] **Step 2: 写旧 JSON 兼容测试**

新增：

```js
async function testLegacyJsonWorkplanStillDerivesState() {
  setupTest("legacy JSON workplan still derives state");

  const store = new SessionStore(testDir);
  const session = store.createSession("legacy workplan");
  store.appendEvent(session.dir, {
    schema_version: 1, seq: 0, type: EVENTS.SESSION_STARTED, phase: "discussion",
    session_id: session.id, started_at: "2026-06-02T10:00:00+08:00",
    topic: "legacy", mode: "council", config: {}, capabilities: {}, agents: [],
  });
  store.appendEvent(session.dir, {
    schema_version: 1, seq: 1, type: EVENTS.WORKPLAN_CREATED, phase: "finalized",
    session_id: session.id, created_at: "2026-06-02T10:01:00+08:00",
    generator: "codex", source: {},
    workplan: { title: "Legacy", rationale: "Old", goal: "Goal", scope: [], non_goals: [], tasks: [{ id: "T1", title: "Task", description: "Do it", files: [], depends_on: [], verification: ["npm run check"] }], risks: [] },
  });

  const state = store.deriveState(session.dir);
  assert.equal(state.has_workplan, true);
  assert.equal(state.workplan_status, "created");
  assert.equal(state.workplan.status, "legacy_json_created");

  teardownTest();
  pass();
}
```

在 `main()` 中调用。

- [ ] **Step 3: 运行测试确认失败**

Run:

```powershell
cd apps\patchcouncil-ui
npm run smoke
```

Expected: FAIL，错误包含 `state.workplan` 未定义或 `waiting_for` 不匹配。

- [ ] **Step 4: 实现 workplan 派生 helper**

在 `SessionStore.deriveState()` 中旧 `workplanEvents` 逻辑之后加入新事件派生。保留旧 `has_workplan` / `workplan_status` 字段，同时新增 `workplan` 对象：

```js
    const latestWorkplanFile = [...allEvents].reverse().find((e) =>
      e.type === "workplan_revision_written" ||
      e.type === "workplan_draft_written" ||
      e.type === "workplan_revision_committed" ||
      e.type === "workplan_draft_committed" ||
      e.type === "workplan_author_response_started" ||
      e.type === "workplan_author_response_completed" ||
      e.type === "workplan_approval_requested" ||
      e.type === "workplan_approved" ||
      e.type === "workplan_approval_rejected"
    );
    const draftWorkplanCommit = allEvents.find((e) => e.type === "workplan_draft_committed");
    const latestWorkplanCommit = [...allEvents].reverse().find((e) =>
      e.type === "workplan_revision_committed" || e.type === "workplan_draft_committed"
    );
    const latestWorkplanTitle = [...allEvents].reverse().find((e) =>
      e.type === "workplan_draft_written" || e.type === "workplan_revision_written"
    );
    const approvedWorkplan = [...allEvents].reverse().find((e) => e.type === "workplan_approved");
    const latestWorkplanEvent = [...allEvents].reverse().find((e) => String(e.type || "").startsWith("workplan_"));

    let artifactWorkplanStatus = "none";
    if (latestWorkplanEvent) {
      const statusByType = {
        workplan_draft_started: "drafting",
        workplan_draft_written: "draft_written",
        workplan_draft_committed: "draft_committed",
        workplan_review_started: "reviewing",
        workplan_review_completed: "reviewed",
        workplan_author_response_started: "author_responding",
        workplan_author_response_completed: "author_responded",
        workplan_revision_written: "revision_written",
        workplan_revision_committed: "revision_committed",
        workplan_draft_commit_failed: "draft_commit_failed",
        workplan_revision_commit_failed: "revision_commit_failed",
        workplan_approval_requested: "awaiting_approval",
        workplan_approved: "approved",
        workplan_approval_rejected: "rejected",
        workplan_generation_failed: "failed",
        workplan_created: "legacy_json_created",
      };
      artifactWorkplanStatus = statusByType[latestWorkplanEvent.type] || "none";
    }
```

- [ ] **Step 5: 更新 session status / waiting_for**

在 `deriveState()` 里 `status` 决策处增加 `waitingForWorkplanApproval`：

```js
    const latestApprovalRequest = [...allEvents].reverse().find((e) => e.type === "workplan_approval_requested");
    const latestApprovalDecision = [...allEvents].reverse().find((e) =>
      e.type === "workplan_approved" || e.type === "workplan_approval_rejected"
    );
    const waitingForWorkplanApproval =
      latestApprovalRequest && (!latestApprovalDecision || latestApprovalDecision.seq < latestApprovalRequest.seq);
```

并把 status 判断改成：

```js
    if (waitingForBrainstorming || waitingForWorkplanApproval) {
      status = "waiting_for_user";
    } else if (sessionFinished) {
      const outcome = sessionFinished.outcome;
      status = outcome === "error" || outcome === "cancelled" ? outcome : "done";
    } else if (allEvents.some((e) => e.type === "session_error")) {
      status = "error";
    } else if (allEvents.some((e) => e.type === "session_cancel_requested")) {
      status = "cancelling";
    }
```

把 state 中 `waiting_for` 改成：

```js
      waiting_for: waitingForBrainstorming ? "brainstorming_answer" : waitingForWorkplanApproval ? "workplan_approval" : null,
```

并新增：

```js
      workplan: {
        artifact_path: latestWorkplanFile?.artifact_path || null,
        source_design_commit: latestWorkplanFile?.source_design_commit || null,
        draft_commit: draftWorkplanCommit?.commit || null,
        latest_commit: latestWorkplanCommit?.commit || null,
        approved_commit: approvedWorkplan?.approved_commit || null,
        status: artifactWorkplanStatus,
        title: latestWorkplanTitle?.title || null,
        revision: latestWorkplanTitle?.revision ?? null,
      },
```

- [ ] **Step 6: 渲染新 transcript 事件**

保留 `generateTranscript()` 中现有 `case "workplan_created"` 分支，用于旧 JSON workplan replay。不要把该分支改成新 Markdown artifact 语义。

在 `generateTranscript()` switch 中加入：

```js
        case "workplan_draft_written":
          lines.push("## Workplan draft written");
          lines.push("");
          lines.push(`**Path:** ${event.artifact_path}`);
          lines.push(`**Title:** ${event.title}`);
          lines.push(`**Source design commit:** ${event.source_design_commit}`);
          lines.push("");
          break;

        case "workplan_draft_committed":
          lines.push("## Workplan draft committed");
          lines.push("");
          lines.push(`**Path:** ${event.artifact_path}`);
          lines.push(`**Commit:** ${event.commit}`);
          lines.push(`**Message:** ${event.commit_message}`);
          lines.push("");
          break;

        case "workplan_review_completed":
          lines.push("## Workplan review completed");
          lines.push("");
          lines.push(`**Path:** ${event.artifact_path}`);
          lines.push(`**Commit:** ${event.workplan_commit}`);
          lines.push(`**Reviewer:** ${event.reviewer}`);
          lines.push(`**Requires revision:** ${event.requires_revision ? "yes" : "no"}`);
          lines.push("");
          break;

        case "workplan_author_response_completed":
          lines.push("## Workplan author response completed");
          lines.push("");
          lines.push(`**Path:** ${event.artifact_path}`);
          lines.push(`**Commit:** ${event.workplan_commit}`);
          lines.push(`**Author:** ${event.author}`);
          lines.push(`**Decision:** ${event.decision}`);
          lines.push(`**Revision required:** ${event.revision_required ? "yes" : "no"}`);
          lines.push("");
          break;

        case "workplan_revision_committed":
          lines.push("## Workplan revision committed");
          lines.push("");
          lines.push(`**Path:** ${event.artifact_path}`);
          lines.push(`**Commit:** ${event.commit}`);
          lines.push(`**Message:** ${event.commit_message}`);
          lines.push("");
          break;

        case "workplan_approval_requested":
          lines.push("## Workplan approval requested");
          lines.push("");
          lines.push(`**Path:** ${event.artifact_path}`);
          lines.push(`**Commit:** ${event.workplan_commit}`);
          lines.push(`**Requested:** ${event.requested_at}`);
          lines.push("");
          break;

        case "workplan_approved":
          lines.push("## Workplan approved");
          lines.push("");
          lines.push(`**Path:** ${event.artifact_path}`);
          lines.push(`**Approved commit:** ${event.approved_commit}`);
          lines.push(`**Approved at:** ${event.approved_at}`);
          lines.push("");
          break;

        case "workplan_approval_rejected":
          lines.push("## Workplan rejected");
          lines.push("");
          lines.push(`**Path:** ${event.artifact_path}`);
          lines.push(`**Commit:** ${event.workplan_commit}`);
          lines.push(`**Reason:** ${event.reason}`);
          lines.push("");
          break;

        case "workplan_draft_commit_failed":
        case "workplan_revision_commit_failed":
          lines.push("## Workplan commit failed");
          lines.push("");
          lines.push(`**Path:** ${event.artifact_path}`);
          lines.push(`**Stage:** ${event.stage}`);
          lines.push(`**Error:** ${event.error}`);
          lines.push("");
          break;
```

- [ ] **Step 8: 运行检查**

Run:

```powershell
cd apps\patchcouncil-ui
npm run smoke
```

Expected: 新 state/transcript 测试 PASS，旧 workplan tests 仍 PASS。

- [ ] **Step 9: 提交**

Run:

```powershell
git add apps/patchcouncil-ui/engine/session-store.js apps/patchcouncil-ui/scripts/council-smoke.js
git commit -m "feat: derive workplan artifact state"
```

Expected: commit succeeds.

## Task 3: Native Skill Prompts

**Files:**
- Create: `apps/patchcouncil-ui/engine/prompts/workplan_draft.md`
- Create: `apps/patchcouncil-ui/engine/prompts/workplan_review.md`
- Create: `apps/patchcouncil-ui/engine/prompts/workplan_author_response.md`
- Create: `apps/patchcouncil-ui/engine/prompts/workplan_revision.md`
- Create: `apps/patchcouncil-ui/engine/prompts/workplan_finalize.md`
- Create: `apps/patchcouncil-ui/engine/skills/workplan-council/skill.yaml`
- Modify: `apps/patchcouncil-ui/scripts/council-smoke.js`

- [ ] **Step 1: 写 prompt contract 失败测试**

在 `council-smoke.js` 中新增：

```js
async function testWorkplanCouncilPromptsRenderContract() {
  setupTest("workplan council prompts render contract");

  const draft = prompts.renderPrompt("workplan_draft.md", {
    topic: "feature",
    source_design_path: "docs/designs/feature.md",
    source_design_commit: "abc123",
    design: "# Design",
    context: "npm run check\nnpm run smoke",
  });
  assert.match(draft, /writing-plans/i);
  assert.match(draft, /docs\/designs\/feature\.md/);
  assert.match(draft, /Do not implement code/i);
  assert.match(draft, /checkbox/i);

  const review = prompts.renderPrompt("workplan_review.md", {
    artifact_path: "docs/workplans/feature.md",
    workplan_commit: "def456",
    workplan: "# Plan",
    source_design_path: "docs/designs/feature.md",
    source_design_commit: "abc123",
  });
  assert.match(review, /blockers/);
  assert.match(review, /placeholder|占位/i);

  const authorResponse = prompts.renderPrompt("workplan_author_response.md", {
    source_design_path: "docs/designs/feature.md",
    source_design_commit: "abc123",
    design: "# Design",
    artifact_path: "docs/workplans/feature.md",
    workplan_commit: "def456",
    workplan: "# Plan",
    review: "Fix scope",
    signal: "{}",
  });
  assert.match(authorResponse, /accept|partially_accept|reject/);
  assert.match(authorResponse, /revision_required/);
  assert.match(authorResponse, /Do not modify files/i);

  const revision = prompts.renderPrompt("workplan_revision.md", {
    source_design_path: "docs/designs/feature.md",
    source_design_commit: "abc123",
    design: "# Design",
    artifact_path: "docs/workplans/feature.md",
    workplan_commit: "def456",
    workplan: "# Plan",
    review: "Fix scope",
    signal: "{}",
    author_response: "{}",
    author_signal: "{}",
  });
  assert.match(revision, /source design/i);
  assert.match(revision, /complete Markdown workplan/i);

  const finalize = prompts.renderPrompt("workplan_finalize.md", {
    source_design_path: "docs/designs/feature.md",
    source_design_commit: "abc123",
    artifact_path: "docs/workplans/feature.md",
    workplan_commit: "ghi789",
    transcript: "signals",
  });
  assert.match(finalize, /request user approval/i);
  assert.doesNotMatch(finalize, /execute code/i);

  teardownTest();
  pass();
}
```

在 `main()` 中 prompt tests 附近调用。

- [ ] **Step 2: 运行测试确认失败**

Run:

```powershell
cd apps\patchcouncil-ui
npm run smoke
```

Expected: FAIL，错误为 `workplan_draft.md` 不存在。

- [ ] **Step 3: 创建 skill.yaml**

创建 `apps/patchcouncil-ui/engine/skills/workplan-council/skill.yaml`：

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

- [ ] **Step 4: 创建 workplan_draft.md**

创建 `apps/patchcouncil-ui/engine/prompts/workplan_draft.md`：

```markdown
You are drafting a writing-plans-style implementation plan for PatchCouncil.

Source design path: {{ source_design_path }}
Source design commit: {{ source_design_commit }}
Topic: {{ topic }}

Do not implement code.
Do not execute commands.
Do not ask follow-up questions.
Do not output JSON.
Do not wrap the plan in Markdown fences.

Use this source design as the authority:

{{ design }}

Project context and supported commands:

{{ context }}

Write a complete Markdown implementation plan.

Required contract:
- Start with "# <Feature Name> Implementation Plan".
- Include "Source Design" and "Source Design Commit" in the header.
- Include Goal, Architecture, and Tech Stack.
- Include a File Structure section before tasks.
- Split work into bite-sized engineering tasks.
- Each task must use checkbox steps.
- Each task must include exact file paths.
- Each task must include concrete verification commands or explicit manual verification.
- Prefer existing commands: npm run check, npm run smoke, npm run runtime:fake.
- Do not invent commands.
- Do not use placeholder language, vague error handling, vague testing instructions, or any wording that asks the implementer to fill in missing details.
- End with a Self-Review section covering spec coverage, placeholder scan, type/naming consistency, and scope check.
```

- [ ] **Step 5: 创建 workplan_review.md**

创建 `apps/patchcouncil-ui/engine/prompts/workplan_review.md`：

```markdown
You are reviewing a PatchCouncil Markdown workplan artifact.

Artifact path: {{ artifact_path }}
Workplan commit: {{ workplan_commit }}
Source design path: {{ source_design_path }}
Source design commit: {{ source_design_commit }}

Do not modify files.
Do not implement code.
Review whether the plan is ready to request user approval.

Source workplan:

{{ workplan }}

Return strict JSON only:

{
  "stance": "agree | disagree | mixed",
  "confidence": "low | medium | high",
  "finalize_readiness": "ready | not_ready",
  "blockers": [{ "type": "issue | question", "text": "string" }],
  "agreements": ["string"],
  "disagreements": ["string"],
  "recommended_next_step": "string",
  "analysis": "string"
}

Review criteria:
- It must be based on the source design.
- It must not omit source design requirements.
- It must use writing-plans-style Markdown.
- File boundaries must be clear.
- Tasks must be neither too broad nor too mechanical.
- Each task must include concrete verification.
- It must not contain placeholder wording, vague error handling, vague testing instructions, or any instruction that asks the implementer to fill in missing details.
- It must not assume code execution before user approval.
- If any blocker remains, set finalize_readiness to "not_ready".
```

- [ ] **Step 6: 创建 workplan_author_response.md**

创建 `apps/patchcouncil-ui/engine/prompts/workplan_author_response.md`：

```markdown
You are the author of a PatchCouncil Markdown workplan.

Review the reviewer findings and decide whether to accept, partially accept, or reject them.

Source design path: {{ source_design_path }}
Source design commit: {{ source_design_commit }}

Source design:

{{ design }}

Current workplan path: {{ artifact_path }}
Current workplan commit: {{ workplan_commit }}

Current workplan:

{{ workplan }}

Reviewer findings:

{{ review }}

Reviewer signal:

{{ signal }}

Do not modify files.
Do not output a revised workplan.
Do not implement code.
Do not execute commands.
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
- Use "accept" when the reviewer is correct and the workplan should be revised.
- Use "partially_accept" when some reviewer points are correct and others should be rejected with reasons.
- Use "reject" only when the reviewer finding is not technically valid for the source design or project constraints.
- When decision is "reject", explain the disagreement clearly in reason and analysis so the reviewer can respond.
- When decision is "accept" or "partially_accept", revision_required should normally be true.
- If a blocker remains unresolved, finalize_readiness must be "not_ready".
```

- [ ] **Step 7: 创建 workplan_revision.md**

创建 `apps/patchcouncil-ui/engine/prompts/workplan_revision.md`：

```markdown
Revise the complete Markdown workplan using reviewer findings and the author response.

Only run this prompt after the author response decision is "accept" or "partially_accept".

Source design path: {{ source_design_path }}
Source design commit: {{ source_design_commit }}

Source design:

{{ design }}

Current workplan path: {{ artifact_path }}
Current workplan commit: {{ workplan_commit }}

Current workplan:

{{ workplan }}

Reviewer findings:

{{ review }}

Reviewer signal:

{{ signal }}

Author response:

{{ author_response }}

Author signal:

{{ author_signal }}

Do not output a patch.
Do not output only changed sections.
Do not implement code.
Do not execute commands.
Return the full revised Markdown workplan only.

The revised workplan must still satisfy the writing-plans contract: clear file structure, checkbox steps, exact paths, concrete verification, no placeholder wording, and a Self-Review section.
```

- [ ] **Step 8: 创建 workplan_finalize.md**

创建 `apps/patchcouncil-ui/engine/prompts/workplan_finalize.md`：

```markdown
You are the coordinator finalizing a PatchCouncil workplan review loop.

Source design path: {{ source_design_path }}
Source design commit: {{ source_design_commit }}
Workplan path: {{ artifact_path }}
Workplan commit: {{ workplan_commit }}

Latest review transcript and signals:

{{ transcript }}

Decide whether the workplan can request user approval.
Do not approve the workplan yourself.
Do not execute code.

Return strict JSON only:

{
  "decision": "finalize | continue",
  "next_agent": "agent id or null",
  "role": "string or null",
  "reason": "string"
}

Use "finalize" only when the latest workplan appears to cover the source design, follows the writing-plans contract, and has no unresolved blocker. Use "continue" when another reviewer turn or revision is still needed.
```

- [ ] **Step 9: 运行检查**

Run:

```powershell
cd apps\patchcouncil-ui
npm run smoke
```

Expected: prompt contract test PASS。

- [ ] **Step 10: 提交**

Run:

```powershell
git add apps/patchcouncil-ui/engine/prompts/workplan_draft.md apps/patchcouncil-ui/engine/prompts/workplan_review.md apps/patchcouncil-ui/engine/prompts/workplan_author_response.md apps/patchcouncil-ui/engine/prompts/workplan_revision.md apps/patchcouncil-ui/engine/prompts/workplan_finalize.md apps/patchcouncil-ui/engine/skills/workplan-council/skill.yaml apps/patchcouncil-ui/scripts/council-smoke.js
git commit -m "feat: add workplan council prompts"
```

Expected: commit succeeds.

## Task 4: Workplan Artifact Helpers

**Files:**
- Create: `apps/patchcouncil-ui/engine/workplan-artifact.js`
- Modify: `apps/patchcouncil-ui/scripts/council-smoke.js`
- Modify: `apps/patchcouncil-ui/package.json`

- [ ] **Step 1: 写 artifact helper 失败测试**

在 `council-smoke.js` 顶部加入：

```js
const {
  buildWorkplanArtifactPath,
  ensureWorkplanDirectory,
  assertWorkplanWritable,
  scanWorkplanContract,
  commitWorkplanArtifact,
} = require("../engine/workplan-artifact");
```

新增测试：

```js
async function testWorkplanArtifactHelpers() {
  setupTest("workplan artifact helpers");

  const artifactPath = buildWorkplanArtifactPath(testDir, "Workplan Council v1!");
  assert.match(artifactPath, /docs[\\/]workplans[\\/]\d{4}-\d{2}-\d{2}-workplan-council-v1\.md$/);

  ensureWorkplanDirectory(artifactPath);
  assert.equal(fs.existsSync(path.dirname(artifactPath)), true);

  const ok = scanWorkplanContract([
    "# Feature Implementation Plan",
    "",
    "**Source Design:** docs/designs/x.md",
    "**Source Design Commit:** abc123",
    "**Goal:** Build it",
    "**Architecture:** Small service.",
    "**Tech Stack:** Node.js",
    "",
    "## File Structure",
    "- Modify: `apps/patchcouncil-ui/server.js` - API route.",
    "",
    "### Task 1: API",
    "- [ ] **Step 1: Run check**",
    "Run: `npm run check`",
    "Expected: PASS",
    "",
    "## Self-Review",
    "- Spec coverage: covered",
    "- Placeholder scan: clean",
    "- Type / naming consistency: consistent",
    "- Scope check: scoped",
  ].join("\n"));
  assert.equal(ok.ok, true);

  const bad = scanWorkplanContract("# Plan\n\n占位内容");
  assert.equal(bad.ok, false);
  assert.match(bad.error, /placeholder|File Structure|Self-Review/i);

  fs.writeFileSync(artifactPath, "user edit", "utf8");
  assert.equal(assertWorkplanWritable(artifactPath, { allowExisting: false }).ok, false);

  teardownTest();
  pass();
}
```

在 `main()` 中调用。

- [ ] **Step 2: 运行测试确认失败**

Run:

```powershell
cd apps\patchcouncil-ui
npm run smoke
```

Expected: FAIL，`../engine/workplan-artifact` 不存在。

- [ ] **Step 3: 创建 workplan-artifact.js**

创建 `apps/patchcouncil-ui/engine/workplan-artifact.js`：

```js
"use strict";

const fs = require("fs");
const path = require("path");
const { slugifyDesignTopic } = require("./design-council");

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function buildWorkplanArtifactPath(projectRoot, topic) {
  const slug = slugifyDesignTopic(topic) || "workplan";
  return path.join(projectRoot, "docs", "workplans", `${todayIso()}-${slug}.md`);
}

function ensureWorkplanDirectory(artifactPath) {
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
}

function assertWorkplanWritable(artifactPath, options = {}) {
  if (!fs.existsSync(artifactPath)) return { ok: true };
  if (options.allowExisting) return { ok: true };
  return { ok: false, error: "workplan artifact already exists with local content" };
}

function scanWorkplanContract(markdown) {
  const text = String(markdown || "");
  const lower = text.toLowerCase();
  const forbidden = ["t" + "bd", "to" + "do", "implement " + "later", "add appropriate " + "error handling", "write tests " + "for this"];
  if (!/^# .+ Implementation Plan/m.test(text)) return { ok: false, error: "missing implementation plan title" };
  if (!text.includes("Source Design")) return { ok: false, error: "missing Source Design" };
  if (!text.includes("Source Design Commit")) return { ok: false, error: "missing Source Design Commit" };
  if (!text.includes("## File Structure")) return { ok: false, error: "missing File Structure" };
  if (!/\n- \[ \]/.test(text)) return { ok: false, error: "missing checkbox steps" };
  if (!/Run: `[^`]+`/.test(text) && !/Manual verification:/i.test(text)) return { ok: false, error: "missing concrete verification" };
  if (!text.includes("## Self-Review")) return { ok: false, error: "missing Self-Review" };
  if (forbidden.some((item) => lower.includes(item))) return { ok: false, error: "contains placeholder wording" };
  if (lower.includes("execute code now")) return { ok: false, error: "plan attempts to execute code" };
  return { ok: true };
}

async function runGitCommand(projectRoot, args, runGit) {
  if (runGit) return await runGit(args);
  const { spawnSync } = require("child_process");
  const result = spawnSync("git", args, { cwd: projectRoot, encoding: "utf8" });
  return {
    ok: result.status === 0,
    text: result.stdout || "",
    error: result.stderr || result.stdout || `git ${args.join(" ")} failed`,
  };
}

async function commitWorkplanArtifact(options) {
  const { artifactPath, projectRoot, message, runGit } = options;
  const rel = path.relative(projectRoot, artifactPath);
  const add = await runGitCommand(projectRoot, ["add", rel], runGit);
  if (!add.ok) return { ok: false, stage: "git_add", error: add.error };
  const commit = await runGitCommand(projectRoot, ["commit", "-m", message], runGit);
  if (!commit.ok) return { ok: false, stage: "git_commit", error: commit.error };
  const rev = await runGitCommand(projectRoot, ["rev-parse", "--short", "HEAD"], runGit);
  if (!rev.ok) return { ok: false, stage: "rev_parse", error: rev.error };
  return { ok: true, commit: rev.text.trim() };
}

module.exports = {
  buildWorkplanArtifactPath,
  ensureWorkplanDirectory,
  assertWorkplanWritable,
  scanWorkplanContract,
  commitWorkplanArtifact,
};
```

- [ ] **Step 4: 更新 package.json check**

在 `apps/patchcouncil-ui/package.json` 的 `check` 脚本中加入：

```text
node --check engine/workplan-artifact.js
```

Expected: `npm run check` 会检查新文件语法。

- [ ] **Step 5: 运行检查**

Run:

```powershell
cd apps\patchcouncil-ui
npm run check
npm run smoke
```

Expected: both PASS。

- [ ] **Step 6: 提交**

Run:

```powershell
git add apps/patchcouncil-ui/engine/workplan-artifact.js apps/patchcouncil-ui/scripts/council-smoke.js apps/patchcouncil-ui/package.json
git commit -m "feat: add workplan artifact helpers"
```

Expected: commit succeeds.

## Task 5: Workplan Council Service

**Files:**
- Replace: `apps/patchcouncil-ui/engine/workplan.js`
- Modify: `apps/patchcouncil-ui/scripts/council-smoke.js`

- [ ] **Step 1: 写 service 集成失败测试**

在 `council-smoke.js` 中把顶部 workplan import 改为：

```js
const {
  generateWorkplanForSession,
  latestDesignCommit,
  latestDesignFile,
} = require("../engine/workplan");
```

删除或改写 `parseWorkplanJson` / `validateWorkplan` 相关测试，不再测试 JSON parser。新增：

```js
async function testGenerateMarkdownWorkplanCouncilFlow() {
  setupTest("generate markdown workplan council flow");

  const store = new SessionStore(testDir);
  const session = store.createSession("markdown workplan");
  const designPath = path.join(testDir, "docs", "designs", "2026-06-02-feature.md");
  fs.mkdirSync(path.dirname(designPath), { recursive: true });
  fs.writeFileSync(designPath, "# Feature Design\n\n## Goal\n\nBuild markdown workplans.\n", "utf8");

  store.appendEvent(session.dir, {
    schema_version: 1, seq: 0, type: EVENTS.SESSION_STARTED, phase: "brainstorming",
    session_id: session.id, started_at: "2026-06-02T10:00:00+08:00",
    topic: "markdown workplan", mode: "design_council", config: {}, capabilities: {}, agents: [],
  });
  store.appendEvent(session.dir, { schema_version: 1, seq: 1, type: EVENTS.DESIGN_FILE_WRITTEN, phase: "brainstorming", session_id: session.id, artifact_path: designPath, generator: "codex", title: "Feature Design", revision: 0 });
  store.appendEvent(session.dir, { schema_version: 1, seq: 2, type: EVENTS.DESIGN_COMMIT_CREATED, phase: "brainstorming", session_id: session.id, artifact_path: designPath, commit: "abc123", commit_message: "docs: draft feature design" });
  store.appendEvent(session.dir, { schema_version: 1, seq: 3, type: EVENTS.SESSION_FINISHED, phase: "finalized", session_id: session.id, finished_at: "2026-06-02T10:01:00+08:00", outcome: "discussion_only", duration_ms: 1, turn_count: 0, distinct_agents: [], error_count: 0 });

  const config = JSON.parse(JSON.stringify(MINIMAL_CONFIG));
  config.workplan_council = { min_distinct_reviewers: 1 };

  let rev = 0;
  const result = await generateWorkplanForSession({
    config,
    sessionStore: store,
    sessionDir: session.dir,
    sessionId: session.id,
    projectRoot: testDir,
    topic: "markdown workplan",
    prompts,
    runAgent: async (_agentName, _agentConfig, prompt) => {
      if (prompt.includes("drafting a writing-plans-style")) {
        return { ok: true, text: "# Markdown Workplan Implementation Plan\n\n**Source Design:** docs/designs/2026-06-02-feature.md\n**Source Design Commit:** abc123\n**Goal:** Build it.\n**Architecture:** Small service.\n**Tech Stack:** Node.js\n\n---\n\n## File Structure\n\n- Modify: `apps/patchcouncil-ui/server.js` - API.\n\n### Task 1: API\n\n- [ ] **Step 1: Run check**\n\nRun: `npm run check`\nExpected: PASS\n\n## Self-Review\n\n- Spec coverage: covered\n- Placeholder scan: clean\n- Type / naming consistency: consistent\n- Scope check: scoped\n" };
      }
      if (prompt.includes("reviewing a PatchCouncil Markdown workplan")) {
        return { ok: true, text: JSON.stringify({ stance: "mixed", confidence: "high", finalize_readiness: "not_ready", blockers: [{ type: "issue", text: "Need smoke verification." }], agreements: [], disagreements: [], recommended_next_step: "revise workplan", analysis: "Add smoke verification." }) };
      }
      if (prompt.includes("Review the reviewer findings and decide whether to accept")) {
        return { ok: true, text: JSON.stringify({ decision: "partially_accept", reason: "Smoke verification should be added; existing file scope is already sufficient.", revision_required: true, stance: "mixed", confidence: "high", finalize_readiness: "not_ready", blockers: [{ type: "issue", text: "Need smoke verification." }], agreements: ["Add smoke verification."], disagreements: ["No extra file boundary needed."], recommended_next_step: "revise workplan", analysis: "Accept the verification concern and keep the scope narrow." }) };
      }
      if (prompt.includes("Revise the complete Markdown workplan")) {
        return { ok: true, text: "# Markdown Workplan Implementation Plan\n\n**Source Design:** docs/designs/2026-06-02-feature.md\n**Source Design Commit:** abc123\n**Goal:** Build it.\n**Architecture:** Small service.\n**Tech Stack:** Node.js\n\n---\n\n## File Structure\n\n- Modify: `apps/patchcouncil-ui/server.js` - API.\n\n### Task 1: API\n\n- [ ] **Step 1: Run smoke**\n\nRun: `npm run smoke`\nExpected: PASS\n\n## Self-Review\n\n- Spec coverage: covered\n- Placeholder scan: clean\n- Type / naming consistency: consistent\n- Scope check: scoped\n" };
      }
      if (prompt.includes("finalizing a PatchCouncil workplan review loop")) {
        return { ok: true, text: JSON.stringify({ decision: "finalize", next_agent: null, role: null, reason: "ready for user approval" }) };
      }
      return { ok: false, error: "unexpected prompt" };
    },
    runGit: async (args) => {
      if (args[0] === "rev-parse") {
        rev++;
        return { ok: true, text: rev === 1 ? "def456\n" : "ghi789\n" };
      }
      return { ok: true, text: "" };
    },
    onEvent: (event) => store.appendEvent(session.dir, event),
  });

  assert.equal(result.ok, true);
  const events = store.readEvents(session.dir);
  assert.ok(events.some((e) => e.type === EVENTS.WORKPLAN_DRAFT_COMMITTED));
  assert.ok(events.some((e) => e.type === EVENTS.WORKPLAN_REVIEW_COMPLETED));
  assert.ok(events.some((e) => e.type === EVENTS.WORKPLAN_AUTHOR_RESPONSE_COMPLETED && e.decision === "partially_accept"));
  assert.ok(events.some((e) => e.type === EVENTS.AGENT_TURN_COMPLETED && e.agent === "codex" && e.signal && e.signal.recommended_next_step === "revise workplan"));
  assert.ok(events.some((e) => e.type === EVENTS.WORKPLAN_REVISION_COMMITTED));
  assert.ok(events.some((e) => e.type === EVENTS.WORKPLAN_APPROVAL_REQUESTED));
  assert.equal(events.some((e) => e.type === EVENTS.WORKPLAN_CREATED), false);

  const state = store.deriveState(session.dir);
  assert.equal(state.status, "waiting_for_user");
  assert.equal(state.waiting_for, "workplan_approval");
  assert.equal(state.workplan.latest_commit, "ghi789");

  teardownTest();
  pass();
}
```

在 `main()` 中调用。

- [ ] **Step 2: 运行测试确认失败**

Run:

```powershell
cd apps\patchcouncil-ui
npm run smoke
```

Expected: FAIL，因为当前 service 仍写 `workplan_created`。

- [ ] **Step 3: 替换 workplan.js 结构**

将 `apps/patchcouncil-ui/engine/workplan.js` 改为导出：

```js
"use strict";

const fs = require("fs");
const path = require("path");
const events = require("./events");
const {
  availableAgents,
  selectCoordinator,
  parseAgentTurnSignal,
  fallbackAgentSignal,
  shouldAllowFinalize,
  clipText,
  formatAgentProfiles,
} = require("./council");
const artifact = require("./workplan-artifact");

function latestDesignCommit(allEvents) {
  return [...allEvents].reverse().find((e) => e.type === "design_revision_committed" || e.type === "design_commit_created");
}

function latestDesignFile(allEvents) {
  return [...allEvents].reverse().find((e) => e.type === "design_revision_written" || e.type === "design_file_written");
}

function nextSeq(allEvents) {
  return allEvents.reduce((max, event) => Math.max(max, Number(event.seq)), -1) + 1;
}

function parseAuthorResponse(text) {
  const parsed = JSON.parse(String(text || "").trim());
  const decision = ["accept", "partially_accept", "reject"].includes(parsed.decision)
    ? parsed.decision
    : "reject";
  return {
    decision,
    reason: String(parsed.reason || parsed.analysis || "Author did not accept the review as written."),
    revision_required: Boolean(parsed.revision_required),
    stance: parsed.stance || (decision === "reject" ? "disagree" : "mixed"),
    confidence: parsed.confidence || "medium",
    finalize_readiness: parsed.finalize_readiness || "not_ready",
    blockers: Array.isArray(parsed.blockers) ? parsed.blockers : [],
    agreements: Array.isArray(parsed.agreements) ? parsed.agreements : [],
    disagreements: Array.isArray(parsed.disagreements) ? parsed.disagreements : [],
    recommended_next_step: parsed.recommended_next_step || (decision === "reject" ? "continue review" : "revise workplan"),
    analysis: String(parsed.analysis || parsed.reason || ""),
  };
}

```

- [ ] **Step 4: 实现 preflight**

在 `workplan.js` 中加入：

```js
function validateWorkplanPreflight(sessionStore, sessionDir, allEvents) {
  const state = sessionStore.deriveState(sessionDir);
  if (state.mode !== "design_council") {
    return { ok: false, status: 409, error: "workplan requires a design_council session" };
  }
  if (state.status === "waiting_for_user" && state.waiting_for === "brainstorming_answer") {
    return { ok: false, status: 409, error: "design council is still waiting for brainstorming answer" };
  }
  if (state.status === "running" || state.status === "cancelling") {
    return { ok: false, status: 409, error: "design council must finish before generating a workplan" };
  }
  if (state.status !== "done" && state.workplan?.status !== "rejected" && state.workplan?.status !== "failed") {
    return { ok: false, status: 409, error: "workplan can only be generated for done, failed, or rejected sessions" };
  }
  if (!state.design?.latest_commit) {
    return { ok: false, status: 409, error: "workplan requires a design commit" };
  }
  if (state.workplan?.status && !["none", "failed", "rejected"].includes(state.workplan.status)) {
    return { ok: false, status: 409, error: "workplan already exists or is awaiting approval" };
  }
  if (allEvents.some((event) => event.type === "workplan_draft_started") && state.workplan?.status !== "failed" && state.workplan?.status !== "rejected") {
    return { ok: false, status: 409, error: "workplan generation already started" };
  }
  return { ok: true };
}
```

- [ ] **Step 5: 实现 prompt context builder**

在 `workplan.js` 中加入：

```js
function readDesignContext(designFileEvent) {
  try {
    return fs.readFileSync(designFileEvent.artifact_path, "utf8");
  } catch (_) {
    return "Design document could not be read from artifact path.";
  }
}

function buildReviewTranscript(allEvents, maxChars) {
  const latestSignals = allEvents
    .filter((event) => event.type === "agent_turn_completed" && event.signal)
    .map((event) => `${event.agent}: ${JSON.stringify(event.signal)}`)
    .join("\n");
  return clipText(latestSignals || "No reviewer signals yet.", maxChars || 2500);
}
```

- [ ] **Step 6: 实现 generateWorkplanForSession draft/review/revision/finalize**

用以下结构替换旧 `generateWorkplanForSession`：

```js
async function generateWorkplanForSession(options) {
  const { config, sessionStore, sessionDir, sessionId, projectRoot, topic, prompts, runAgent, runGit, onEvent } = options;
  const allEvents = sessionStore.readEvents(sessionDir);
  const preflight = validateWorkplanPreflight(sessionStore, sessionDir, allEvents);
  if (!preflight.ok) return preflight;

  const agents = availableAgents(config.agents);
  const author = selectCoordinator(config);
  const coordinator = selectCoordinator(config);
  if (!author || !coordinator) return { ok: false, status: 409, error: "no available workplan author" };

  let seq = nextSeq(allEvents);
  const designCommit = latestDesignCommit(allEvents);
  const designFile = latestDesignFile(allEvents);
  const sourceDesignPath = designFile.artifact_path;
  const sourceDesignCommit = designCommit.commit;
  const designText = readDesignContext(designFile);
  const artifactPath = artifact.buildWorkplanArtifactPath(projectRoot, topic || allEvents.find((e) => e.type === "session_started")?.topic || "workplan");
  const phase = "finalized";

  function emit(type, fields) {
    const event = Object.assign({ schema_version: 1, seq: seq++, type, phase, session_id: sessionId }, fields);
    onEvent(event);
    return event;
  }

  emit(events.EVENTS.WORKPLAN_DRAFT_STARTED, {
    generator: author.name,
    source_design_path: sourceDesignPath,
    source_design_commit: sourceDesignCommit,
  });

  try {
    artifact.ensureWorkplanDirectory(artifactPath);
    const writable = artifact.assertWorkplanWritable(artifactPath, { allowExisting: false });
    if (!writable.ok) {
      emit(events.EVENTS.WORKPLAN_GENERATION_FAILED, {
        failed_at: new Date().toISOString(),
        generator: author.name,
        message: writable.error,
        recoverable: true,
        action: "ask_user_to_resolve_dirty_workplan",
        details: { artifact_path: artifactPath },
      });
      sessionStore.deriveState(sessionDir);
      sessionStore.generateTranscript(sessionDir);
      return { ok: false, status: 200, error: writable.error };
    }

    const draftPrompt = prompts.renderPrompt("workplan_draft.md", {
      topic: topic || "",
      source_design_path: sourceDesignPath,
      source_design_commit: sourceDesignCommit,
      design: designText,
      context: "Supported commands: npm run check, npm run smoke, npm run runtime:fake",
    });
    const draft = await runAgent(author.name, author.config, draftPrompt);
    if (!draft.ok) throw new Error(draft.error || "workplan draft failed");
    const draftText = String(draft.text || "").trim() + "\n";
    const contract = artifact.scanWorkplanContract(draftText);
    if (!contract.ok) throw new Error(contract.error);

    fs.writeFileSync(artifactPath, draftText, "utf8");
    emit(events.EVENTS.WORKPLAN_DRAFT_WRITTEN, {
      artifact_path: artifactPath,
      generator: author.name,
      source_design_commit: sourceDesignCommit,
      title: firstMarkdownTitle(draftText),
      revision: 0,
    });
    const draftMessage = `docs: draft ${path.basename(artifactPath, ".md").replace(/^\d{4}-\d{2}-\d{2}-/, "")} workplan`;
    const draftCommit = await artifact.commitWorkplanArtifact({ artifactPath, projectRoot, message: draftMessage, runGit });
    if (!draftCommit.ok) {
      emit(events.EVENTS.WORKPLAN_DRAFT_COMMIT_FAILED, {
        artifact_path: artifactPath,
        source_design_commit: sourceDesignCommit,
        stage: draftCommit.stage,
        error: draftCommit.error,
      });
      sessionStore.deriveState(sessionDir);
      sessionStore.generateTranscript(sessionDir);
      return { ok: false, status: 200, error: draftCommit.error };
    }
    emit(events.EVENTS.WORKPLAN_DRAFT_COMMITTED, {
      artifact_path: artifactPath,
      source_design_commit: sourceDesignCommit,
      commit: draftCommit.commit,
      commit_message: draftMessage,
    });

    const reviewResult = await runWorkplanReviewLoop({
      config, agents, coordinator, author, prompts, runAgent, runGit, emit,
      projectRoot, artifactPath, sourceDesignPath, sourceDesignCommit, designText,
      initialWorkplanCommit: draftCommit.commit,
    });

    sessionStore.deriveState(sessionDir);
    sessionStore.generateTranscript(sessionDir);
    return reviewResult;
  } catch (error) {
    emit(events.EVENTS.WORKPLAN_GENERATION_FAILED, {
      failed_at: new Date().toISOString(),
      generator: author.name,
      message: error.message,
      recoverable: true,
      action: "show_error",
      details: { artifact_path: artifactPath },
    });
    sessionStore.deriveState(sessionDir);
    sessionStore.generateTranscript(sessionDir);
    return { ok: false, status: 200, error: error.message };
  }
}
```

Add helper:

```js
function firstMarkdownTitle(markdown) {
  const match = String(markdown || "").match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : "Untitled Workplan";
}
```

- [ ] **Step 7: 实现 runWorkplanReviewLoop**

在 `workplan.js` 中加入：

```js
async function runWorkplanReviewLoop(options) {
  const {
    config, agents, coordinator, author, prompts, runAgent, runGit, emit,
    projectRoot, artifactPath, sourceDesignPath, sourceDesignCommit, designText,
    initialWorkplanCommit,
  } = options;
  const maxTurns = config.council?.max_turns ?? 3;
  const minDistinctReviewers = config.workplan_council?.min_distinct_reviewers ?? 1;
  let turnCount = 0;
  let currentCommit = initialWorkplanCommit;
  let eventLog = [];
  let spokenReviewers = new Set();

  while (turnCount < maxTurns) {
    const reviewerName = await routeWorkplanReviewer({
      config,
      agents,
      coordinator,
      authorName: author.name,
      prompts,
      runAgent,
      artifactPath,
      currentCommit,
      sourceDesignPath,
      sourceDesignCommit,
      eventLog,
      spokenReviewers,
    });
    const reviewer = { name: reviewerName, config: agents[reviewerName] };
    emit(events.EVENTS.WORKPLAN_REVIEW_STARTED, { artifact_path: artifactPath, workplan_commit: currentCommit, reviewer: reviewer.name });

    const workplanText = fs.readFileSync(artifactPath, "utf8");
    const reviewPrompt = prompts.renderPrompt("workplan_review.md", {
      artifact_path: artifactPath,
      workplan_commit: currentCommit,
      workplan: workplanText,
      source_design_path: sourceDesignPath,
      source_design_commit: sourceDesignCommit,
    });
    const reviewed = await runAgent(reviewer.name, reviewer.config, reviewPrompt);
    if (!reviewed.ok) throw new Error(reviewed.error || "workplan review failed");
    const parsed = parseAgentTurnSignal(reviewed.text || "");
    const content = parsed.ok ? parsed.content : reviewed.text || "";
    const signal = parsed.ok ? parsed.signal : fallbackAgentSignal();
    const agentTurn = emit(events.EVENTS.AGENT_TURN_COMPLETED, {
      turn: ++turnCount,
      agent: reviewer.name,
      content,
      content_length: content.length,
      duration_ms: 0,
      signal,
      ...(parsed.ok ? {} : { signal_parse_error: parsed.error }),
    });
    eventLog.push(agentTurn);
    spokenReviewers.add(reviewer.name);
    const requiresAuthorResponse = Boolean(signal.blockers && signal.blockers.length > 0) || /revise/i.test(signal.recommended_next_step || "");
    emit(events.EVENTS.WORKPLAN_REVIEW_COMPLETED, {
      artifact_path: artifactPath,
      workplan_commit: currentCommit,
      reviewer: reviewer.name,
      source_agent_turn_seq: agentTurn.seq,
      requires_revision: requiresAuthorResponse,
    });

    let authorResponse = null;
    let authorSignal = null;
    if (requiresAuthorResponse) {
      emit(events.EVENTS.WORKPLAN_AUTHOR_RESPONSE_STARTED, {
        artifact_path: artifactPath,
        workplan_commit: currentCommit,
        author: author.name,
        source_review_seq: agentTurn.seq,
      });
      const responsePrompt = prompts.renderPrompt("workplan_author_response.md", {
        source_design_path: sourceDesignPath,
        source_design_commit: sourceDesignCommit,
        design: designText,
        artifact_path: artifactPath,
        workplan_commit: currentCommit,
        workplan: fs.readFileSync(artifactPath, "utf8"),
        review: content,
        signal: JSON.stringify(signal, null, 2),
      });
      const response = await runAgent(author.name, author.config, responsePrompt);
      if (!response.ok) throw new Error(response.error || "workplan author response failed");
      authorResponse = parseAuthorResponse(response.text || "");
      authorSignal = {
        stance: authorResponse.stance,
        confidence: authorResponse.confidence,
        finalize_readiness: authorResponse.finalize_readiness,
        blockers: authorResponse.blockers || [],
        agreements: authorResponse.agreements || [],
        disagreements: authorResponse.disagreements || [],
        recommended_next_step: authorResponse.recommended_next_step,
        analysis: authorResponse.analysis,
      };
      const authorTurn = emit(events.EVENTS.AGENT_TURN_COMPLETED, {
        turn: ++turnCount,
        agent: author.name,
        content: authorResponse.reason,
        content_length: authorResponse.reason.length,
        duration_ms: 0,
        signal: authorSignal,
      });
      eventLog.push(authorTurn);
      emit(events.EVENTS.WORKPLAN_AUTHOR_RESPONSE_COMPLETED, {
        artifact_path: artifactPath,
        workplan_commit: currentCommit,
        author: author.name,
        source_review_seq: agentTurn.seq,
        source_agent_turn_seq: authorTurn.seq,
        decision: authorResponse.decision,
        revision_required: authorResponse.revision_required,
      });

      if (authorResponse.decision === "reject" || !authorResponse.revision_required) {
        continue;
      }
    }

    const gate = shouldAllowFinalize(eventLog, { minDistinctAgents: Math.min(minDistinctReviewers, Object.keys(agents).length) });
    if (gate.allowed && signal.finalize_readiness === "ready") {
      const finalizePrompt = prompts.renderPrompt("workplan_finalize.md", {
        source_design_path: sourceDesignPath,
        source_design_commit: sourceDesignCommit,
        artifact_path: artifactPath,
        workplan_commit: currentCommit,
        transcript: buildReviewTranscript(eventLog, config.council?.max_transcript_chars || 2500),
      });
      const finalized = await runAgent(coordinator.name, coordinator.config, finalizePrompt);
      if (!finalized.ok) throw new Error(finalized.error || "workplan finalize failed");
      emit(events.EVENTS.WORKPLAN_APPROVAL_REQUESTED, {
        artifact_path: artifactPath,
        workplan_commit: currentCommit,
        requested_at: new Date().toISOString(),
      });
      return { ok: true, status: 200, artifact_path: artifactPath, commit: currentCommit };
    }

    if (!authorResponse || (authorResponse.decision !== "accept" && authorResponse.decision !== "partially_accept")) {
      continue;
    }

    const revisionPrompt = prompts.renderPrompt("workplan_revision.md", {
      source_design_path: sourceDesignPath,
      source_design_commit: sourceDesignCommit,
      design: designText,
      artifact_path: artifactPath,
      workplan_commit: currentCommit,
      workplan: fs.readFileSync(artifactPath, "utf8"),
      review: content,
      signal: JSON.stringify(signal, null, 2),
      author_response: JSON.stringify(authorResponse, null, 2),
      author_signal: JSON.stringify(authorSignal, null, 2),
    });
    const revision = await runAgent(author.name, author.config, revisionPrompt);
    if (!revision.ok) throw new Error(revision.error || "workplan revision failed");
    const revisionText = String(revision.text || "").trim() + "\n";
    const contract = artifact.scanWorkplanContract(revisionText);
    if (!contract.ok) throw new Error(contract.error);
    fs.writeFileSync(artifactPath, revisionText, "utf8");
    emit(events.EVENTS.WORKPLAN_REVISION_WRITTEN, {
      artifact_path: artifactPath,
      source_design_commit: sourceDesignCommit,
      source_workplan_commit: currentCommit,
      source_review_seq: agentTurn.seq,
      generator: author.name,
      revision: turnCount,
    });
    const message = `docs: revise ${path.basename(artifactPath, ".md").replace(/^\d{4}-\d{2}-\d{2}-/, "")} workplan`;
    const committed = await artifact.commitWorkplanArtifact({ artifactPath, projectRoot, message, runGit });
    if (!committed.ok) {
      emit(events.EVENTS.WORKPLAN_REVISION_COMMIT_FAILED, {
        artifact_path: artifactPath,
        source_design_commit: sourceDesignCommit,
        source_workplan_commit: currentCommit,
        stage: committed.stage,
        error: committed.error,
      });
      return { ok: false, status: 200, error: committed.error };
    }
    emit(events.EVENTS.WORKPLAN_REVISION_COMMITTED, {
      artifact_path: artifactPath,
      source_design_commit: sourceDesignCommit,
      source_workplan_commit: currentCommit,
      commit: committed.commit,
      commit_message: message,
    });
    currentCommit = committed.commit;
  }

  emit(events.EVENTS.WORKPLAN_APPROVAL_REQUESTED, {
    artifact_path: artifactPath,
    workplan_commit: currentCommit,
    requested_at: new Date().toISOString(),
  });
  return { ok: true, status: 200, artifact_path: artifactPath, commit: currentCommit };
}
```

- [ ] **Step 8: 实现 coordinator-routed reviewer 选择**

在 `workplan.js` 中加入：

```js
async function routeWorkplanReviewer(options) {
  const {
    config,
    agents,
    coordinator,
    authorName,
    prompts,
    runAgent,
    artifactPath,
    currentCommit,
    sourceDesignPath,
    sourceDesignCommit,
    eventLog,
    spokenReviewers,
  } = options;
  const reviewerNames = Object.keys(agents).filter((name) => name !== authorName);
  const fallbackReviewer = reviewerNames.find((name) => !spokenReviewers.has(name)) || reviewerNames[0] || authorName;
  const prompt = prompts.renderPrompt("council_route.md", {
    agent_profiles: formatAgentProfiles(config),
    topic: "Review a Markdown workplan artifact and choose the next reviewer.",
    context: [
      "This is Workplan Council review routing.",
      "Do not choose the author as reviewer unless no other reviewer is available.",
      "Source design path: " + sourceDesignPath,
      "Source design commit: " + sourceDesignCommit,
      "Workplan path: " + artifactPath,
      "Workplan commit: " + currentCommit,
      "Available reviewers: " + reviewerNames.join(", "),
    ].join("\n"),
    transcript: buildReviewTranscript(eventLog, config.council?.max_transcript_chars || 2500),
  });
  const result = await runAgent(coordinator.name, coordinator.config, prompt);
  if (!result.ok) return fallbackReviewer;
  try {
    const parsed = JSON.parse(String(result.text || "").trim());
    if (parsed.next_agent && agents[parsed.next_agent] && parsed.next_agent !== authorName) {
      return parsed.next_agent;
    }
  } catch (_) {
    return fallbackReviewer;
  }
  return fallbackReviewer;
}
```

This intentionally uses the existing coordinator route prompt and falls back to a non-author reviewer when coordinator output is invalid. Workplan review does not require two distinct reviewers unless `config.workplan_council.min_distinct_reviewers` says so.

- [ ] **Step 9: 导出兼容 helper**

在 `module.exports` 中导出：

```js
module.exports = {
  generateWorkplanForSession,
  latestDesignCommit,
  latestDesignFile,
};
```

不要再导出 `parseWorkplanJson` 或 `validateWorkplan`。同步删除测试中的旧 parser/validator import 和测试调用。

- [ ] **Step 10: 运行检查**

Run:

```powershell
cd apps\patchcouncil-ui
npm run check
npm run smoke
```

Expected: both PASS；新 flow 测试确认不写 `workplan_created`。

- [ ] **Step 11: 提交**

Run:

```powershell
git add apps/patchcouncil-ui/engine/workplan.js apps/patchcouncil-ui/scripts/council-smoke.js
git commit -m "feat: generate markdown workplans through council"
```

Expected: commit succeeds.

## Task 6: HTTP API 与 Approval / Reject

**Files:**
- Modify: `apps/patchcouncil-ui/server.js`
- Modify: `apps/patchcouncil-ui/scripts/smoke-test.js`

- [ ] **Step 0: 引入事件常量**

在 `apps/patchcouncil-ui/server.js` 顶部加入：

```js
const { EVENTS } = require("./engine/events");
```

- [ ] **Step 1: 写 HTTP smoke 失败测试**

在 `apps/patchcouncil-ui/scripts/smoke-test.js` 中，将旧 workplan API smoke 的 `workplan_created` 断言替换为：

```js
    const startedWorkplan = await fetchJson(`/api/sessions/${planEncoded}/workplan`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    if (startedWorkplan.status !== "generating") {
      throw new Error("expected workplan generation status");
    }

    const workplanDeadline = Date.now() + 8000;
    let workplanEvents = [];
    while (Date.now() < workplanDeadline) {
      const resp = await fetchJson(`/api/sessions/${planEncoded}/events`);
      workplanEvents = resp.events || [];
      if (workplanEvents.some((event) => event.type === "workplan_approval_requested")) break;
      await wait(200);
    }
    const approval = workplanEvents.find((event) => event.type === "workplan_approval_requested");
    if (!approval) {
      throw new Error("expected workplan_approval_requested event");
    }
    if (workplanEvents.some((event) => event.type === "workplan_created")) {
      throw new Error("new workplan flow must not emit legacy workplan_created");
    }

    await fetchJson(`/api/sessions/${planEncoded}/workplan/approve`, {
      method: "POST",
      body: JSON.stringify({}),
    });
```

在同一个 smoke test 中使用以下 fixture 创建可生成 workplan 的 design session：

```js
    const planSession = await fetchJson("/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        topic: "workplan council smoke topic",
        mode: "design_council",
        brainstorming: { lead_agent: "codex", max_questions: 1 },
      }),
    });
    const planSessionId = planSession.session_id;
    const planEncoded = encodeURIComponent(planSessionId);

    const designDeadline = Date.now() + 10000;
    let designState = null;
    while (Date.now() < designDeadline) {
      const all = await fetchJson("/api/sessions");
      designState = all.sessions.find((item) => item.session_id === planSessionId);
      if (designState && designState.status === "done" && designState.design && designState.design.latest_commit) break;
      if (designState && designState.status === "waiting_for_user" && designState.waiting_for === "brainstorming_answer") {
        await fetchJson(`/api/sessions/${planEncoded}/brainstorming/answer`, {
          method: "POST",
          body: JSON.stringify({ content: "主要使用者是本地 Workbench 用户，第一版只生成 workplan，不执行代码。" }),
        });
      }
      await wait(200);
    }
    if (!designState || designState.status !== "done" || !designState.design || !designState.design.latest_commit) {
      throw new Error("design council smoke session did not produce a design commit");
    }
```

后续 workplan API smoke 使用这个 `planSessionId` / `planEncoded`，不要再创建普通 `mode=council` session。

- [ ] **Step 2: 运行测试确认失败**

Run:

```powershell
cd apps\patchcouncil-ui
npm run smoke
```

Expected: FAIL，当前 API 不存在 `/workplan/approve`，且仍写 legacy event。

- [ ] **Step 3: 更新 fake runtime**

在 `server.js` 的 `makeRuntimeRunner()` fake 分支中替换 workplan JSON 响应：

```js
      if (prompt.includes("drafting a writing-plans-style")) {
        return {
          ok: true,
          text: [
            "# Smoke Workplan Implementation Plan",
            "",
            "**Source Design:** docs/designs/smoke.md",
            "**Source Design Commit:** abc123",
            "**Goal:** Verify Workplan Council.",
            "**Architecture:** Use fake runtime.",
            "**Tech Stack:** Node.js",
            "",
            "---",
            "",
            "## File Structure",
            "",
            "- Modify: `apps/patchcouncil-ui/server.js` - API route.",
            "",
            "### Task 1: Verify API",
            "",
            "- [ ] **Step 1: Run smoke**",
            "",
            "Run: `npm run smoke`",
            "Expected: PASS",
            "",
            "## Self-Review",
            "",
            "- Spec coverage: covered",
            "- Placeholder scan: clean",
            "- Type / naming consistency: consistent",
            "- Scope check: scoped",
          ].join("\n"),
        };
      }
      if (prompt.includes("reviewing a PatchCouncil Markdown workplan")) {
        return { ok: true, text: JSON.stringify({ stance: "agree", confidence: "high", finalize_readiness: "ready", blockers: [], agreements: ["Plan follows contract."], disagreements: [], recommended_next_step: "request user approval", analysis: "The workplan is ready for user approval." }) };
      }
      if (prompt.includes("Review the reviewer findings and decide whether to accept")) {
        return { ok: true, text: JSON.stringify({ decision: "accept", reason: "Reviewer finding is valid.", revision_required: true, stance: "agree", confidence: "high", finalize_readiness: "not_ready", blockers: [], agreements: ["Apply reviewer finding."], disagreements: [], recommended_next_step: "revise workplan", analysis: "The author accepts the review and will revise the workplan." }) };
      }
      if (prompt.includes("finalizing a PatchCouncil workplan review loop")) {
        return { ok: true, text: JSON.stringify({ decision: "finalize", next_agent: null, role: null, reason: "ready for user approval" }) };
      }
```

- [ ] **Step 4: 更新 workplan POST route**

在 `server.js` 的 `POST /api/sessions/:id/workplan` route 中：

```js
    const state = sessionStore.deriveState(sessionDir);
    if (state.mode !== "design_council") {
      sendJson(res, 409, { error: "workplan requires a design_council session" });
      return true;
    }
    if (!state.design || !state.design.latest_commit) {
      sendJson(res, 409, { error: "workplan requires a design commit" });
      return true;
    }
    if (state.workplan && !["none", "failed", "rejected"].includes(state.workplan.status)) {
      sendJson(res, 409, { error: "workplan already exists or is awaiting approval" });
      return true;
    }
```

调用 `generateWorkplanForSession` 时传入：

```js
          projectRoot,
          topic: state.topic,
          runGit: null,
```

保留 `activeWorkplans` 作为单进程内的快速并发防护，但不要把它当作唯一事实源。持久化防护由 `generateWorkplanForSession()` 的事件检查负责；如果 server 重启导致 `activeWorkplans` 丢失，事件检查仍应返回 `409`。

- [ ] **Step 5: 新增 approve route**

在 events route 前加入：

```js
  const approveMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/workplan\/approve$/);
  if (approveMatch && req.method === "POST") {
    const sessionId = decodeURIComponent(approveMatch[1]);
    const sessionDir = safeJoin(realSessionRoot, sessionId);
    if (!sessionDir || !fs.existsSync(path.join(sessionDir, "transcript.jsonl"))) {
      sendJson(res, 404, { error: "session not found" });
      return true;
    }
    const sessionStore = new SessionStore(realSessionRoot);
    const state = sessionStore.deriveState(sessionDir);
    if (state.status !== "waiting_for_user" || state.waiting_for !== "workplan_approval") {
      sendJson(res, 409, { error: "session is not waiting for workplan approval" });
      return true;
    }
    if (state.workplan?.approved_commit) {
      sendJson(res, 409, { error: "workplan already approved" });
      return true;
    }
    const eventsList = sessionStore.readEvents(sessionDir);
    const nextSeq = eventsList.reduce((max, event) => Math.max(max, Number(event.seq)), -1) + 1;
    sessionStore.appendEvent(sessionDir, {
      schema_version: 1,
      seq: nextSeq,
      type: EVENTS.WORKPLAN_APPROVED,
      phase: "finalized",
      session_id: sessionId,
      artifact_path: state.workplan.artifact_path,
      approved_commit: state.workplan.latest_commit,
      approved_at: new Date().toISOString(),
      approved_by: "host",
    });
    sessionStore.deriveState(sessionDir);
    sessionStore.generateTranscript(sessionDir);
    sendJson(res, 202, { session_id: sessionId, status: "approved" });
    return true;
  }
```

- [ ] **Step 6: 新增 reject route**

加入：

```js
  const rejectMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/workplan\/reject$/);
  if (rejectMatch && req.method === "POST") {
    const sessionId = decodeURIComponent(rejectMatch[1]);
    const sessionDir = safeJoin(realSessionRoot, sessionId);
    if (!sessionDir || !fs.existsSync(path.join(sessionDir, "transcript.jsonl"))) {
      sendJson(res, 404, { error: "session not found" });
      return true;
    }
    const body = await readJsonBody(req);
    const sessionStore = new SessionStore(realSessionRoot);
    const state = sessionStore.deriveState(sessionDir);
    if (state.status !== "waiting_for_user" || state.waiting_for !== "workplan_approval") {
      sendJson(res, 409, { error: "session is not waiting for workplan approval" });
      return true;
    }
    const eventsList = sessionStore.readEvents(sessionDir);
    const nextSeq = eventsList.reduce((max, event) => Math.max(max, Number(event.seq)), -1) + 1;
    sessionStore.appendEvent(sessionDir, {
      schema_version: 1,
      seq: nextSeq,
      type: EVENTS.WORKPLAN_APPROVAL_REJECTED,
      phase: "finalized",
      session_id: sessionId,
      artifact_path: state.workplan.artifact_path,
      workplan_commit: state.workplan.latest_commit,
      rejected_at: new Date().toISOString(),
      reason: String(body.reason || "user rejected workplan"),
    });
    sessionStore.deriveState(sessionDir);
    sessionStore.generateTranscript(sessionDir);
    sendJson(res, 202, { session_id: sessionId, status: "rejected" });
    return true;
  }
```

- [ ] **Step 7: 运行检查**

Run:

```powershell
cd apps\patchcouncil-ui
npm run check
npm run smoke
```

Expected: both PASS。

- [ ] **Step 8: 提交**

Run:

```powershell
git add apps/patchcouncil-ui/server.js apps/patchcouncil-ui/scripts/smoke-test.js
git commit -m "feat: add workplan approval API"
```

Expected: commit succeeds.

## Task 7: Workbench UI

**Files:**
- Modify: `apps/patchcouncil-ui/public/app.js`
- Modify: `apps/patchcouncil-ui/public/styles.css`
- Modify: `apps/patchcouncil-ui/scripts/smoke-test.js`

- [ ] **Step 1: 写静态 UI smoke 失败断言**

在 `smoke-test.js` 静态资源断言中加入：

```js
    const appJs = await fetchText("/app.js");
    if (!appJs.includes("Approve Workplan")) {
      throw new Error("app js missing workplan approval action");
    }
    if (!appJs.includes("workplan_approval_requested")) {
      throw new Error("app js missing workplan artifact projection");
    }
    if (!appJs.includes("Responding to workplan review")) {
      throw new Error("app js missing workplan author response state");
    }
    if (!appJs.includes("Workplan approved")) {
      throw new Error("app js missing approved workplan state");
    }
    if (!appJs.includes("Workplan rejected")) {
      throw new Error("app js missing rejected workplan state");
    }
    if (!appJs.includes("Workplan generation failed")) {
      throw new Error("app js missing failed workplan state");
    }
```

- [ ] **Step 2: 更新 workplanState**

`public/app.js` 当前已有 `latestEvent(type)` helper；保留该 helper，在 `workplanState()` 中用 artifact 状态替换旧 JSON task 状态：

```js
function workplanState() {
  var approved = latestEvent("workplan_approved");
  if (approved) return { status: "approved", event: approved };
  var rejected = latestEvent("workplan_approval_rejected");
  if (rejected) return { status: "rejected", event: rejected };
  var approval = latestEvent("workplan_approval_requested");
  if (approval) return { status: "awaiting_approval", event: approval };
  var failed = latestEvent("workplan_generation_failed") || latestEvent("workplan_draft_commit_failed") || latestEvent("workplan_revision_commit_failed");
  if (failed) return { status: "failed", event: failed };
  var revision = latestEvent("workplan_revision_committed") || latestEvent("workplan_revision_written");
  if (revision) return { status: "revising", event: revision };
  var authorResponse = latestEvent("workplan_author_response_completed") || latestEvent("workplan_author_response_started");
  if (authorResponse) return { status: "author_responding", event: authorResponse };
  var review = latestEvent("workplan_review_completed") || latestEvent("workplan_review_started");
  if (review) return { status: "reviewing", event: review };
  var draft = latestEvent("workplan_draft_committed") || latestEvent("workplan_draft_written") || latestEvent("workplan_draft_started");
  if (draft) return { status: "drafting", event: draft };
  var legacy = latestEvent("workplan_created");
  if (legacy) return { status: "legacy_json_created", event: legacy };
  return { status: "none", event: null };
}
```

- [ ] **Step 3: 更新 renderWorkplanCard**

替换旧 task list 渲染，新增 artifact/approval 状态：

```js
  if (state.status === "none") {
    if (!session.design || !session.design.latest_commit) {
      var noDesign = document.createElement("p");
      noDesign.className = "muted";
      noDesign.textContent = "Workplan requires a committed design.";
      section.append(noDesign);
      return section;
    }
    var button = document.createElement("button");
    button.type = "button";
    button.className = "secondary";
    button.textContent = "Generate Workplan";
    button.addEventListener("click", generateWorkplan);
    section.append(button);
    return section;
  }

  if (["drafting", "reviewing", "author_responding", "revising"].indexOf(state.status) !== -1) {
    var progress = document.createElement("p");
    progress.className = "muted";
    progress.textContent =
      state.status === "drafting" ? "Generating workplan draft..." :
      state.status === "reviewing" ? "Reviewing workplan..." :
      state.status === "author_responding" ? "Responding to workplan review..." :
      "Revising workplan...";
    section.append(progress);
    return section;
  }

  if (state.status === "awaiting_approval") {
    appendWorkplanMeta(section, state.event);
    var actions = document.createElement("div");
    actions.className = "workplan-actions";
    var approve = document.createElement("button");
    approve.type = "button";
    approve.textContent = "Approve Workplan";
    approve.addEventListener("click", approveWorkplan);
    var reject = document.createElement("button");
    reject.type = "button";
    reject.className = "secondary";
    reject.textContent = "Reject";
    reject.addEventListener("click", rejectWorkplan);
    actions.append(approve, reject);
    section.append(actions);
    return section;
  }

  if (state.status === "approved") {
    appendWorkplanMeta(section, state.event);
    var approved = document.createElement("p");
    approved.className = "muted";
    approved.textContent = "Workplan approved.";
    section.append(approved);
    return section;
  }

  if (state.status === "rejected") {
    appendWorkplanMeta(section, state.event);
    var rejected = document.createElement("p");
    rejected.className = "muted";
    rejected.textContent = "Workplan rejected. Generate a new workplan to continue.";
    section.append(rejected);
    var retry = document.createElement("button");
    retry.type = "button";
    retry.className = "secondary";
    retry.textContent = "Generate Workplan";
    retry.addEventListener("click", generateWorkplan);
    section.append(retry);
    return section;
  }

  if (state.status === "failed") {
    appendWorkplanMeta(section, state.event);
    var failed = document.createElement("p");
    failed.className = "muted";
    failed.textContent = "Workplan generation failed: " + (state.event.message || state.event.error || "unknown error");
    section.append(failed);
    var retryFailed = document.createElement("button");
    retryFailed.type = "button";
    retryFailed.className = "secondary";
    retryFailed.textContent = "Retry";
    retryFailed.addEventListener("click", generateWorkplan);
    section.append(retryFailed);
    return section;
  }

  if (state.status === "legacy_json_created") {
    var legacy = document.createElement("p");
    legacy.className = "muted";
    legacy.textContent = "Legacy JSON workplan exists for this session.";
    section.append(legacy);
    return section;
  }
```

Add helpers:

```js
function appendWorkplanMeta(section, event) {
  var pathLine = document.createElement("p");
  pathLine.textContent = "Path: " + (event.artifact_path || "");
  var commitLine = document.createElement("p");
  commitLine.className = "muted";
  commitLine.textContent = "Commit: " + (event.workplan_commit || event.commit || event.approved_commit || "");
  section.append(pathLine, commitLine);
}

async function approveWorkplan() {
  if (!activeSessionId) return;
  await postJson("/api/sessions/" + encodeURIComponent(activeSessionId) + "/workplan/approve", {});
  await loadSessions();
}

async function rejectWorkplan() {
  if (!activeSessionId) return;
  var reason = window.prompt("Reject reason", "需要修订 workplan");
  if (reason === null) return;
  await postJson("/api/sessions/" + encodeURIComponent(activeSessionId) + "/workplan/reject", { reason: reason });
  await loadSessions();
}
```

- [ ] **Step 4: 更新 generateWorkplan**

保留 `POST /api/sessions/:id/workplan` endpoint，但完成条件改为新 artifact 事件。不要继续等待或查找 `workplan_created`：

```js
async function generateWorkplan() {
  if (!activeSessionId) return;
  await postJson("/api/sessions/" + encodeURIComponent(activeSessionId) + "/workplan", {});
  await selectSession(activeSessionId);
  pollForWorkplanResult(activeSessionId);
}

function pollForWorkplanResult(sessionId) {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  pollInterval = setInterval(function () {
    if (activeSessionId !== sessionId) {
      clearInterval(pollInterval);
      pollInterval = null;
      return;
    }
    (async function () {
      try {
        var data = await fetchJson("/api/sessions/" + encodeURIComponent(sessionId) + "/events?since=" + lastPollSeq);
        var newEvents = Array.isArray(data.events) ? data.events : [];
        for (var i = 0; i < newEvents.length; i++) {
          activeEvents.push(newEvents[i]);
          lastPollSeq = newEvents[i].seq;
        }
        var state = workplanState();
        if (state.status === "awaiting_approval" || state.status === "approved" || state.status === "rejected" || state.status === "failed") {
          clearInterval(pollInterval);
          pollInterval = null;
          await loadSessions();
          renderAll();
        } else {
          renderAll();
        }
      } catch (_) { /* keep polling */ }
    })();
  }, 2000);
}
```

如果当前 `generateWorkplan()` 已有按钮 loading / error toast 逻辑，保留这些 UI 细节，只替换完成判断：成功生成的标志是 `state.workplan.status === "awaiting_approval"` 或 transcript 中存在 `workplan_approval_requested`；失败标志是 `workplan_generation_failed`、`workplan_draft_commit_failed` 或 `workplan_revision_commit_failed`。

- [ ] **Step 5: updateComposer 处理 workplan approval**

在 `updateComposer()` 的 `waiting_for_user` 分支中区分：

```js
    if (session.waiting_for === "workplan_approval") {
      els.composerInput.placeholder = "请在 Workplan 卡片中批准或拒绝...";
      els.composerButton.textContent = "Waiting";
      els.composerButton.disabled = true;
    } else {
      els.composerInput.placeholder = "回答 brainstorming 问题...";
      els.composerButton.textContent = "Answer";
      els.composerButton.disabled = false;
    }
```

在其他分支把 `els.composerButton.disabled = false;` 设置回来。

- [ ] **Step 6: renderStatus 展示 workplan**

在 `renderStatus()` design 行后加入：

```js
  if (session && session.workplan && session.workplan.status !== "none") {
    rows.push(["Workplan", (session.workplan.latest_commit || "none") + " · " + (session.workplan.status || "")]);
  }
```

- [ ] **Step 7: 添加样式**

在 `styles.css` 中补充：

```css
.workplan-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.workplan-panel .error-text {
  color: #9b2c2c;
}
```

- [ ] **Step 7: 运行检查**

Run:

```powershell
cd apps\patchcouncil-ui
npm run check
npm run smoke
```

Expected: both PASS。

- [ ] **Step 8: 提交**

Run:

```powershell
git add apps/patchcouncil-ui/public/app.js apps/patchcouncil-ui/public/styles.css apps/patchcouncil-ui/scripts/smoke-test.js
git commit -m "feat: show workplan artifact approvals"
```

Expected: commit succeeds.

## Task 8: 文档与旧 JSON 清理

**Files:**
- Modify: `docs/COUNCIL_EVENTS.md`
- Modify: `docs/ROADMAP.md`
- Modify: `apps/patchcouncil-ui/README.md`
- Modify: `README.md`
- Modify: `apps/patchcouncil-ui/engine/prompts/workplan_create.md`

- [ ] **Step 1: 更新事件文档**

在 `docs/COUNCIL_EVENTS.md` 中：

- 增加 Workplan Council v1 事件列表。
- 明确 `phase=finalized` 表示 post-discussion artifact lifecycle。
- 保留旧 `workplan_created` 说明为 legacy JSON event。
- 增加 `state.workplan` 示例。
- 增加 approve/reject 说明。

- [ ] **Step 2: 更新 README**

在 `apps/patchcouncil-ui/README.md` 和顶层 `README.md` 中，把 “结构化 JSON workplan” 改为：

```markdown
- 从已提交的 design artifact 生成 writing-plans 风格 Markdown workplan。
- Workplan 会经过 council review / revision，并在用户批准前不会进入执行。
```

- [ ] **Step 3: 更新 ROADMAP**

在 `docs/ROADMAP.md` 中把 workplan 项改为：

```markdown
- Workplan Council v1：从 design latest commit 生成 Markdown workplan，经过 council review/revision 后等待用户批准；暂不执行代码。
```

- [ ] **Step 4: 处理旧 prompt**

将 `apps/patchcouncil-ui/engine/prompts/workplan_create.md` 内容替换为 legacy 注释，避免误用：

```markdown
Legacy prompt for JSON Workplan v1.

New sessions must use:
- workplan_draft.md
- workplan_review.md
- workplan_author_response.md
- workplan_revision.md
- workplan_finalize.md

This file is kept only so old references fail visibly during migration tests instead of silently producing new artifacts with the old schema.
```

- [ ] **Step 5: 运行检查**

Run:

```powershell
cd apps\patchcouncil-ui
npm run check
npm run smoke
npm run runtime:fake
```

Expected: all PASS。

- [ ] **Step 6: 提交**

Run:

```powershell
git add docs/COUNCIL_EVENTS.md docs/ROADMAP.md apps/patchcouncil-ui/README.md README.md apps/patchcouncil-ui/engine/prompts/workplan_create.md
git commit -m "docs: document workplan council flow"
```

Expected: commit succeeds.

## 最终验证

- [ ] **Step 1: 运行完整检查**

Run:

```powershell
cd apps\patchcouncil-ui
npm run check
npm run smoke
npm run runtime:fake
```

Expected:

```text
check passes
smoke ok
runtime fake matrix passes
```

- [ ] **Step 2: 检查新入口不写旧事件**

Run:

```powershell
rg "workplan_created" apps\patchcouncil-ui\engine apps\patchcouncil-ui\server.js apps\patchcouncil-ui\public\app.js
```

Expected: only legacy compatibility references remain in `events.js`, `session-store.js`, and tests that explicitly mention old session compatibility. `server.js` and new generation flow should not write `workplan_created`.

- [ ] **Step 3: 检查工作区**

Run:

```powershell
git status --short
```

Expected: only intentional files are modified. `.project-ai/sessions` artifacts are not staged.

## Self-Review

- Spec coverage: 覆盖了 staged spec 的核心要求：design latest commit 输入、Markdown artifact、native prompts、review/revision loop、approval/reject、旧 JSON 迁移、phase 约定、UI/API/test/docs。
- Placeholder scan: 本计划没有使用占位步骤；所有任务都有具体文件、代码片段、命令和预期结果。
- Type / naming consistency: 事件名与 spec 保持一致，state 字段使用 `workplan.status`、`latest_commit`、`approved_commit`、`waiting_for=workplan_approval`。
- Scope check: 本计划不包含代码执行，不进入 task assignment/execution/review phase，保持 Workplan Council v1 范围。
