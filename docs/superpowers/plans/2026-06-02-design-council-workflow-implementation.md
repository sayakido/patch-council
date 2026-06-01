# Design Council Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 PatchCouncil council event loop 前增加 brainstorming prelude，产出 git-backed design 文档，再复用现有 council loop 进行 design review / revision，并让 workplan 基于最终 design commit。

**Architecture:** 不新增通用 workflow 状态机，只在 `CouncilEngine` 内增加 `mode=design_council` 的前置 brainstorming phase 和 design artifact 管理。`discussion` phase 继续使用现有 coordinator / agent turn / signal / finalize gate，brief 通过 design path + commit hash + summary 连接两段流程。事件源仍是唯一事实来源，`state.json`、transcript、UI 都从事件投影。

**Tech Stack:** Node.js CommonJS、现有 `CouncilEngine`、JSONL event log、vanilla JS Workbench、git CLI、`npm run check`、`npm run smoke`。

---

## 规格来源

实现以下设计：

```text
docs/superpowers/specs/2026-06-02-design-council-workflow-skill-design.md
```

固定规则：

- `mode=design_council` 默认从 `brainstorming` phase 开始。
- lead agent 默认来自 `skill.yaml`，但最终值必须从 engine 全局 agent config 解析，可被 session/config 覆盖。
- 创建 session 时先校验所需 agent 可用，不可用则拒绝创建。
- Brainstorming 每次只问用户一个问题，事件使用 `question_seq`。
- 第一版 design 写到 `docs/designs/YYYY-MM-DD-<slug>.md`，写入前确保目录存在。
- design 文件落盘和 git commit 成功是两个独立事件。
- commit 只允许 stage design artifact 文件。
- draft commit 后进入现有 `discussion` loop。
- reviewer 可以 challenge，也可以提出建设性补充，但不直接修改 design。
- lead agent 根据 review 修订 design，并生成 revision commit。
- workplan 在 `design_council` 下必须基于 `design.latest_commit`，没有 design commit 时返回 409。

## 文件边界

- 创建 `apps/patchcouncil-ui/engine/design-council.js`
  - 承载 design path、prompt 输出解析、design file 写入、git commit、brief summary 等纯逻辑。
- 创建 `apps/patchcouncil-ui/engine/skills/brainstorming-prelude/skill.yaml`
  - 保存内置 prelude 默认配置。
- 创建 `apps/patchcouncil-ui/engine/prompts/brainstorming_ask_or_draft.md`
  - lead agent 决定继续追问或生成 design。
- 创建 `apps/patchcouncil-ui/engine/prompts/design_draft.md`
  - lead agent 生成第一版 design markdown。
- 创建 `apps/patchcouncil-ui/engine/prompts/design_revision.md`
  - lead agent 根据 review 修订 design markdown。
- 修改 `apps/patchcouncil-ui/engine/events.js`
  - 增加 brainstorming/design 事件构造函数和事件常量。
- 修改 `apps/patchcouncil-ui/engine/council.js`
  - 增加 `mode`、brainstorming runner、design council brief 注入、revision hook、agent 可用性校验。
- 修改 `apps/patchcouncil-ui/engine/session-store.js`
  - 投影 `waiting_for_user`、`design`、`brainstorming` 状态，渲染 transcript 中的新事件。
- 修改 `apps/patchcouncil-ui/server.js`
  - 创建 session 时读取 `mode` 和 `brainstorming` 配置；新增 `/api/sessions/:id/brainstorming/answer`。
- 修改 `apps/patchcouncil-ui/engine/workplan.js`
  - `design_council` 下使用 final design commit / artifact path 构建 workplan brief；无 commit 返回 409。
- 修改 `apps/patchcouncil-ui/public/app.js`
  - 展示 brainstorming Q/A、design artifact、commit hash；waiting 状态下 composer 提交 answer API。
- 修改 `apps/patchcouncil-ui/scripts/council-smoke.js`
  - 覆盖 engine 行为、事件、状态、workplan guard。
- 修改 `apps/patchcouncil-ui/scripts/smoke-test.js`
  - 覆盖 HTTP 创建 design council、answer API、workplan guard。
- 修改 `apps/patchcouncil-ui/package.json`
  - `npm run check` 增加新文件语法检查。
- 修改 `docs/COUNCIL_EVENTS.md`、`docs/AI_CONTEXT.md`、`docs/ARCHITECTURE.md`
  - 记录新增事件、phase、默认流程。

## Task 1：事件和纯函数基础

**Files:**
- Create: `apps/patchcouncil-ui/engine/design-council.js`
- Modify: `apps/patchcouncil-ui/engine/events.js`
- Modify: `apps/patchcouncil-ui/scripts/council-smoke.js`
- Modify: `apps/patchcouncil-ui/package.json`

- [ ] **Step 1: 写事件构造和纯函数的失败测试**

在 `apps/patchcouncil-ui/scripts/council-smoke.js` 的 import 中增加：

```js
const {
  buildDesignArtifactPath,
  parseAskOrDraft,
  summarizeDesignForBrief,
} = require("../engine/design-council");
const eventBuilders = require("../engine/events");
```

新增测试函数：

```js
async function testDesignCouncilPureHelpers() {
  setupTest("design council pure helpers");

  const artifactPath = buildDesignArtifactPath(testDir, "Design Council Workflow!");
  assert.match(artifactPath, /docs[\\/]designs[\\/]\\d{4}-\\d{2}-\\d{2}-design-council-workflow\\.md$/);

  const ask = parseAskOrDraft(JSON.stringify({
    decision: "ask_user",
    question: "主要使用者是谁？",
    reason: "需要确定目标用户。",
    known_context: ["需要替代 open council"],
    missing_context: ["目标用户"],
  }));
  assert.equal(ask.ok, true);
  assert.equal(ask.value.decision, "ask_user");
  assert.equal(ask.value.question, "主要使用者是谁？");

  const draft = parseAskOrDraft("```json\n{\"decision\":\"draft_design\",\"reason\":\"信息足够\",\"known_context\":[],\"missing_context\":[]}\n```");
  assert.equal(draft.ok, true);
  assert.equal(draft.value.decision, "draft_design");

  const multiQuestion = parseAskOrDraft("{\"decision\":\"ask_user\",\"question\":\"问题一？问题二？\",\"reason\":\"best effort\",\"known_context\":[],\"missing_context\":[]}");
  assert.equal(multiQuestion.ok, true);

  const summary = summarizeDesignForBrief("# Title\n\n" + "a".repeat(3000), 120);
  assert.ok(summary.length <= 140);
  assert.match(summary, /clipped/i);

  const event = eventBuilders.brainstormingQuestionCreated("s1", 1, "brainstorming", 2, "codex", "主要使用者是谁？", "reason", [], ["目标用户"]);
  assert.equal(event.type, eventBuilders.EVENTS.BRAINSTORMING_QUESTION_CREATED);
  assert.equal(event.question_seq, 2);

  teardownTest();
  pass();
}
```

在 `main()` 中、engine 行为测试前调用：

```js
await testDesignCouncilPureHelpers();
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```powershell
cd apps\patchcouncil-ui
npm run smoke
```

Expected: FAIL，提示 `../engine/design-council` 或事件构造函数不存在。

- [ ] **Step 3: 实现 `design-council.js` 的纯函数**

创建 `apps/patchcouncil-ui/engine/design-council.js`：

```js
"use strict";

const fs = require("fs");
const path = require("path");

function clipTextLocal(text, limit) {
  const value = String(text || "");
  if (!value || value.length <= limit) return value;
  const head = Math.max(Math.floor(limit / 2), 1);
  const tail = Math.max(limit - head, 1);
  return value.slice(0, head) + "\n\n[... clipped ...]\n\n" + value.slice(-tail);
}

function dateStamp(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function slugifyDesignTopic(topic) {
  return String(topic || "")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\u4e00-\u9fa5-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "design";
}

function buildDesignArtifactPath(projectRoot, topic, date = new Date()) {
  return path.join(projectRoot, "docs", "designs", `${dateStamp(date)}-${slugifyDesignTopic(topic)}.md`);
}

function parseJsonObject(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) { /* continue */ }
  const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fence) {
    try { return JSON.parse(fence[1].trim()); } catch (_) { /* continue */ }
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch (_) { /* continue */ }
  }
  return null;
}

function parseAskOrDraft(raw) {
  const value = parseJsonObject(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "failed to parse ask_or_draft JSON" };
  }
  if (!["ask_user", "draft_design"].includes(value.decision)) {
    return { ok: false, error: "invalid ask_or_draft decision" };
  }
  if (typeof value.reason !== "string" || !value.reason.trim()) {
    return { ok: false, error: "ask_or_draft.reason is required" };
  }
  value.known_context = Array.isArray(value.known_context) ? value.known_context.filter((x) => typeof x === "string") : [];
  value.missing_context = Array.isArray(value.missing_context) ? value.missing_context.filter((x) => typeof x === "string") : [];
  if (value.decision === "ask_user") {
    if (typeof value.question !== "string" || !value.question.trim()) {
      return { ok: false, error: "ask_or_draft.question is required" };
    }
    value.question = value.question.trim();
  }
  return { ok: true, value };
}

function summarizeDesignForBrief(markdown, limit = 1800) {
  return clipTextLocal(String(markdown || "").trim(), limit);
}

function ensureDesignDirectory(artifactPath) {
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
}

module.exports = {
  buildDesignArtifactPath,
  ensureDesignDirectory,
  parseAskOrDraft,
  summarizeDesignForBrief,
  slugifyDesignTopic,
};
```

- [ ] **Step 4: 增加事件常量和构造函数**

在 `apps/patchcouncil-ui/engine/events.js` 的 `EVENTS` 中增加：

```js
BRAINSTORMING_STARTED: "brainstorming_started",
BRAINSTORMING_QUESTION_CREATED: "brainstorming_question_created",
BRAINSTORMING_ANSWER_RECEIVED: "brainstorming_answer_received",
DESIGN_FILE_WRITTEN: "design_file_written",
DESIGN_COMMIT_CREATED: "design_commit_created",
DESIGN_COMMIT_FAILED: "design_commit_failed",
DESIGN_REVISION_WRITTEN: "design_revision_written",
DESIGN_REVISION_COMMITTED: "design_revision_committed",
```

在 `workplanGenerationFailed()` 前增加：

```js
function brainstormingStarted(sessionId, seq, phase, leadAgent, skillId, maxQuestions) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.BRAINSTORMING_STARTED, phase), {
    lead_agent: leadAgent,
    skill_id: skillId,
    max_questions: maxQuestions,
  });
}

function brainstormingQuestionCreated(sessionId, seq, phase, questionSeq, agent, question, reason, knownContext, missingContext) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.BRAINSTORMING_QUESTION_CREATED, phase), {
    question_seq: questionSeq,
    agent,
    question,
    reason,
    known_context: knownContext || [],
    missing_context: missingContext || [],
  });
}

function brainstormingAnswerReceived(sessionId, seq, phase, questionSeq, content) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.BRAINSTORMING_ANSWER_RECEIVED, phase), {
    question_seq: questionSeq,
    content,
  });
}

function designFileWritten(sessionId, seq, phase, artifactPath, generator, title, revision) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.DESIGN_FILE_WRITTEN, phase), {
    artifact_path: artifactPath,
    generator,
    title,
    revision,
  });
}

function designCommitCreated(sessionId, seq, phase, artifactPath, commit, commitMessage) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.DESIGN_COMMIT_CREATED, phase), {
    artifact_path: artifactPath,
    commit,
    commit_message: commitMessage,
  });
}

function designCommitFailed(sessionId, seq, phase, artifactPath, revision, stage, error) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.DESIGN_COMMIT_FAILED, phase), {
    artifact_path: artifactPath,
    revision,
    stage,
    error,
  });
}

function designRevisionWritten(sessionId, seq, phase, artifactPath, sourceCommit, sourceReviewSeq, generator, revision) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.DESIGN_REVISION_WRITTEN, phase), {
    artifact_path: artifactPath,
    source_commit: sourceCommit,
    source_review_seq: sourceReviewSeq,
    generator,
    revision,
  });
}

function designRevisionCommitted(sessionId, seq, phase, artifactPath, sourceCommit, commit, commitMessage) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.DESIGN_REVISION_COMMITTED, phase), {
    artifact_path: artifactPath,
    source_commit: sourceCommit,
    commit,
    commit_message: commitMessage,
  });
}
```

把这些函数加入 `module.exports`。

- [ ] **Step 5: 更新语法检查脚本**

在 `apps/patchcouncil-ui/package.json` 的 `check` 中追加：

```text
node --check ./engine/design-council.js
```

- [ ] **Step 6: 运行测试确认通过**

Run:

```powershell
cd apps\patchcouncil-ui
npm run check
npm run smoke
```

Expected: PASS。

- [ ] **Step 7: Commit**

```powershell
git add apps\patchcouncil-ui\engine\design-council.js apps\patchcouncil-ui\engine\events.js apps\patchcouncil-ui\scripts\council-smoke.js apps\patchcouncil-ui\package.json
git commit -m "feat: add design council event helpers"
```

## Task 2：session 创建前置校验和 mode/config 快照

**Files:**
- Modify: `apps/patchcouncil-ui/engine/council.js`
- Modify: `apps/patchcouncil-ui/server.js`
- Modify: `apps/patchcouncil-ui/scripts/council-smoke.js`
- Modify: `apps/patchcouncil-ui/scripts/smoke-test.js`

- [ ] **Step 1: 写 agent 可用性和 config 快照失败测试**

在 `council-smoke.js` 中增加：

```js
async function testDesignCouncilSessionStartedConfig() {
  setupTest("design council session_started config");

  const config = JSON.parse(JSON.stringify(MINIMAL_CONFIG));
  config.design_council = { lead_agent: "claude", max_questions: 5 };
  config.council.min_distinct_agents = 1;
  config.council.max_turns = 1;

  const { events } = await runEngine(config, [
    {
      match: (p) => p.includes("brainstorming") || p.includes("ask_or_draft"),
      response: { ok: true, text: JSON.stringify({ decision: "ask_user", question: "主要使用者是谁？", reason: "需要澄清目标用户。", known_context: [], missing_context: ["目标用户"] }) },
    },
  ], { mode: "design_council" });

  const started = events.find((e) => e.type === EVENTS.SESSION_STARTED);
  assert.equal(started.mode, "design_council");
  assert.equal(started.phase, "brainstorming");
  assert.equal(started.config.brainstorming.lead_agent, "claude");
  assert.equal(started.config.brainstorming.max_questions, 5);

  teardownTest();
  pass();
}

async function testRequiredAgentValidation() {
  setupTest("required agent validation");

  const config = JSON.parse(JSON.stringify(MINIMAL_CONFIG));
  config.design_council = { lead_agent: "missing-agent", max_questions: 5 };

  assert.throws(() => CouncilEngine.validateRequiredAgents(config, { mode: "design_council" }), /missing-agent/);

  teardownTest();
  pass();
}
```

把 `runEngine(config, scenarios)` 改成支持第三个参数：

```js
async function runEngine(config, scenarios, options = {}) {
  const store = new SessionStore(testDir);
  const session = store.createSession("test topic");
  const fakeRuntime = makeFakeRuntime(scenarios);

  const engine = new CouncilEngine({
    config,
    sessionStore: store,
    runAgent: fakeRuntime,
    projectRoot: testDir,
    prompts,
    sessionDir: session.dir,
    sessionId: session.id,
    mode: options.mode || "council",
    brainstorming: options.brainstorming,
  });
  ...
}
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```powershell
cd apps\patchcouncil-ui
npm run smoke
```

Expected: FAIL，`CouncilEngine.validateRequiredAgents` 不存在，或 `mode` 没有进入 `session_started`。

- [ ] **Step 3: 实现 mode/config 解析**

在 `CouncilEngine` constructor 中增加：

```js
this.mode = options.mode || "council";
this.brainstormingConfig = Object.assign(
  {},
  options.config?.design_council || {},
  options.brainstorming || {}
);
this.phase = this.mode === "design_council" ? "brainstorming" : "discussion";
```

增加 helper：

```js
function resolveDesignCouncilConfig(config, requested = {}) {
  const defaults = Object.assign({ lead_agent: "codex", max_questions: 8 }, config.design_council || {});
  const merged = Object.assign({}, defaults, requested || {});
  return {
    lead_agent: merged.lead_agent,
    max_questions: Math.max(1, Number(merged.max_questions || 8)),
  };
}

function validateRequiredAgents(config, options = {}) {
  const agents = availableAgents(config.agents);
  const coordinator = selectCoordinator(config);
  if (!coordinator) throw new Error("coordinator agent is not available");
  if (options.mode === "design_council") {
    const dc = resolveDesignCouncilConfig(config, options.brainstorming);
    if (!agents[dc.lead_agent]) throw new Error(`design council lead agent is not available: ${dc.lead_agent}`);
  }
  return true;
}
```

导出：

```js
module.exports = { ..., resolveDesignCouncilConfig, validateRequiredAgents };
CouncilEngine.validateRequiredAgents = validateRequiredAgents;
```

把 `run()` 内部现有的 limits 计算抽成实例方法，供 resume 复用：

```js
resolveCouncilLimits() {
  const council = this.config.council || {};
  return {
    maxContextChars: council.max_context_chars || 2500,
    maxTranscriptChars: council.max_transcript_chars || 2500,
    maxMessageChars: council.max_message_chars || 800,
  };
}
```

`run()` 中使用：

```js
const limits = this.resolveCouncilLimits();
const { maxContextChars, maxTranscriptChars, maxMessageChars } = limits;
```

同时把 `run()` 中 `SESSION_STARTED` 之后的现有 route / agent turn / decide / finalize / session_finished 逻辑抽成：

```js
async runDiscussionLoop(topic) {
  const limits = this.resolveCouncilLimits();
  const councilCfg = this.config.council || {};
  const maxTurns = councilCfg.max_turns ?? 3;
  const minDistinctAgents = councilCfg.min_distinct_agents ?? 2;
  const agents = availableAgents(this.config.agents);
  const context = collectContext(this.projectRoot, this.config);
  const agentProfiles = formatAgentProfiles(this.config);
  const sourceContext = this.sourceMetadata
    ? "### Source session\n\n" + this.sourceMetadata.source_summary + "\n\nTranscript: " + this.sourceMetadata.source_transcript_path
    : "";
  const contextWithSource = [sourceContext, context].filter(Boolean).join("\n\n");

  let decision = null;
  try {
    const routeResult = await this.routeCoordinator(topic, contextWithSource, agentProfiles, limits);
    decision = this.avoidCoordinatorAsFirstAgent(routeResult, agents);

    if (!this.cancelRequested) {
      while (decision && decision.decision === "continue" && this.turnCount < maxTurns) {
        const agentName = resolveAgentName(agents, decision.next_agent);
        if (!agentName) {
          this.emitEvent(events.EVENTS.COORDINATOR_ERROR, {
            turn: this.turnCount + 1,
            message: `Unknown agent: ${decision.next_agent}`,
            recoverable: true,
            action: "fallback_finalize",
            details: { requested: decision.next_agent, available: Object.keys(agents) },
          });
          this.errorCount++;
          break;
        }

        const turnNum = this.turnCount + 1;
        await this.runAgentTurn(turnNum, agentName, agents[agentName], decision.role, topic, contextWithSource, limits);
        this.turnCount++;
        this.spokenAgents.add(agentName);

        if (this.mode === "design_council") {
          await this.maybeReviseDesignFromLatestReview(topic);
        }

        if (this.turnCount >= maxTurns || this.cancelRequested) break;

        const decideResult = await this.decideCoordinator(topic, contextWithSource, agentProfiles, limits, maxTurns);
        if (!decideResult) break;
        decision = this.enforceMinDistinctAgents(decideResult, agents, minDistinctAgents, maxTurns);
        decision = this.applyFinalizeGate(decision, agents, minDistinctAgents, maxTurns);
        if (decision && decision.decision === "finalize") break;
      }
    }
  } catch (err) {
    this.emitEvent(events.EVENTS.SESSION_ERROR, {
      message: err.message || String(err),
      recoverable: false,
      action: "abort",
      details: {},
    });
    this.errorCount++;
  }

  if (this.cancelRequested) {
    this.emitEvent(events.EVENTS.FINALIZED, { summary: "Session cancelled by host.", next_steps: [] });
  } else {
    await this.finalizeCouncil(topic, contextWithSource, limits);
  }

  const finishedAt = new Date().toISOString();
  const durationMs = new Date(finishedAt) - new Date(this.startedAt);
  this.phase = "finalized";
  this.emitEvent(events.EVENTS.SESSION_FINISHED, {
    finished_at: finishedAt,
    outcome: this.cancelRequested ? "cancelled" : (this.errorCount > 0 ? "error" : "discussion_only"),
    duration_ms: durationMs,
    turn_count: this.turnCount,
    distinct_agents: [...this.spokenAgents],
    error_count: this.errorCount,
  });
  return { outcome: this.errorCount > 0 ? "error" : "discussion_only", turnCount: this.turnCount, errorCount: this.errorCount };
}
```

`run()` 在 `SESSION_STARTED` 和可选 prelude 后，只调用：

```js
return await this.runDiscussionLoop(topic);
```

这样 `run()` 和后续 `resumeDesignCouncil()` 共享同一段 discussion loop，避免用户回答后 draft 已提交但没有 review 的中间断层。

- [ ] **Step 4: 更新 `session_started` 快照**

在 `CouncilEngine.run()` 发 `SESSION_STARTED` 前解析：

```js
const designCouncilConfig = this.mode === "design_council"
  ? resolveDesignCouncilConfig(this.config, this.brainstormingConfig)
  : null;
```

把 `mode` 和 `config` 写成：

```js
mode: this.mode,
config: {
  council: limits,
  agents: sanitizeAgentConfig(this.config.agents),
  brainstorming: designCouncilConfig,
},
```

旧 `mode=council` 可以让 `brainstorming` 为 `null`。

- [ ] **Step 5: server 创建 session 前校验 agent**

在 `server.js` 创建 `SessionStore` 前读取：

```js
const config = loadConfig(projectRoot);
const mode = String(body.mode || "council");
const brainstorming = body.brainstorming && typeof body.brainstorming === "object" ? body.brainstorming : null;
try {
  CouncilEngine.validateRequiredAgents(config, { mode, brainstorming });
} catch (error) {
  sendJson(res, 409, { error: error.message });
  return true;
}
```

创建 engine 时传入：

```js
mode,
brainstorming,
```

- [ ] **Step 6: 运行验证**

Run:

```powershell
cd apps\patchcouncil-ui
npm run check
npm run smoke
```

Expected: PASS。

- [ ] **Step 7: Commit**

```powershell
git add apps\patchcouncil-ui\engine\council.js apps\patchcouncil-ui\server.js apps\patchcouncil-ui\scripts\council-smoke.js apps\patchcouncil-ui\scripts\smoke-test.js
git commit -m "feat: validate design council session config"
```

## Task 3：Brainstorming prelude 和 answer API

**Files:**
- Create: `apps/patchcouncil-ui/engine/skills/brainstorming-prelude/skill.yaml`
- Create: `apps/patchcouncil-ui/engine/prompts/brainstorming_ask_or_draft.md`
- Modify: `apps/patchcouncil-ui/engine/council.js`
- Modify: `apps/patchcouncil-ui/server.js`
- Modify: `apps/patchcouncil-ui/engine/session-store.js`
- Modify: `apps/patchcouncil-ui/scripts/council-smoke.js`

- [ ] **Step 1: 写 prelude 等待用户的失败测试**

在 `council-smoke.js` 中增加：

```js
async function testBrainstormingAskUserWaitsForAnswer() {
  setupTest("brainstorming ask_user waits for answer");

  const config = JSON.parse(JSON.stringify(MINIMAL_CONFIG));
  config.design_council = { lead_agent: "codex", max_questions: 8 };

  const { events, result, store, session } = await runEngine(config, [
    {
      match: (p) => p.includes("ask_or_draft") || p.includes("一次只问一个问题"),
      response: { ok: true, text: JSON.stringify({ decision: "ask_user", question: "主要使用者是谁？", reason: "需要澄清目标用户。", known_context: [], missing_context: ["目标用户"] }) },
    },
  ], { mode: "design_council" });

  assert.equal(result.outcome, "waiting_for_user");
  assert.ok(events.some((e) => e.type === EVENTS.BRAINSTORMING_STARTED));
  const question = events.find((e) => e.type === EVENTS.BRAINSTORMING_QUESTION_CREATED);
  assert.equal(question.question_seq, 1);
  assert.equal(question.agent, "codex");

  const state = store.deriveState(session.dir);
  assert.equal(state.status, "waiting_for_user");
  assert.equal(state.waiting_for, "brainstorming_answer");
  assert.equal(state.brainstorming.question_count, 1);

  teardownTest();
  pass();
}

async function testBrainstormingAnswerResumesIntoCouncilReview() {
  setupTest("brainstorming answer resumes into council review");

  const config = JSON.parse(JSON.stringify(MINIMAL_CONFIG));
  config.design_council = { lead_agent: "codex", max_questions: 8 };
  config.council.min_distinct_agents = 1;
  config.council.max_turns = 1;

  let askCount = 0;
  let routeSawDesign = false;
  const { engine, events } = await runEngine(config, [
    {
      match: (p) => p.includes("一次只问一个问题"),
      response: () => {
        askCount++;
        if (askCount === 1) {
          return { ok: true, text: JSON.stringify({ decision: "ask_user", question: "主要使用者是谁？", reason: "需要澄清目标用户。", known_context: [], missing_context: ["目标用户"] }) };
        }
        return { ok: true, text: JSON.stringify({ decision: "draft_design", reason: "用户已回答目标用户。", known_context: ["主要使用者是项目 owner"], missing_context: [] }) };
      },
    },
    { match: (p) => p.includes("Markdown design doc"), response: { ok: true, text: "# Test Design\n\n## Goal\n\nBuild it.\n" } },
    {
      match: isRoutePrompt,
      response: (prompt) => {
        routeSawDesign = prompt.includes("Design artifact") && prompt.includes("abc1234");
        return { ok: true, text: JSON.stringify({ decision: "continue", next_agent: "claude", role: "reviewer", reason: "review committed design" }) };
      },
    },
    { match: isAgentTurnPrompt, response: { ok: true, text: JSON.stringify({ stance: "agree", confidence: "high", finalize_readiness: "ready", blockers: [], agreements: ["Design is reviewable."], disagreements: [], recommended_next_step: "finalize", analysis: "Review complete." }) } },
    { match: isDecidePrompt, response: { ok: true, text: JSON.stringify({ decision: "finalize", next_agent: null, role: null, reason: "done" }) } },
    { match: isFinalizePrompt, response: { ok: true, text: JSON.stringify({ consensus: "Design reviewed.", disagreements: "none", recommended_next_step: "generate workplan", needs_confirmation: false, next_steps: ["generate workplan"] }) } },
  ], {
    mode: "design_council",
    runGit: async (args) => args[0] === "rev-parse" ? { ok: true, text: "abc1234\n" } : { ok: true, text: "" },
  });

  engine.addBrainstormingAnswer("主要使用者是项目 owner。");
  const resumed = await engine.resumeDesignCouncil("test topic");

  assert.equal(resumed.outcome, "discussion_only");
  assert.equal(routeSawDesign, true);
  assert.ok(events.some((e) => e.type === EVENTS.DESIGN_COMMIT_CREATED));
  assert.ok(events.some((e) => e.type === EVENTS.AGENT_TURN_COMPLETED));

  teardownTest();
  pass();
}
```

在 `main()` 中调用：

```js
await testBrainstormingAskUserWaitsForAnswer();
await testBrainstormingAnswerResumesIntoCouncilReview();
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```powershell
cd apps\patchcouncil-ui
npm run smoke
```

Expected: FAIL，engine 还没有 `brainstorming_started` 和 waiting 状态。

- [ ] **Step 3: 新增 prompt 和 skill 配置**

创建 `apps/patchcouncil-ui/engine/skills/brainstorming-prelude/skill.yaml`：

```yaml
id: brainstorming_prelude
title: Brainstorming Prelude
version: 1
lead_agent: codex
limits:
  max_questions: 8
prompts:
  ask_or_draft: ../../prompts/brainstorming_ask_or_draft.md
  design_draft: ../../prompts/design_draft.md
  design_revision: ../../prompts/design_revision.md
```

创建 `apps/patchcouncil-ui/engine/prompts/brainstorming_ask_or_draft.md`：

```markdown
You are running PatchCouncil's brainstorming prelude.

Topic:
{{topic}}

Context so far:
{{brief}}

Rules:
- Ask at most one user-facing question.
- Prefer a short, concrete question the user can answer directly.
- If enough context exists, choose draft_design.
- Do not write implementation plans.
- Do not write code.
- Output strict JSON only.

Schema for asking:
{
  "decision": "ask_user",
  "question": "one concise question",
  "reason": "why this question is needed",
  "known_context": ["facts already known"],
  "missing_context": ["missing facts"]
}

Schema for drafting:
{
  "decision": "draft_design",
  "reason": "why context is sufficient",
  "known_context": ["facts already known"],
  "missing_context": []
}
```

- [ ] **Step 4: 实现 prelude 单轮**

在 `CouncilEngine.run()` 的 `SESSION_STARTED` 后增加分支：

```js
if (this.mode === "design_council") {
  const preludeResult = await this.runBrainstormingPrelude(topic, context, limits, designCouncilConfig);
  if (preludeResult.waiting) {
    this.waitingForUser = true;
    return { outcome: "waiting_for_user", turnCount: this.turnCount, errorCount: this.errorCount };
  }
}
```

新增方法：

```js
async runBrainstormingPrelude(topic, context, limits, designCouncilConfig) {
  this.emitEvent(events.EVENTS.BRAINSTORMING_STARTED, {
    lead_agent: designCouncilConfig.lead_agent,
    skill_id: "brainstorming_prelude",
    max_questions: designCouncilConfig.max_questions,
  });

  const agents = availableAgents(this.config.agents);
  const lead = agents[designCouncilConfig.lead_agent];
  const brief = this.buildBrainstormingBrief(topic);
  const prompt = this.prompts.renderPrompt("brainstorming_ask_or_draft.md", { topic, brief });
  const result = await this.runAgent(designCouncilConfig.lead_agent, lead, prompt);
  if (!result.ok) {
    this.errorCount++;
    this.emitEvent(events.EVENTS.COORDINATOR_ERROR, {
      turn: null,
      message: result.error || "brainstorming ask_or_draft failed",
      recoverable: true,
      action: "retry",
      details: {},
    });
    return { waiting: false, error: true };
  }

  const parsed = require("./design-council").parseAskOrDraft(result.text);
  if (!parsed.ok) {
    this.errorCount++;
    this.emitEvent(events.EVENTS.COORDINATOR_ERROR, {
      turn: null,
      message: parsed.error,
      recoverable: true,
      action: "retry",
      details: { raw: String(result.text || "").slice(0, 500) },
    });
    return { waiting: false, error: true };
  }

  if (parsed.value.decision === "ask_user") {
    const questionSeq = this.nextQuestionSeq();
    this.emitEvent(events.EVENTS.BRAINSTORMING_QUESTION_CREATED, {
      question_seq: questionSeq,
      agent: designCouncilConfig.lead_agent,
      question: parsed.value.question,
      reason: parsed.value.reason,
      known_context: parsed.value.known_context,
      missing_context: parsed.value.missing_context,
    });
    return { waiting: true };
  }

  return { waiting: false, draft: true };
}
```

实现 `buildBrainstormingBrief()` 和 `nextQuestionSeq()`：

```js
buildBrainstormingBrief(topic) {
  const parts = [`Topic: ${topic}`];
  const questions = new Map(
    this.eventLog
      .filter((e) => e.type === events.EVENTS.BRAINSTORMING_QUESTION_CREATED)
      .map((e) => [e.question_seq, e])
  );
  const answers = this.eventLog.filter((e) => e.type === events.EVENTS.BRAINSTORMING_ANSWER_RECEIVED);
  for (const answer of answers) {
    const question = questions.get(answer.question_seq);
    parts.push(`Q${answer.question_seq}: ${question?.question || "(question unavailable)"}\nAnswer: ${answer.content}`);
  }
  return clipText(parts.join("\n\n"), 3000);
}

nextQuestionSeq() {
  const seen = this.eventLog.filter((e) => e.type === events.EVENTS.BRAINSTORMING_QUESTION_CREATED);
  return seen.length + 1;
}
```

- [ ] **Step 5: 实现 answer API 事件追加**

在 `CouncilEngine` 增加：

```js
addBrainstormingAnswer(content) {
  const text = String(content || "").trim();
  if (!text) return null;
  const latestQuestion = [...this.eventLog].reverse().find((e) => e.type === events.EVENTS.BRAINSTORMING_QUESTION_CREATED);
  if (!latestQuestion) return null;
  return this.emitEvent(events.EVENTS.BRAINSTORMING_ANSWER_RECEIVED, {
    question_seq: latestQuestion.question_seq,
    content: text,
  });
}

async resumeDesignCouncil(topic) {
  this.waitingForUser = false;
  const limits = this.resolveCouncilLimits();
  const designCouncilConfig = resolveDesignCouncilConfig(this.config, this.brainstormingConfig);
  const preludeResult = await this.runBrainstormingPrelude(topic, {}, limits, designCouncilConfig);
  if (preludeResult.waiting) {
    this.waitingForUser = true;
    return { outcome: "waiting_for_user", turnCount: this.turnCount, errorCount: this.errorCount };
  }
  return await this.runDiscussionLoop(topic);
}
```

在 `server.js` 的 controller 中保存 topic：

```js
const controller = {
  sessionId: session.id,
  sessionDir: session.dir,
  sessionStore,
  topic,
  engine: null,
  currentRun: null,
};
```

`setImmediate` 的 finally 不能无条件删除 waiting controller：

```js
} finally {
  if (!controller.engine?.waitingForUser) {
    activeSessions.delete(session.id);
  }
}
```

在 `server.js` 增加 answer 路由：

```js
const brainstormingAnswerMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/brainstorming\/answer$/);
if (brainstormingAnswerMatch && req.method === "POST") {
  const sessionId = decodeURIComponent(brainstormingAnswerMatch[1]);
  const controller = activeSessions.get(sessionId);
  if (!controller) {
    sendJson(res, 409, { error: "session is not waiting for brainstorming answer" });
    return true;
  }
  const body = await readJsonBody(req);
  const event = controller.engine.addBrainstormingAnswer(body.content);
  if (!event) {
    sendJson(res, 400, { error: "content is required" });
    return true;
  }
  controller.sessionStore.deriveState(controller.sessionDir);
  sendJson(res, 202, { event });
  setImmediate(async () => {
    try {
      await controller.engine.resumeDesignCouncil(controller.topic);
      controller.sessionStore.deriveState(controller.sessionDir);
      controller.sessionStore.generateTranscript(controller.sessionDir);
    } catch (err) {
      console.error(`[patchcouncil-ui] resume ${sessionId} error:`, err.message);
    } finally {
      if (!controller.engine?.waitingForUser) activeSessions.delete(sessionId);
    }
  });
  return true;
}
```

- [ ] **Step 6: 投影 waiting 状态**

在 `session-store.js` 的 `deriveState()` 中，`sessionFinished` 处理前增加：

```js
const latestQuestion = [...allEvents].reverse().find((e) => e.type === "brainstorming_question_created");
const latestAnswer = [...allEvents].reverse().find((e) => e.type === "brainstorming_answer_received");
const waitingForBrainstorming =
  latestQuestion && (!latestAnswer || latestAnswer.question_seq < latestQuestion.question_seq);
```

状态判断改为：

```js
if (waitingForBrainstorming) {
  status = "waiting_for_user";
} else if (sessionFinished) {
  ...
}
```

在 state 中增加：

```js
waiting_for: waitingForBrainstorming ? "brainstorming_answer" : null,
brainstorming: {
  question_count: allEvents.filter((e) => e.type === "brainstorming_question_created").length,
  lead_agent: allEvents.find((e) => e.type === "brainstorming_started")?.lead_agent || null,
},
```

- [ ] **Step 7: 运行验证**

Run:

```powershell
cd apps\patchcouncil-ui
npm run check
npm run smoke
```

Expected: PASS。

- [ ] **Step 8: Commit**

```powershell
git add apps\patchcouncil-ui\engine\skills\brainstorming-prelude\skill.yaml apps\patchcouncil-ui\engine\prompts\brainstorming_ask_or_draft.md apps\patchcouncil-ui\engine\council.js apps\patchcouncil-ui\server.js apps\patchcouncil-ui\engine\session-store.js apps\patchcouncil-ui\scripts\council-smoke.js
git commit -m "feat: add brainstorming prelude"
```

## Task 4：Design draft 写文件和 draft commit

**Files:**
- Create: `apps/patchcouncil-ui/engine/prompts/design_draft.md`
- Modify: `apps/patchcouncil-ui/engine/design-council.js`
- Modify: `apps/patchcouncil-ui/engine/council.js`
- Modify: `apps/patchcouncil-ui/engine/session-store.js`
- Modify: `apps/patchcouncil-ui/scripts/council-smoke.js`

- [ ] **Step 1: 写 design draft + commit 失败测试**

在 `council-smoke.js` 增加可注入 git runner：

```js
async function runEngine(config, scenarios, options = {}) {
  ...
  const engine = new CouncilEngine({
    ...
    runGit: options.runGit,
  });
  ...
}
```

新增测试：

```js
async function testDesignDraftWritesFileAndCommits() {
  setupTest("design draft writes file and commits");

  const config = JSON.parse(JSON.stringify(MINIMAL_CONFIG));
  config.design_council = { lead_agent: "codex", max_questions: 8 };

  const gitCalls = [];
  const { events } = await runEngine(config, [
    {
      match: (p) => p.includes("一次只问一个问题"),
      response: { ok: true, text: JSON.stringify({ decision: "draft_design", reason: "信息足够。", known_context: [], missing_context: [] }) },
    },
    {
      match: (p) => p.includes("Markdown design doc"),
      response: { ok: true, text: "# Test Design\n\n## Goal\n\nBuild it.\n" },
    },
  ], {
    mode: "design_council",
    runGit: async (args) => {
      gitCalls.push(args);
      if (args[0] === "rev-parse") return { ok: true, text: "abc1234\n" };
      return { ok: true, text: "" };
    },
  });

  const fileEvent = events.find((e) => e.type === EVENTS.DESIGN_FILE_WRITTEN);
  assert.ok(fileEvent);
  assert.equal(fileEvent.revision, 0);
  assert.ok(fs.existsSync(fileEvent.artifact_path));
  assert.match(fs.readFileSync(fileEvent.artifact_path, "utf8"), /# Test Design/);

  const commitEvent = events.find((e) => e.type === EVENTS.DESIGN_COMMIT_CREATED);
  assert.equal(commitEvent.commit, "abc1234");
  assert.ok(gitCalls.some((args) => args[0] === "add" && args[1] === fileEvent.artifact_path));
  assert.ok(gitCalls.some((args) => args[0] === "commit"));

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

Expected: FAIL，`DESIGN_FILE_WRITTEN` 未生成。

- [ ] **Step 3: 创建 design draft prompt**

创建 `apps/patchcouncil-ui/engine/prompts/design_draft.md`：

```markdown
You are writing a Markdown design doc for PatchCouncil.

Topic:
{{topic}}

Brainstorming context:
{{brief}}

Draft decision context:
{{draft_context}}

Write only the design document in Markdown. Do not include an implementation plan.

Required sections:
- Goal
- Non-goals
- Context / assumptions
- Proposed design
- Event / state changes
- UI / API behavior
- Error handling
- Testing strategy
- Open questions
```

- [ ] **Step 4: 实现 git runner 和 commit helper**

在 `design-council.js` 增加：

```js
const { spawn } = require("child_process");

function runGitCommand(projectRoot, args) {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd: projectRoot, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ ok: code === 0, text: stdout, error: stderr || `git exited ${code}` }));
  });
}

async function commitDesignArtifact(options) {
  const { artifactPath, projectRoot, message, runGit = (args) => runGitCommand(projectRoot, args) } = options;
  const add = await runGit(["add", artifactPath]);
  if (!add.ok) return { ok: false, stage: "add", error: add.error || add.text };
  const commit = await runGit(["commit", "-m", message]);
  if (!commit.ok) return { ok: false, stage: "commit", error: commit.error || commit.text };
  const rev = await runGit(["rev-parse", "--short", "HEAD"]);
  if (!rev.ok) return { ok: false, stage: "rev-parse", error: rev.error || rev.text };
  return { ok: true, commit: String(rev.text || "").trim() };
}
```

导出 `commitDesignArtifact` 和 `runGitCommand`。

- [ ] **Step 5: 实现 draft 写入和 commit 事件**

在 `CouncilEngine` constructor 保存：

```js
this.runGit = options.runGit;
```

在 `runBrainstormingPrelude()` 的 `draft_design` 分支调用：

```js
await this.createDesignDraft(topic, designCouncilConfig, parsed.value);
return { waiting: false, draft: true };
```

新增方法：

```js
async createDesignDraft(topic, designCouncilConfig, draftDecision) {
  const design = require("./design-council");
  const artifactPath = design.buildDesignArtifactPath(this.projectRoot, topic);
  const brief = this.buildBrainstormingBrief(topic);
  const draftContext = [
    `Reason: ${draftDecision?.reason || ""}`,
    `Known context: ${(draftDecision?.known_context || []).join("; ")}`,
    `Missing context: ${(draftDecision?.missing_context || []).join("; ")}`,
  ].join("\n");
  const prompt = this.prompts.renderPrompt("design_draft.md", { topic, brief, draft_context: draftContext });
  const agents = availableAgents(this.config.agents);
  const result = await this.runAgent(designCouncilConfig.lead_agent, agents[designCouncilConfig.lead_agent], prompt);
  if (!result.ok) throw new Error(result.error || "design draft failed");

  design.ensureDesignDirectory(artifactPath);
  fs.writeFileSync(artifactPath, String(result.text || "").trim() + "\n", "utf8");
  this.emitEvent(events.EVENTS.DESIGN_FILE_WRITTEN, {
    artifact_path: artifactPath,
    generator: designCouncilConfig.lead_agent,
    title: topic,
    revision: 0,
  });

  const message = `docs: draft ${design.slugifyDesignTopic(topic)} design`;
  const committed = await design.commitDesignArtifact({
    artifactPath,
    projectRoot: this.projectRoot,
    message,
    runGit: this.runGit,
  });
  if (!committed.ok) {
    this.emitEvent(events.EVENTS.DESIGN_COMMIT_FAILED, {
      artifact_path: artifactPath,
      revision: 0,
      stage: committed.stage,
      error: committed.error,
    });
    return { ok: false };
  }
  this.emitEvent(events.EVENTS.DESIGN_COMMIT_CREATED, {
    artifact_path: artifactPath,
    commit: committed.commit,
    commit_message: message,
  });
  return { ok: true, artifactPath, commit: committed.commit };
}
```

在文件顶部引入：

```js
const fs = require("fs");
```

- [ ] **Step 6: 投影 design 状态**

在 `session-store.js` 里计算 latest design events：

```js
const designFile = [...allEvents].reverse().find((e) => e.type === "design_file_written" || e.type === "design_revision_written");
const draftCommit = allEvents.find((e) => e.type === "design_commit_created");
const latestCommitEvent = [...allEvents].reverse().find((e) => e.type === "design_revision_committed" || e.type === "design_commit_created");
const latestCommitFailed = [...allEvents].reverse().find((e) => e.type === "design_commit_failed");
```

state 增加：

```js
design: {
  artifact_path: designFile?.artifact_path || null,
  draft_commit: draftCommit?.commit || null,
  latest_commit: latestCommitEvent?.commit || null,
  status: latestCommitEvent ? (latestCommitEvent.type === "design_revision_committed" ? "revision_committed" : "draft_committed")
    : latestCommitFailed ? "commit_failed"
    : designFile ? (designFile.type === "design_revision_written" ? "revision_written" : "file_written")
    : "none",
},
```

- [ ] **Step 7: 运行验证**

Run:

```powershell
cd apps\patchcouncil-ui
npm run check
npm run smoke
```

Expected: PASS。

- [ ] **Step 8: Commit**

```powershell
git add apps\patchcouncil-ui\engine\prompts\design_draft.md apps\patchcouncil-ui\engine\design-council.js apps\patchcouncil-ui\engine\council.js apps\patchcouncil-ui\engine\session-store.js apps\patchcouncil-ui\scripts\council-smoke.js
git commit -m "feat: commit design council draft"
```

## Task 5：进入现有 council loop 并注入 design brief

**Files:**
- Modify: `apps/patchcouncil-ui/engine/council.js`
- Modify: `apps/patchcouncil-ui/engine/prompts/council_route.md`
- Modify: `apps/patchcouncil-ui/engine/prompts/council_decide.md`
- Modify: `apps/patchcouncil-ui/scripts/council-smoke.js`

- [ ] **Step 1: 写 phase transition 和 design brief 测试**

在 `council-smoke.js` 增加：

```js
async function testDesignCouncilTransitionsToDiscussion() {
  setupTest("design council transitions to discussion");

  const config = JSON.parse(JSON.stringify(MINIMAL_CONFIG));
  config.design_council = { lead_agent: "codex", max_questions: 8 };
  config.council.min_distinct_agents = 1;
  config.council.max_turns = 1;

  let sawDesignReviewBrief = false;
  const { events, result } = await runEngine(config, [
    { match: (p) => p.includes("一次只问一个问题"), response: { ok: true, text: JSON.stringify({ decision: "draft_design", reason: "ok", known_context: [], missing_context: [] }) } },
    { match: (p) => p.includes("Markdown design doc"), response: { ok: true, text: "# Test Design\n\n## Goal\n\nBuild it.\n" } },
    {
      match: isRoutePrompt,
      response: (prompt) => {
        sawDesignReviewBrief = prompt.includes("Design artifact") && prompt.includes("abc1234");
        return { ok: true, text: JSON.stringify({ decision: "continue", next_agent: "claude", role: "reviewer", reason: "review design" }) };
      },
    },
    { match: isAgentTurnPrompt, response: { ok: true, text: JSON.stringify({ stance: "agree", confidence: "high", finalize_readiness: "ready", blockers: [], agreements: ["Design is reviewable."], disagreements: [], recommended_next_step: "finalize", analysis: "Review complete." }) } },
    { match: isDecidePrompt, response: { ok: true, text: JSON.stringify({ decision: "finalize", next_agent: null, role: null, reason: "done" }) } },
    { match: isFinalizePrompt, response: { ok: true, text: JSON.stringify({ consensus: "Design reviewed.", disagreements: "none", recommended_next_step: "generate workplan", needs_confirmation: false, next_steps: ["generate workplan"] }) } },
  ], {
    mode: "design_council",
    runGit: async (args) => args[0] === "rev-parse" ? { ok: true, text: "abc1234\n" } : { ok: true, text: "" },
  });

  assert.ok(events.some((e) => e.type === EVENTS.PHASE_TRANSITION && e.from === "brainstorming" && e.to === "discussion"));
  assert.equal(sawDesignReviewBrief, true);
  assert.equal(result.outcome, "discussion_only");

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

Expected: FAIL，draft 后没有 transition 或 brief 没有 design commit。

- [ ] **Step 3: draft commit 后切 phase**

在 `runBrainstormingPrelude()` draft 成功后：

```js
this.emitEvent(events.EVENTS.PHASE_TRANSITION, {
  from: "brainstorming",
  to: "discussion",
  trigger: "design_commit_created",
  reason: "Design draft committed; entering council review.",
});
this.phase = "discussion";
```

确保后续继续走现有 while loop，而不是提前 finish。

- [ ] **Step 4: buildBrief 按现有结构注入 design summary**

当前 `buildBrief(topic, context, limits, log)` 返回 `{ context, transcript, topic }`，内部使用 `recentMessages`，没有 `sections` 数组。按现有结构修改：在 `const clippedTranscript = ...` 之前增加 design block，并把它 unshift 到 `recentMessages`。

```js
const latestDesign = [...log].reverse().find((e) => e.type === events.EVENTS.DESIGN_REVISION_COMMITTED || e.type === events.EVENTS.DESIGN_COMMIT_CREATED);
const latestFile = [...log].reverse().find((e) => e.type === events.EVENTS.DESIGN_REVISION_WRITTEN || e.type === events.EVENTS.DESIGN_FILE_WRITTEN);
if (this.mode === "design_council" && latestFile) {
  let designSummary = "";
  try {
    const designText = fs.readFileSync(latestFile.artifact_path, "utf8");
    designSummary = require("./design-council").summarizeDesignForBrief(designText, this.config.council?.max_design_brief_chars || 1800);
  } catch (_) {
    designSummary = "Design file could not be read; use artifact path.";
  }
  recentMessages.unshift([
    "### Design artifact",
    `Path: ${latestFile.artifact_path}`,
    `Commit: ${latestDesign?.commit || "none"}`,
    "",
    designSummary,
    "",
    "Council task: review, challenge, and constructively improve the design document. Do not generate an implementation plan.",
  ].join("\n"));
}
```

- [ ] **Step 5: prompt 补强 reviewer 任务**

在 `council_route.md` 和 `council_decide.md` 中加入：

```markdown
If the brief says this is a design council, route reviewers to review / challenge / constructively improve the design document. Do not restart requirements elicitation unless a blocker requires user input. Do not generate an implementation plan.
```

- [ ] **Step 6: 运行验证**

Run:

```powershell
cd apps\patchcouncil-ui
npm run check
npm run smoke
```

Expected: PASS。

- [ ] **Step 7: Commit**

```powershell
git add apps\patchcouncil-ui\engine\council.js apps\patchcouncil-ui\engine\prompts\council_route.md apps\patchcouncil-ui\engine\prompts\council_decide.md apps\patchcouncil-ui\scripts\council-smoke.js
git commit -m "feat: review committed design in council loop"
```

## Task 6：Design revision 和 final commit

**Files:**
- Create: `apps/patchcouncil-ui/engine/prompts/design_revision.md`
- Modify: `apps/patchcouncil-ui/engine/council.js`
- Modify: `apps/patchcouncil-ui/scripts/council-smoke.js`

- [ ] **Step 1: 写 revision commit 失败测试**

在 `council-smoke.js` 增加：

```js
async function testDesignRevisionCommittedAfterReview() {
  setupTest("design revision committed after review");

  const config = JSON.parse(JSON.stringify(MINIMAL_CONFIG));
  config.design_council = { lead_agent: "codex", max_questions: 8 };
  config.council.min_distinct_agents = 1;
  config.council.max_turns = 1;

  let revParseCount = 0;
  const { events } = await runEngine(config, [
    { match: (p) => p.includes("一次只问一个问题"), response: { ok: true, text: JSON.stringify({ decision: "draft_design", reason: "ok", known_context: [], missing_context: [] }) } },
    { match: (p) => p.includes("Markdown design doc"), response: { ok: true, text: "# Test Design\n\n## Goal\n\nBuild it.\n" } },
    { match: isRoutePrompt, response: { ok: true, text: JSON.stringify({ decision: "continue", next_agent: "claude", role: "reviewer", reason: "review" }) } },
    { match: isAgentTurnPrompt, response: { ok: true, text: JSON.stringify({ stance: "mixed", confidence: "high", finalize_readiness: "not_ready", blockers: [{ type: "issue", text: "Need explicit API behavior." }], agreements: [], disagreements: ["API behavior missing."], recommended_next_step: "revise design", analysis: "The design needs explicit API behavior." }) } },
    { match: (p) => p.includes("Revise the Markdown design doc"), response: { ok: true, text: "# Test Design\n\n## Goal\n\nBuild it.\n\n## API behavior\n\nUse /brainstorming/answer.\n" } },
    { match: isDecidePrompt, response: { ok: true, text: JSON.stringify({ decision: "finalize", next_agent: null, role: null, reason: "revision done" }) } },
    { match: isFinalizePrompt, response: { ok: true, text: JSON.stringify({ consensus: "Design revised.", disagreements: "none", recommended_next_step: "generate workplan", needs_confirmation: false, next_steps: ["generate workplan"] }) } },
  ], {
    mode: "design_council",
    runGit: async (args) => {
      if (args[0] === "rev-parse") {
        revParseCount++;
        return { ok: true, text: revParseCount === 1 ? "abc1234\n" : "def5678\n" };
      }
      return { ok: true, text: "" };
    },
  });

  assert.ok(events.some((e) => e.type === EVENTS.DESIGN_REVISION_WRITTEN));
  const committed = events.find((e) => e.type === EVENTS.DESIGN_REVISION_COMMITTED);
  assert.equal(committed.source_commit, "abc1234");
  assert.equal(committed.commit, "def5678");

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

Expected: FAIL，没有 revision 事件。

- [ ] **Step 3: 创建 revision prompt**

创建 `apps/patchcouncil-ui/engine/prompts/design_revision.md`：

```markdown
Revise the Markdown design doc using reviewer findings.

Current design:
{{design}}

Reviewer findings:
{{findings}}

Rules:
- Return the full revised Markdown document.
- Preserve accurate existing decisions.
- Incorporate blockers, disagreements, and constructive additions when they improve the design.
- Do not generate an implementation plan.
- Do not write code.
```

- [ ] **Step 4: 实现 revision hook**

在 `CouncilEngine.run()` 中，每次 `runAgentTurn()` 后，如果 `this.mode === "design_council"` 且 signal 有 blocker 或 `recommended_next_step` 包含 `revise`，调用：

```js
await this.reviseDesignFromLatestReview(topic, agentResult.event);
```

这个改动和 `runAgentTurn()` 返回值扩展必须在同一个 commit 完成，避免出现调用方期望 event、但函数仍返回 `undefined` 的中间状态。

`runAgentTurn()` 返回值扩展为：

```js
return { ok: true, event };
```

新增方法：

```js
async reviseDesignFromLatestReview(topic, reviewEvent) {
  const design = require("./design-council");
  const latestFile = [...this.eventLog].reverse().find((e) => e.type === events.EVENTS.DESIGN_FILE_WRITTEN || e.type === events.EVENTS.DESIGN_REVISION_WRITTEN);
  const latestCommit = [...this.eventLog].reverse().find((e) => e.type === events.EVENTS.DESIGN_REVISION_COMMITTED || e.type === events.EVENTS.DESIGN_COMMIT_CREATED);
  if (!latestFile || !latestCommit) return null;

  const dc = resolveDesignCouncilConfig(this.config, this.brainstormingConfig);
  const agents = availableAgents(this.config.agents);
  const currentDesign = fs.readFileSync(latestFile.artifact_path, "utf8");
  const findings = [
    reviewEvent.content || "",
    reviewEvent.signal ? JSON.stringify(reviewEvent.signal, null, 2) : "",
  ].filter(Boolean).join("\n\n");
  const prompt = this.prompts.renderPrompt("design_revision.md", { design: currentDesign, findings });
  const result = await this.runAgent(dc.lead_agent, agents[dc.lead_agent], prompt);
  if (!result.ok) return null;

  fs.writeFileSync(latestFile.artifact_path, String(result.text || "").trim() + "\n", "utf8");
  this.emitEvent(events.EVENTS.DESIGN_REVISION_WRITTEN, {
    artifact_path: latestFile.artifact_path,
    source_commit: latestCommit.commit,
    source_review_seq: reviewEvent.seq,
    generator: dc.lead_agent,
    revision: this.nextDesignRevision(),
  });

  const message = `docs: revise ${design.slugifyDesignTopic(topic)} design`;
  const committed = await design.commitDesignArtifact({ artifactPath: latestFile.artifact_path, projectRoot: this.projectRoot, message, runGit: this.runGit });
  if (!committed.ok) {
    this.emitEvent(events.EVENTS.DESIGN_COMMIT_FAILED, {
      artifact_path: latestFile.artifact_path,
      revision: this.nextDesignRevision(),
      stage: committed.stage,
      error: committed.error,
    });
    return null;
  }
  this.emitEvent(events.EVENTS.DESIGN_REVISION_COMMITTED, {
    artifact_path: latestFile.artifact_path,
    source_commit: latestCommit.commit,
    commit: committed.commit,
    commit_message: message,
  });
  return committed.commit;
}
```

新增：

```js
nextDesignRevision() {
  return this.eventLog.filter((e) => e.type === events.EVENTS.DESIGN_REVISION_WRITTEN).length + 1;
}
```

- [ ] **Step 5: 运行验证**

Run:

```powershell
cd apps\patchcouncil-ui
npm run check
npm run smoke
```

Expected: PASS。

- [ ] **Step 6: Commit**

```powershell
git add apps\patchcouncil-ui\engine\prompts\design_revision.md apps\patchcouncil-ui\engine\council.js apps\patchcouncil-ui\scripts\council-smoke.js
git commit -m "feat: revise reviewed design document"
```

## Task 7：Workbench UI 和 transcript 投影

**Files:**
- Modify: `apps/patchcouncil-ui/public/app.js`
- Modify: `apps/patchcouncil-ui/engine/session-store.js`
- Modify: `apps/patchcouncil-ui/scripts/generate-mock-session.js`
- Modify: `apps/patchcouncil-ui/scripts/smoke-test.js`

- [ ] **Step 1: 写 transcript 渲染测试**

在 `council-smoke.js` 或 `smoke-test.js` 中新增一个 session-store 测试，写入以下事件后调用 `generateTranscript()`：

```js
store.appendEvent(session.dir, eventBuilders.brainstormingQuestionCreated(session.id, 0, "brainstorming", 1, "codex", "主要使用者是谁？", "reason", [], []));
store.appendEvent(session.dir, eventBuilders.brainstormingAnswerReceived(session.id, 1, "brainstorming", 1, "项目 owner"));
store.appendEvent(session.dir, eventBuilders.designFileWritten(session.id, 2, "brainstorming", path.join(testDir, "docs", "designs", "x.md"), "codex", "X", 0));
store.appendEvent(session.dir, eventBuilders.designCommitCreated(session.id, 3, "brainstorming", path.join(testDir, "docs", "designs", "x.md"), "abc1234", "docs: draft x design"));
store.generateTranscript(session.dir);
const transcript = fs.readFileSync(path.join(session.dir, "transcript.md"), "utf8");
assert.match(transcript, /Brainstorming Question/);
assert.match(transcript, /Design commit/);
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```powershell
cd apps\patchcouncil-ui
npm run smoke
```

Expected: FAIL，transcript 不包含新事件。

- [ ] **Step 3: session-store transcript 增加新事件**

在 `generateTranscript()` switch 中增加：

```js
case "brainstorming_question_created":
  lines.push(`## Brainstorming Question ${event.question_seq} (${event.agent})`);
  lines.push("");
  lines.push(event.question);
  lines.push("");
  if (event.reason) lines.push(`**Reason:** ${event.reason}`);
  lines.push("");
  break;

case "brainstorming_answer_received":
  lines.push(`## Host Answer ${event.question_seq}`);
  lines.push("");
  lines.push(event.content);
  lines.push("");
  break;

case "design_file_written":
case "design_revision_written":
  lines.push(`## Design file written`);
  lines.push("");
  lines.push(`**Path:** ${event.artifact_path}`);
  lines.push(`**Revision:** ${event.revision}`);
  lines.push("");
  break;

case "design_commit_created":
case "design_revision_committed":
  lines.push(`## Design commit`);
  lines.push("");
  lines.push(`**Commit:** ${event.commit}`);
  lines.push(`**Path:** ${event.artifact_path}`);
  lines.push("");
  break;
```

- [ ] **Step 4: UI 展示新事件**

在 `public/app.js` 的事件渲染分支中增加：

```js
if (event.type === "brainstorming_question_created") {
  return renderMessage("agent", event.agent || "codex", event.question, { meta: `Question ${event.question_seq}` });
}
if (event.type === "brainstorming_answer_received") {
  return renderMessage("host", "Host", event.content, { meta: `Answer ${event.question_seq}` });
}
if (event.type === "design_file_written" || event.type === "design_revision_written") {
  return renderSystemCard("Design file", `${event.artifact_path}\nrevision ${event.revision}`);
}
if (event.type === "design_commit_created" || event.type === "design_revision_committed") {
  return renderSystemCard("Design commit", `${event.commit}\n${event.commit_message || ""}`);
}
```

使用现有 message/card helper；如果当前文件没有 `renderSystemCard`，用现有系统事件渲染函数扩展，不新增独立 UI 框架。

- [ ] **Step 5: composer waiting 状态提交 answer API**

在 submit handler 判断：

```js
if (currentSession?.status === "waiting_for_user" && currentSession?.waiting_for === "brainstorming_answer") {
  await fetch(`/api/sessions/${encodeURIComponent(currentSession.session_id)}/brainstorming/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: text }),
  });
  input.value = "";
  await refreshCurrentSession();
  return;
}
```

- [ ] **Step 6: 更新 mock session**

在 `generate-mock-session.js` 中追加一组 brainstorming/design events，让 Workbench 默认能看到新 UI。

- [ ] **Step 7: 运行验证**

Run:

```powershell
cd apps\patchcouncil-ui
npm run check
npm run smoke
```

Expected: PASS。

- [ ] **Step 8: Commit**

```powershell
git add apps\patchcouncil-ui\public\app.js apps\patchcouncil-ui\engine\session-store.js apps\patchcouncil-ui\scripts\generate-mock-session.js apps\patchcouncil-ui\scripts\smoke-test.js
git commit -m "feat: show design council workflow in workbench"
```

## Task 8：Workplan 集成和文档

**Files:**
- Modify: `apps/patchcouncil-ui/engine/workplan.js`
- Modify: `apps/patchcouncil-ui/scripts/council-smoke.js`
- Modify: `docs/COUNCIL_EVENTS.md`
- Modify: `docs/AI_CONTEXT.md`
- Modify: `docs/ARCHITECTURE.md`

- [ ] **Step 1: 写 workplan guard 失败测试**

在 `council-smoke.js` 增加：

```js
async function testDesignCouncilWorkplanRequiresDesignCommit() {
  setupTest("design council workplan requires design commit");

  const store = new SessionStore(testDir);
  const session = store.createSession("design without commit");
  store.appendEvent(session.dir, {
    schema_version: 1,
    seq: 0,
    type: EVENTS.SESSION_STARTED,
    phase: "brainstorming",
    session_id: session.id,
    started_at: new Date().toISOString(),
    topic: "x",
    mode: "design_council",
    config: {},
  });
  store.appendEvent(session.dir, {
    schema_version: 1,
    seq: 1,
    type: EVENTS.SESSION_FINISHED,
    phase: "finalized",
    session_id: session.id,
    finished_at: new Date().toISOString(),
    outcome: "discussion_only",
    duration_ms: 1,
    turn_count: 0,
    distinct_agents: [],
    error_count: 0,
  });

  const result = await generateWorkplanForSession({
    config: MINIMAL_CONFIG,
    sessionStore: store,
    sessionDir: session.dir,
    sessionId: session.id,
    prompts,
    runAgent: async () => ({ ok: true, text: "{}" }),
    onEvent: (event) => store.appendEvent(session.dir, event),
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.match(result.error, /design commit/i);

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

Expected: FAIL，workplan 没有拒绝无 design commit 的 design council session。

- [ ] **Step 3: workplan brief 使用 design commit**

在 `workplan.js` 增加：

```js
function latestDesignCommit(allEvents) {
  return [...allEvents].reverse().find((e) => e.type === "design_revision_committed" || e.type === "design_commit_created");
}

function latestDesignFile(allEvents) {
  return [...allEvents].reverse().find((e) => e.type === "design_revision_written" || e.type === "design_file_written");
}
```

在 `generateWorkplanForSession()` 读取 `started` 后增加：

```js
if (started?.mode === "design_council" && !latestDesignCommit(allEvents)) {
  return { ok: false, error: "design council workplan requires a design commit", status: 409 };
}
```

在 `buildWorkplanBrief()` 中加入：

```js
const designCommit = latestDesignCommit(allEvents);
const designFile = latestDesignFile(allEvents);
if (started?.mode === "design_council" && designCommit && designFile) {
  sections.push(`## Design Source\n\nPath: ${designFile.artifact_path}\nCommit: ${designCommit.commit}`);
  try {
    const fs = require("fs");
    sections.push(`## Design Document\n\n${clipText(fs.readFileSync(designFile.artifact_path, "utf8"), limits.maxMessageChars)}`);
  } catch (_) {
    sections.push("Design document could not be read; use path and commit above.");
  }
}
```

- [ ] **Step 4: 更新事件文档**

在 `docs/COUNCIL_EVENTS.md` 增加：

```markdown
### brainstorming_question_created

Uses `question_seq`, not `turn`, to avoid confusion with council discussion turns.

### design_file_written / design_commit_created

`design_file_written` records that the artifact was written. `design_commit_created` records that git commit succeeded. Commit failures use `design_commit_failed`.
```

在 `docs/AI_CONTEXT.md` 和 `docs/ARCHITECTURE.md` 简短记录：

```markdown
`mode=design_council` starts with a single-agent brainstorming prelude, writes `docs/designs/...md`, commits it, then reuses the existing council loop for review.
```

- [ ] **Step 5: 运行最终验证**

Run:

```powershell
cd apps\patchcouncil-ui
npm run check
npm run smoke
```

Expected: PASS。

- [ ] **Step 6: Commit**

```powershell
git add apps\patchcouncil-ui\engine\workplan.js apps\patchcouncil-ui\scripts\council-smoke.js docs\COUNCIL_EVENTS.md docs\AI_CONTEXT.md docs\ARCHITECTURE.md
git commit -m "feat: base workplans on committed design"
```

## Final Verification

- [ ] **Step 1: 全量检查**

Run:

```powershell
cd apps\patchcouncil-ui
npm run check
npm run smoke
```

Expected: PASS。

- [ ] **Step 2: 手动 UI smoke**

Run:

```powershell
cd apps\patchcouncil-ui
$env:PATCHCOUNCIL_FAKE_RUNTIME="1"
npm start
```

Open:

```text
http://127.0.0.1:8765
```

Verify:

- 创建 `mode=design_council` session。
- 第一条显示 Codex brainstorming question，或 fake runtime 直接生成 design。
- waiting 状态下 composer 提交 answer。
- design artifact 和 commit hash 在 timeline 可见。
- phase 进入 discussion 后仍显示普通 council turn。
- done 后 workplan 按钮可用；无 design commit 的 session 返回 409。

- [ ] **Step 3: 自检 git 状态**

Run:

```powershell
git status --short
```

Expected: 只剩用户明确保留的未跟踪/未提交文件；实现相关文件都已在对应 commit 中。

## 风险和处理

- Git commit 在测试环境里可能没有 user.name/user.email：engine 测试通过注入 `runGit` 避免依赖真实 git；真实 smoke 只验证路径，不强制生成真实 design commit。
- `waiting_for_user` session 会让 server 暂时保留 active controller；如果后续需要跨进程恢复，再把 resume 改成基于 sessionDir 重建 engine。
- reviewer 读取完整 design 的能力依赖 runtime cwd 和 prompt 指示：v1 brief 同时包含 path、commit 和摘要，降低无法读文件时的失败概率。
- revision 触发规则可能过于积极：v1 只在 blocker 或 `recommended_next_step` 明确包含 `revise` 时触发，避免每个 review 都改文档。

## 自检

- Spec coverage：本计划覆盖 brainstorming prelude、question_seq、agent 可用性检查、design file/commit 拆分、docs/designs 目录、council review、revision commit、workplan guard、UI/transcript/docs。
- Placeholder scan：本文没有未填充的占位项。
- Type consistency：事件名使用 `brainstorming_question_created`、`brainstorming_answer_received`、`design_file_written`、`design_commit_created`、`design_commit_failed`、`design_revision_written`、`design_revision_committed`；question 字段统一使用 `question_seq`。
