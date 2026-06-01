# Workplan v1 实现计划

> **给 agentic workers：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 按任务逐步执行本计划。步骤使用 checkbox（`- [ ]`）语法追踪进度。

**目标：** 为已完成的 PatchCouncil session 增加按需生成、只读、结构化 workplan 的能力。

**架构：** Workplan 是 discussion 完成后的派生产物，继续追加到同一个 `transcript.jsonl`。实现复用现有 Node server、`SessionStore`、prompt renderer、runtime adapter、fake runtime smoke 路径和 Workbench 轮询 UI。一个 `done` session 可以有多次失败生成记录，但最多只能有一个成功的 `workplan_created`。

**技术栈：** Node.js CommonJS、内置 `http`、vanilla JS/CSS、JSONL event log、现有 `CouncilEngine` helper、`npm run check`、`npm run smoke`、`npm run runtime:fake`。

---

## 规格来源

实现以下设计：

```text
docs/superpowers/specs/2026-06-01-workplan-v1-design.md
```

固定规则：

- 只允许 `status=done` 的 session 生成 workplan。
- `running`、`cancelling`、`cancelled`、`error`、不可读 session 返回 `409` 或 `404`。
- 同一个 session 可以有多个 `workplan_generation_failed`，但最多一个 `workplan_created`。
- `state.outcome` 始终保持 `session_finished.outcome`，workplan 状态只通过 `has_workplan` 和 `workplan_status` 表达。
- Workplan 生成不执行命令、不修改项目文件、不进入 `task_assignment` 或 `execution` phase、不编辑已有 discussion 事件。

## 文件边界

- 修改 `apps/patchcouncil-ui/engine/events.js`
  - 增加 workplan 事件常量和构造函数。
- 修改 `apps/patchcouncil-ui/engine/session-store.js`
  - 派生 `has_workplan` / `workplan_status`。
  - 渲染 workplan 事件到 `transcript.md`。
  - Continue/Fork 的 source metadata 包含 workplan 摘要。
- 新增 `apps/patchcouncil-ui/engine/workplan.js`
  - 构建 Workplan Brief。
  - 解析和校验严格 JSON。
  - 调用 configured coordinator 生成 workplan 事件。
- 新增 `apps/patchcouncil-ui/engine/prompts/workplan_create.md`
  - 定义把 finalized discussion 翻译成实施计划的 prompt。
- 修改 `apps/patchcouncil-ui/engine/event-sink.js`
  - CLI/debug 输出识别 workplan 事件。
- 修改 `apps/patchcouncil-ui/server.js`
  - 新增 `POST /api/sessions/:id/workplan`。
  - 维护进程内 workplan 生成 registry。
- 修改 `apps/patchcouncil-ui/public/app.js`
  - 渲染 Workplan 卡片、生成按钮、生成中和失败状态。
- 修改 `apps/patchcouncil-ui/public/styles.css`
  - 增加 Workplan 卡片样式。
- 修改 `apps/patchcouncil-ui/scripts/council-smoke.js`
  - 覆盖事件、状态、brief、parser、validator、生成服务。
- 修改 `apps/patchcouncil-ui/scripts/smoke-test.js`
  - 覆盖 HTTP API 和 UI 静态入口。
- 修改 `apps/patchcouncil-ui/package.json`
  - 把 `engine/workplan.js` 加入 `npm run check`。
- 修改 `docs/COUNCIL_EVENTS.md`、`docs/ROADMAP.md`、`apps/patchcouncil-ui/README.md`、`README.md`
  - 记录新事件、API 和路线图状态。

## 任务 1：Workplan 事件和状态派生

**文件：**
- 修改：`apps/patchcouncil-ui/engine/events.js`
- 修改：`apps/patchcouncil-ui/engine/session-store.js`
- 修改：`apps/patchcouncil-ui/engine/event-sink.js`
- 测试：`apps/patchcouncil-ui/scripts/council-smoke.js`

- [ ] **步骤 1：写事件常量失败测试**

在 `apps/patchcouncil-ui/scripts/council-smoke.js` 增加：

```js
async function testWorkplanEventConstants() {
  setupTest("workplan event constants");

  assert.equal(EVENTS.WORKPLAN_GENERATION_STARTED, "workplan_generation_started");
  assert.equal(EVENTS.WORKPLAN_CREATED, "workplan_created");
  assert.equal(EVENTS.WORKPLAN_GENERATION_FAILED, "workplan_generation_failed");

  teardownTest();
  pass();
}
```

在 `main()` 中调用：

```js
await testWorkbenchEventConstants();
await testWorkplanEventConstants();
await testWorkbenchStateAndTranscriptEvents();
```

- [ ] **步骤 2：运行测试确认失败**

```powershell
cd apps\patchcouncil-ui
npm run smoke
```

预期：`workplan event constants` 失败，因为常量尚未定义。

- [ ] **步骤 3：增加事件常量和构造函数**

在 `apps/patchcouncil-ui/engine/events.js` 的 `EVENTS` 中加入：

```js
WORKPLAN_GENERATION_STARTED: "workplan_generation_started",
WORKPLAN_CREATED: "workplan_created",
WORKPLAN_GENERATION_FAILED: "workplan_generation_failed",
```

增加构造函数：

```js
function workplanGenerationStarted(sessionId, seq, phase, requestedAt, generator) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.WORKPLAN_GENERATION_STARTED, phase), {
    requested_at: requestedAt,
    generator,
  });
}

function workplanCreated(sessionId, seq, phase, createdAt, generator, source, workplan) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.WORKPLAN_CREATED, phase), {
    created_at: createdAt,
    generator,
    source: source || {},
    workplan,
  });
}

function workplanGenerationFailed(sessionId, seq, phase, failedAt, generator, message, recoverable, action, details) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.WORKPLAN_GENERATION_FAILED, phase), {
    failed_at: failedAt,
    generator,
    message,
    recoverable,
    action,
    details: details || {},
  });
}
```

导出：

```js
workplanGenerationStarted,
workplanCreated,
workplanGenerationFailed,
```

- [ ] **步骤 4：写状态和 transcript 失败测试**

在 `council-smoke.js` 增加：

```js
async function testWorkplanStateAndTranscriptEvents() {
  setupTest("workplan events derive state and transcript");

  const store = new SessionStore(testDir);
  const session = store.createSession("plan me");
  store.appendEvent(session.dir, {
    schema_version: 1,
    seq: 0,
    type: EVENTS.SESSION_STARTED,
    phase: "discussion",
    session_id: session.id,
    started_at: "2026-06-01T10:00:00+08:00",
    topic: "plan me",
    mode: "council",
    config: {},
    capabilities: {},
    agents: [],
  });
  store.appendEvent(session.dir, {
    schema_version: 1,
    seq: 1,
    type: EVENTS.SESSION_FINISHED,
    phase: "finalized",
    session_id: session.id,
    finished_at: "2026-06-01T10:01:00+08:00",
    outcome: "discussion_only",
    duration_ms: 60000,
    turn_count: 1,
    distinct_agents: ["codex"],
    error_count: 0,
  });
  store.appendEvent(session.dir, {
    schema_version: 1,
    seq: 2,
    type: EVENTS.WORKPLAN_GENERATION_STARTED,
    phase: "finalized",
    session_id: session.id,
    requested_at: "2026-06-01T10:01:10+08:00",
    generator: "codex",
  });

  let state = store.deriveState(session.dir);
  assert.equal(state.status, "done");
  assert.equal(state.outcome, "discussion_only");
  assert.equal(state.has_workplan, false);
  assert.equal(state.workplan_status, "generating");

  store.appendEvent(session.dir, {
    schema_version: 1,
    seq: 3,
    type: EVENTS.WORKPLAN_CREATED,
    phase: "finalized",
    session_id: session.id,
    created_at: "2026-06-01T10:01:20+08:00",
    generator: "codex",
    source: { summary_event_seq: 1, transcript_path: "transcript.jsonl" },
    workplan: {
      title: "Plan title",
      rationale: "Rationale",
      goal: "Goal",
      scope: ["Scope item"],
      non_goals: ["Non goal"],
      tasks: [{ id: "T1", title: "Task", description: "Do it", files: ["apps/patchcouncil-ui/server.js"], depends_on: [], verification: ["npm run check"] }],
      risks: [{ risk: "Risk", mitigation: "Mitigation" }],
    },
  });

  state = store.deriveState(session.dir);
  const transcript = store.generateTranscript(session.dir);

  assert.equal(state.status, "done");
  assert.equal(state.outcome, "discussion_only");
  assert.equal(state.has_workplan, true);
  assert.equal(state.workplan_status, "created");
  assert.match(transcript, /Workplan/);
  assert.match(transcript, /Plan title/);
  assert.match(transcript, /npm run check/);

  teardownTest();
  pass();
}
```

在 `testWorkbenchStateAndTranscriptEvents()` 后调用。

- [ ] **步骤 5：运行测试确认失败**

```powershell
cd apps\patchcouncil-ui
npm run smoke
```

预期：`has_workplan`、`workplan_status` 或 transcript 断言失败。

- [ ] **步骤 6：实现 state 派生**

在 `SessionStore.deriveState` 中，计算 `errorCount` 后加入：

```js
const workplanEvents = allEvents.filter((e) =>
  e.type === "workplan_generation_started" ||
  e.type === "workplan_created" ||
  e.type === "workplan_generation_failed"
);
const hasWorkplan = allEvents.some((e) => e.type === "workplan_created");
let workplanStatus = "none";
if (hasWorkplan) {
  workplanStatus = "created";
} else if (workplanEvents.length > 0) {
  const latestWorkplanEvent = workplanEvents[workplanEvents.length - 1];
  if (latestWorkplanEvent.type === "workplan_generation_started") {
    workplanStatus = "generating";
  } else if (latestWorkplanEvent.type === "workplan_generation_failed") {
    workplanStatus = "failed";
  }
}
```

在 `state` 对象中加入：

```js
has_workplan: hasWorkplan,
workplan_status: workplanStatus,
```

- [ ] **步骤 7：实现 transcript 渲染**

在 `SessionStore.generateTranscript` 的 `switch` 中加入：

```js
case "workplan_generation_started":
  lines.push("## Workplan generation started");
  lines.push("");
  lines.push(`**Generator:** ${event.generator}`);
  lines.push(`**Requested:** ${event.requested_at}`);
  lines.push("");
  break;

case "workplan_created": {
  const plan = event.workplan || {};
  lines.push("## Workplan");
  lines.push("");
  lines.push(`# ${plan.title || "Untitled workplan"}`);
  lines.push("");
  if (plan.rationale) lines.push(`**Rationale:** ${plan.rationale}`);
  if (plan.goal) lines.push(`**Goal:** ${plan.goal}`);
  lines.push("");
  if (Array.isArray(plan.tasks) && plan.tasks.length > 0) {
    lines.push("### Tasks");
    for (const task of plan.tasks) {
      lines.push(`- **${task.id || ""} ${task.title || "Task"}**: ${task.description || ""}`.trim());
      if (Array.isArray(task.files) && task.files.length > 0) {
        lines.push(`  - Files: ${task.files.join(", ")}`);
      }
      if (Array.isArray(task.verification) && task.verification.length > 0) {
        lines.push(`  - Verification: ${task.verification.join("; ")}`);
      }
    }
    lines.push("");
  }
  if (Array.isArray(plan.risks) && plan.risks.length > 0) {
    lines.push("### Risks");
    for (const item of plan.risks) {
      lines.push(`- ${item.risk || ""} - ${item.mitigation || ""}`);
    }
    lines.push("");
  }
  break;
}

case "workplan_generation_failed":
  lines.push("## Workplan generation failed");
  lines.push("");
  lines.push(`**Message:** ${event.message}`);
  lines.push(`**Action:** ${event.action}`);
  lines.push(`**Recoverable:** ${event.recoverable}`);
  lines.push("");
  break;
```

- [ ] **步骤 8：更新 CLI renderer**

在 `apps/patchcouncil-ui/engine/event-sink.js` 的 `CliRendererSink.format` 中加入：

```js
case "workplan_generation_started":
  return `[workplan] Generating with ${event.generator}`;
case "workplan_created":
  return `[workplan] Created: ${event.workplan?.title || "Untitled workplan"}`;
case "workplan_generation_failed":
  return `[workplan] Failed: ${event.message}`;
```

- [ ] **步骤 9：运行检查**

```powershell
cd apps\patchcouncil-ui
npm run check
npm run smoke
```

预期：两个命令都通过。

- [ ] **步骤 10：提交**

```powershell
git add apps/patchcouncil-ui/engine/events.js apps/patchcouncil-ui/engine/session-store.js apps/patchcouncil-ui/engine/event-sink.js apps/patchcouncil-ui/scripts/council-smoke.js
git commit -m "feat: add workplan events"
```

## 任务 2：Workplan 解析、校验和 Brief 构建

**文件：**
- 新增：`apps/patchcouncil-ui/engine/workplan.js`
- 修改：`apps/patchcouncil-ui/scripts/council-smoke.js`
- 修改：`apps/patchcouncil-ui/package.json`

- [ ] **步骤 1：写 parser / validator 失败测试**

在 `council-smoke.js` 顶部引入：

```js
const { buildWorkplanBrief, parseWorkplanJson, validateWorkplan } = require("../engine/workplan");
```

新增测试：

```js
async function testWorkplanJsonParserAndValidator() {
  setupTest("workplan JSON parser and validator");

  const valid = parseWorkplanJson(JSON.stringify({
    title: "Title",
    rationale: "Why",
    goal: "Goal",
    scope: ["scope"],
    non_goals: ["no"],
    tasks: [{ id: "T1", title: "Task", description: "Do it", files: [], depends_on: [], verification: ["npm run check"] }],
    risks: [{ risk: "Risk", mitigation: "Mitigation" }],
  }));
  assert.equal(valid.ok, true);
  assert.equal(validateWorkplan(valid.workplan).ok, true);

  assert.equal(parseWorkplanJson("not json").ok, false);

  const incomplete = parseWorkplanJson(JSON.stringify({ title: "Missing fields" }));
  assert.equal(incomplete.ok, true);
  const invalid = validateWorkplan(incomplete.workplan);
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /rationale|goal|tasks/);

  const missingVerification = validateWorkplan({
    title: "Title",
    rationale: "Why",
    goal: "Goal",
    scope: [],
    non_goals: [],
    tasks: [{ id: "T1", title: "Task", description: "Do it", files: [], depends_on: [], verification: [] }],
    risks: [],
  });
  assert.equal(missingVerification.ok, false);
  assert.match(missingVerification.error, /verification/);

  teardownTest();
  pass();
}
```

- [ ] **步骤 2：写 brief builder 失败测试**

新增：

```js
async function testWorkplanBriefIncludesAllAgentTurns() {
  setupTest("workplan brief includes all agent turns");

  const events = [
    { type: EVENTS.SESSION_STARTED, seq: 0, topic: "topic", session_id: "s1" },
    { type: EVENTS.AGENT_TURN_COMPLETED, seq: 1, agent: "codex", turn: 1, content: "first file boundary apps/patchcouncil-ui/server.js" },
    { type: EVENTS.AGENT_TURN_COMPLETED, seq: 2, agent: "claude", turn: 2, content: "second risk discussion schema validation" },
    { type: EVENTS.FINALIZED, seq: 3, summary: "summary", next_steps: ["generate plan"] },
  ];

  const brief = buildWorkplanBrief(events, {
    maxContextChars: 2000,
    maxTranscriptChars: 2000,
    maxMessageChars: 200,
    recentMessageChars: 400,
    transcriptPath: ".project-ai/sessions/s1/transcript.jsonl",
  });

  assert.match(brief, /topic/);
  assert.match(brief, /summary/);
  assert.match(brief, /first file boundary/);
  assert.match(brief, /second risk discussion/);
  assert.match(brief, /transcript.jsonl/);

  teardownTest();
  pass();
}
```

在 `main()` 中、engine 行为测试前调用这两个测试。

- [ ] **步骤 3：运行测试确认失败**

```powershell
cd apps\patchcouncil-ui
npm run smoke
```

预期：`../engine/workplan` 模块不存在。

- [ ] **步骤 4：新增 workplan helper 模块**

创建 `apps/patchcouncil-ui/engine/workplan.js`：

```js
"use strict";

const path = require("path");
const { clipText, selectCoordinator } = require("./council");

function parseWorkplanJson(raw) {
  const text = String(raw || "").trim();
  if (!text) return { ok: false, error: "empty workplan response" };
  try {
    return { ok: true, workplan: JSON.parse(text) };
  } catch (_) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return { ok: true, workplan: JSON.parse(text.slice(start, end + 1)) };
      } catch (error) {
        return { ok: false, error: "failed to parse workplan JSON: " + error.message };
      }
    }
    return { ok: false, error: "failed to parse workplan JSON" };
  }
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validateWorkplan(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return { ok: false, error: "workplan must be an object" };
  }
  for (const field of ["title", "rationale", "goal"]) {
    if (typeof plan[field] !== "string" || !plan[field].trim()) {
      return { ok: false, error: `workplan.${field} is required` };
    }
  }
  for (const field of ["scope", "non_goals"]) {
    if (!isStringArray(plan[field])) {
      return { ok: false, error: `workplan.${field} must be an array of strings` };
    }
  }
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    return { ok: false, error: "workplan.tasks must contain at least one task" };
  }
  for (const task of plan.tasks) {
    for (const field of ["id", "title", "description"]) {
      if (typeof task[field] !== "string" || !task[field].trim()) {
        return { ok: false, error: `task.${field} is required` };
      }
    }
    if (!isStringArray(task.files)) return { ok: false, error: `task ${task.id} files must be an array of strings` };
    if (!isStringArray(task.depends_on)) return { ok: false, error: `task ${task.id} depends_on must be an array of strings` };
    if (!isStringArray(task.verification) || task.verification.length === 0) {
      return { ok: false, error: `task ${task.id} verification must contain at least one item` };
    }
  }
  if (!Array.isArray(plan.risks)) {
    return { ok: false, error: "workplan.risks must be an array" };
  }
  for (const risk of plan.risks) {
    if (typeof risk.risk !== "string" || typeof risk.mitigation !== "string") {
      return { ok: false, error: "each risk must include risk and mitigation strings" };
    }
  }
  return { ok: true };
}

function buildWorkplanBrief(allEvents, options = {}) {
  const limits = {
    maxTranscriptChars: options.maxTranscriptChars || 8000,
    maxMessageChars: options.maxMessageChars || 1200,
    recentMessageChars: options.recentMessageChars || 2000,
  };
  const started = allEvents.find((event) => event.type === "session_started");
  const finalized = [...allEvents].reverse().find((event) => event.type === "finalized");
  const agentTurns = allEvents.filter((event) => event.type === "agent_turn_completed");
  const priorWorkplan = [...allEvents].reverse().find((event) => event.type === "workplan_created");

  const sections = [];
  sections.push("# Workplan Brief");
  sections.push(`## Topic\n\n${started?.topic || ""}`);
  if (finalized) {
    sections.push(`## Final Summary\n\n${finalized.summary || ""}`);
    if (Array.isArray(finalized.next_steps) && finalized.next_steps.length > 0) {
      sections.push(`## Final Next Steps\n\n${finalized.next_steps.map((step) => `- ${step}`).join("\n")}`);
    }
  }
  if (priorWorkplan?.workplan) {
    sections.push(`## Source Workplan\n\n${priorWorkplan.workplan.title || ""}\n\n${priorWorkplan.workplan.goal || ""}`);
  }

  const turnSections = agentTurns.map((event, index) => {
    const isRecent = index >= agentTurns.length - 2;
    const limit = isRecent ? limits.recentMessageChars : limits.maxMessageChars;
    return `### ${event.agent} turn ${event.turn}\n\n${clipText(event.content || "", limit)}`;
  });
  if (turnSections.length > 0) {
    sections.push(`## Agent Contributions\n\n${turnSections.join("\n\n")}`);
  }
  if (options.transcriptPath) {
    sections.push(`## Transcript Path\n\n${options.transcriptPath}`);
  }

  return clipText(sections.join("\n\n"), limits.maxTranscriptChars);
}

function selectWorkplanGenerator(config) {
  return selectCoordinator(config);
}

module.exports = {
  parseWorkplanJson,
  validateWorkplan,
  buildWorkplanBrief,
  selectWorkplanGenerator,
};
```

- [ ] **步骤 5：加入语法检查**

在 `apps/patchcouncil-ui/package.json` 的 `check` script 末尾追加：

```text
&& node --check ./engine/workplan.js
```

- [ ] **步骤 6：运行检查**

```powershell
cd apps\patchcouncil-ui
npm run check
npm run smoke
```

预期：两个命令都通过。

- [ ] **步骤 7：提交**

```powershell
git add apps/patchcouncil-ui/engine/workplan.js apps/patchcouncil-ui/package.json apps/patchcouncil-ui/scripts/council-smoke.js
git commit -m "feat: add workplan validation helpers"
```

## 任务 3：Workplan Prompt

**文件：**
- 新增：`apps/patchcouncil-ui/engine/prompts/workplan_create.md`
- 测试：`apps/patchcouncil-ui/scripts/council-smoke.js`

- [ ] **步骤 1：写 prompt 渲染失败测试**

在 `council-smoke.js` 增加：

```js
async function testWorkplanPromptRendersContract() {
  setupTest("workplan prompt renders contract");

  const rendered = prompts.renderPrompt("workplan_create.md", {
    topic: "topic",
    brief: "brief",
  });

  assert.match(rendered, /strict JSON/i);
  assert.match(rendered, /verification/);
  assert.match(rendered, /non_goals/);
  assert.match(rendered, /Do not execute/i);
  assert.match(rendered, /brief/);

  teardownTest();
  pass();
}
```

在 brief builder 测试后调用。

- [ ] **步骤 2：运行测试确认失败**

```powershell
cd apps\patchcouncil-ui
npm run smoke
```

预期：`workplan_create.md` 不存在。

- [ ] **步骤 3：创建 prompt 模板**

创建 `apps/patchcouncil-ui/engine/prompts/workplan_create.md`：

```markdown
You are the PatchCouncil workplan planner.

You are not continuing the discussion. Your job is to translate a completed council discussion into a structured implementation plan.

Do not execute commands.
Do not modify files.
Do not ask follow-up questions.
Do not output Markdown fences.
Output strict JSON only.

Topic:
{{ topic }}

Council brief:
{{ brief }}

Return exactly this JSON shape and no extra fields:

{
  "title": "string",
  "rationale": "string",
  "goal": "string",
  "scope": ["string"],
  "non_goals": ["string"],
  "tasks": [
    {
      "id": "T1",
      "title": "string",
      "description": "string",
      "files": ["string"],
      "depends_on": [],
      "verification": ["string"]
    }
  ],
  "risks": [
    {
      "risk": "string",
      "mitigation": "string"
    }
  ]
}

Planning rules:
- Each task must be one verifiable engineering change.
- Do not put the entire feature into one task.
- Do not split mechanical edits into tiny tasks.
- Each task must include at least one verification item.
- Prefer existing project commands when they are relevant: npm run check, npm run smoke, npm run runtime:fake.
- Do not invent commands that are not supported by the project context.
- If files are uncertain, use an empty files array and explain the uncertainty in description or risks.
- Always include non_goals to keep the plan bounded.
- If the discussion lacks detail, produce a conservative plan and record uncertainty in risks.
```

- [ ] **步骤 4：运行检查**

```powershell
cd apps\patchcouncil-ui
npm run check
npm run smoke
```

预期：两个命令都通过。

- [ ] **步骤 5：提交**

```powershell
git add apps/patchcouncil-ui/engine/prompts/workplan_create.md apps/patchcouncil-ui/scripts/council-smoke.js
git commit -m "feat: add workplan prompt"
```

## 任务 4：Workplan 生成服务

**文件：**
- 修改：`apps/patchcouncil-ui/engine/workplan.js`
- 修改：`apps/patchcouncil-ui/scripts/council-smoke.js`

- [ ] **步骤 1：写成功生成失败测试**

在 `council-smoke.js` 更新 import：

```js
const { buildWorkplanBrief, parseWorkplanJson, validateWorkplan, generateWorkplanForSession } = require("../engine/workplan");
```

新增：

```js
async function testGenerateWorkplanForDoneSession() {
  setupTest("generate workplan for done session");

  const store = new SessionStore(testDir);
  const session = store.createSession("topic");
  const plan = {
    title: "Plan",
    rationale: "Why",
    goal: "Goal",
    scope: ["scope"],
    non_goals: ["no execution"],
    tasks: [{ id: "T1", title: "Task", description: "Do it", files: [], depends_on: [], verification: ["npm run check"] }],
    risks: [],
  };

  for (const event of [
    { schema_version: 1, seq: 0, type: EVENTS.SESSION_STARTED, phase: "discussion", session_id: session.id, started_at: "2026-06-01T10:00:00+08:00", topic: "topic", mode: "council", config: {}, capabilities: {}, agents: [] },
    { schema_version: 1, seq: 1, type: EVENTS.AGENT_TURN_COMPLETED, phase: "discussion", session_id: session.id, turn: 1, agent: "codex", content: "Need server API and UI card." },
    { schema_version: 1, seq: 2, type: EVENTS.FINALIZED, phase: "discussion", session_id: session.id, summary: "Build workplan generation.", next_steps: ["Add API"] },
    { schema_version: 1, seq: 3, type: EVENTS.SESSION_FINISHED, phase: "finalized", session_id: session.id, finished_at: "2026-06-01T10:01:00+08:00", outcome: "discussion_only", duration_ms: 60000, turn_count: 1, distinct_agents: ["codex"], error_count: 0 },
  ]) store.appendEvent(session.dir, event);

  const emitted = [];
  const result = await generateWorkplanForSession({
    config: MINIMAL_CONFIG,
    sessionStore: store,
    sessionDir: session.dir,
    sessionId: session.id,
    prompts,
    runAgent: async () => ({ ok: true, text: JSON.stringify(plan) }),
    onEvent: (event) => {
      emitted.push(event);
      store.appendEvent(session.dir, event);
    },
  });

  assert.equal(result.ok, true);
  assert.ok(emitted.some((e) => e.type === EVENTS.WORKPLAN_GENERATION_STARTED));
  assert.ok(emitted.some((e) => e.type === EVENTS.WORKPLAN_CREATED));
  assert.equal(store.deriveState(session.dir).workplan_status, "created");

  teardownTest();
  pass();
}
```

- [ ] **步骤 2：写失败生成测试**

新增：

```js
async function testGenerateWorkplanFailureAllowsRetry() {
  setupTest("generate workplan failure event");

  const store = new SessionStore(testDir);
  const session = store.createSession("topic");
  for (const event of [
    { schema_version: 1, seq: 0, type: EVENTS.SESSION_STARTED, phase: "discussion", session_id: session.id, started_at: "2026-06-01T10:00:00+08:00", topic: "topic", mode: "council", config: {}, capabilities: {}, agents: [] },
    { schema_version: 1, seq: 1, type: EVENTS.FINALIZED, phase: "discussion", session_id: session.id, summary: "Summary", next_steps: [] },
    { schema_version: 1, seq: 2, type: EVENTS.SESSION_FINISHED, phase: "finalized", session_id: session.id, finished_at: "2026-06-01T10:01:00+08:00", outcome: "discussion_only", duration_ms: 60000, turn_count: 0, distinct_agents: [], error_count: 0 },
  ]) store.appendEvent(session.dir, event);

  const emitted = [];
  const result = await generateWorkplanForSession({
    config: MINIMAL_CONFIG,
    sessionStore: store,
    sessionDir: session.dir,
    sessionId: session.id,
    prompts,
    runAgent: async () => ({ ok: true, text: "{ invalid json" }),
    onEvent: (event) => {
      emitted.push(event);
      store.appendEvent(session.dir, event);
    },
  });

  assert.equal(result.ok, false);
  assert.ok(emitted.some((e) => e.type === EVENTS.WORKPLAN_GENERATION_FAILED));
  assert.equal(store.deriveState(session.dir).workplan_status, "failed");

  teardownTest();
  pass();
}
```

在 prompt 测试后调用这两个测试。

- [ ] **步骤 3：运行测试确认失败**

```powershell
cd apps\patchcouncil-ui
npm run smoke
```

预期：`generateWorkplanForSession` 不是函数。

- [ ] **步骤 4：实现生成服务**

在 `apps/patchcouncil-ui/engine/workplan.js` 增加：

```js
function nextSeq(allEvents) {
  return allEvents.reduce((max, event) => Math.max(max, Number(event.seq)), -1) + 1;
}

function doneSessionState(sessionStore, sessionDir) {
  const state = sessionStore.deriveState(sessionDir);
  return state.status === "done";
}

async function generateWorkplanForSession(options) {
  const { config, sessionStore, sessionDir, sessionId, prompts, runAgent, onEvent } = options;
  const allEvents = sessionStore.readEvents(sessionDir);

  if (!doneSessionState(sessionStore, sessionDir)) {
    return { ok: false, error: "workplan can only be generated for done sessions", status: 409 };
  }
  if (allEvents.some((event) => event.type === "workplan_created")) {
    return { ok: false, error: "workplan already exists", status: 409 };
  }
  const lastWorkplanEvent = [...allEvents].reverse().find((event) =>
    event.type === "workplan_generation_started" ||
    event.type === "workplan_created" ||
    event.type === "workplan_generation_failed"
  );
  if (lastWorkplanEvent?.type === "workplan_generation_started") {
    return { ok: false, error: "workplan generation already in progress", status: 409 };
  }

  const generator = selectWorkplanGenerator(config);
  if (!generator) {
    return { ok: false, error: "no available workplan generator", status: 409 };
  }

  let seq = nextSeq(allEvents);
  onEvent({
    schema_version: 1,
    seq: seq++,
    type: "workplan_generation_started",
    phase: "finalized",
    session_id: sessionId,
    requested_at: new Date().toISOString(),
    generator: generator.name,
  });

  const updatedEvents = sessionStore.readEvents(sessionDir);
  const started = updatedEvents.find((event) => event.type === "session_started");
  const brief = buildWorkplanBrief(updatedEvents, {
    transcriptPath: path.join(sessionDir, "transcript.jsonl"),
    maxTranscriptChars: config.council?.max_workplan_transcript_chars || 8000,
    maxMessageChars: config.council?.max_workplan_message_chars || 1200,
    recentMessageChars: config.council?.max_workplan_recent_message_chars || 2000,
  });
  const prompt = prompts.renderPrompt("workplan_create.md", {
    topic: started?.topic || "",
    brief,
  });

  const result = await runAgent(generator.name, generator.config, prompt);
  if (!result.ok) {
    const failed = {
      schema_version: 1,
      seq,
      type: "workplan_generation_failed",
      phase: "finalized",
      session_id: sessionId,
      failed_at: new Date().toISOString(),
      generator: generator.name,
      message: result.error || "workplan generation failed",
      recoverable: true,
      action: "show_error",
      details: {},
    };
    onEvent(failed);
    sessionStore.deriveState(sessionDir);
    sessionStore.generateTranscript(sessionDir);
    return { ok: false, error: failed.message, status: 200 };
  }

  const parsed = parseWorkplanJson(result.text);
  const validation = parsed.ok ? validateWorkplan(parsed.workplan) : parsed;
  if (!parsed.ok || !validation.ok) {
    const failed = {
      schema_version: 1,
      seq,
      type: "workplan_generation_failed",
      phase: "finalized",
      session_id: sessionId,
      failed_at: new Date().toISOString(),
      generator: generator.name,
      message: parsed.ok ? validation.error : parsed.error,
      recoverable: true,
      action: "show_error",
      details: { raw: String(result.text || "").slice(0, 500) },
    };
    onEvent(failed);
    sessionStore.deriveState(sessionDir);
    sessionStore.generateTranscript(sessionDir);
    return { ok: false, error: failed.message, status: 200 };
  }

  const finalized = [...updatedEvents].reverse().find((event) => event.type === "finalized");
  onEvent({
    schema_version: 1,
    seq,
    type: "workplan_created",
    phase: "finalized",
    session_id: sessionId,
    created_at: new Date().toISOString(),
    generator: generator.name,
    source: {
      summary_event_seq: finalized ? finalized.seq : null,
      transcript_path: path.join(sessionDir, "transcript.jsonl"),
    },
    workplan: parsed.workplan,
  });
  sessionStore.deriveState(sessionDir);
  sessionStore.generateTranscript(sessionDir);
  return { ok: true, workplan: parsed.workplan, status: 200 };
}
```

导出：

```js
generateWorkplanForSession,
```

- [ ] **步骤 5：运行检查**

```powershell
cd apps\patchcouncil-ui
npm run check
npm run smoke
```

预期：两个命令都通过。

- [ ] **步骤 6：提交**

```powershell
git add apps/patchcouncil-ui/engine/workplan.js apps/patchcouncil-ui/scripts/council-smoke.js
git commit -m "feat: generate workplans from sessions"
```

## 任务 5：Workplan HTTP API

**文件：**
- 修改：`apps/patchcouncil-ui/server.js`
- 修改：`apps/patchcouncil-ui/scripts/smoke-test.js`

- [ ] **步骤 1：写 API smoke 失败测试**

在 `apps/patchcouncil-ui/scripts/smoke-test.js` 的 continued session 检查后增加：

```js
    const planSession = await fetchJson("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ topic: "workplan smoke topic", mode: "council" }),
    });
    const planSessionId = planSession.session_id;
    const planEncoded = encodeURIComponent(planSessionId);

    const doneDeadline = Date.now() + 8000;
    let doneState = null;
    while (Date.now() < doneDeadline) {
      const all = await fetchJson("/api/sessions");
      doneState = all.sessions.find((item) => item.session_id === planSessionId);
      if (doneState && doneState.status === "done") break;
      await wait(200);
    }
    if (!doneState || doneState.status !== "done") {
      throw new Error("workplan smoke session did not finish");
    }

    const startedWorkplan = await fetchJson(`/api/sessions/${planEncoded}/workplan`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    if (startedWorkplan.status !== "generating") {
      throw new Error("expected workplan generation status");
    }

    const workplanDeadline = Date.now() + 5000;
    let workplanEvents = [];
    while (Date.now() < workplanDeadline) {
      const resp = await fetchJson(`/api/sessions/${planEncoded}/events`);
      workplanEvents = resp.events || [];
      if (workplanEvents.some((event) => event.type === "workplan_created")) break;
      await wait(200);
    }
    if (!workplanEvents.some((event) => event.type === "workplan_created")) {
      throw new Error("expected workplan_created event");
    }

    let duplicateRejected = false;
    try {
      await fetchJson(`/api/sessions/${planEncoded}/workplan`, { method: "POST", body: JSON.stringify({}) });
    } catch (error) {
      duplicateRejected = /409/.test(error.message);
    }
    if (!duplicateRejected) {
      throw new Error("expected duplicate workplan generation to return 409");
    }
```

- [ ] **步骤 2：运行测试确认失败**

```powershell
cd apps\patchcouncil-ui
npm run smoke
```

预期：`/api/sessions/:id/workplan` 返回 404。

- [ ] **步骤 3：引入 workplan service**

在 `server.js` 顶部加入：

```js
const { generateWorkplanForSession } = require("./engine/workplan");
```

在 `activeSessions` 附近加入：

```js
const activeWorkplans = new Set();
```

- [ ] **步骤 4：让 fake runtime 支持 workplan prompt**

在 `makeRuntimeRunner` 的 `PATCHCOUNCIL_FAKE_RUNTIME === "1"` 分支中，通用 fake response 之前加入：

```js
      if (prompt.includes("PatchCouncil workplan planner")) {
        return {
          ok: true,
          text: JSON.stringify({
            title: "Smoke workplan",
            rationale: "Generated by fake runtime for smoke tests.",
            goal: "Verify workplan generation path.",
            scope: ["HTTP API", "event log"],
            non_goals: ["real execution"],
            tasks: [{
              id: "T1",
              title: "Verify workplan API",
              description: "Confirm the server appends workplan events.",
              files: ["apps/patchcouncil-ui/server.js"],
              depends_on: [],
              verification: ["npm run smoke"],
            }],
            risks: [],
          }),
        };
      }
```

- [ ] **步骤 5：新增 API route**

在 `handleApi` 中，`GET /api/sessions/:id/events` 之前加入：

```js
  const workplanMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/workplan$/);
  if (workplanMatch && req.method === "POST") {
    if (!projectRoot || !realSessionRoot) {
      sendJson(res, 500, { error: "project root not found" });
      return true;
    }
    const sessionId = decodeURIComponent(workplanMatch[1]);
    const sessionDir = safeJoin(realSessionRoot, sessionId);
    if (!sessionDir || !fs.existsSync(path.join(sessionDir, "transcript.jsonl"))) {
      sendJson(res, 404, { error: "session not found" });
      return true;
    }
    if (activeWorkplans.has(sessionId)) {
      sendJson(res, 409, { error: "workplan generation already in progress" });
      return true;
    }

    const sessionStore = new SessionStore(realSessionRoot);
    const state = sessionStore.deriveState(sessionDir);
    if (state.status !== "done") {
      sendJson(res, 409, { error: "workplan can only be generated for done sessions" });
      return true;
    }
    if (state.has_workplan) {
      sendJson(res, 409, { error: "workplan already exists" });
      return true;
    }

    activeWorkplans.add(sessionId);
    sendJson(res, 202, { session_id: sessionId, status: "generating" });

    const config = loadConfig(projectRoot);
    setImmediate(async () => {
      try {
        await generateWorkplanForSession({
          config,
          sessionStore,
          sessionDir,
          sessionId,
          prompts,
          runAgent: makeRuntimeRunner(projectRoot, { sessionId, sessionDir, currentRun: null }),
          onEvent: (event) => sessionStore.appendEvent(sessionDir, event),
        });
      } catch (error) {
        console.error(`[patchcouncil-ui] workplan ${sessionId} error:`, error.message);
      } finally {
        activeWorkplans.delete(sessionId);
      }
    });

    return true;
  }
```

- [ ] **步骤 6：运行检查**

```powershell
cd apps\patchcouncil-ui
npm run check
npm run smoke
```

预期：两个命令都通过。

- [ ] **步骤 7：提交**

```powershell
git add apps/patchcouncil-ui/server.js apps/patchcouncil-ui/scripts/smoke-test.js
git commit -m "feat: add workplan generation API"
```

## 任务 6：Workbench Workplan UI

**文件：**
- 修改：`apps/patchcouncil-ui/public/app.js`
- 修改：`apps/patchcouncil-ui/public/styles.css`
- 修改：`apps/patchcouncil-ui/scripts/smoke-test.js`

- [ ] **步骤 1：写静态 smoke 失败断言**

在 `smoke-test.js` 的 composer 断言之后读取 `/app.js`：

```js
    const appJs = await fetchText("/app.js");
    if (!appJs.includes("Generate Workplan")) {
      throw new Error("app js missing workplan action text");
    }
```

预期：失败，直到 `public/app.js` 加入 Workplan UI。

- [ ] **步骤 2：增加 Workplan 状态投影 helper**

在 `apps/patchcouncil-ui/public/app.js` 的投影函数附近加入：

```js
function latestEvent(type) {
  return [...activeEvents].reverse().find((event) => event.type === type) || null;
}

function workplanState() {
  const created = latestEvent("workplan_created");
  if (created) return { status: "created", event: created };
  const failed = latestEvent("workplan_generation_failed");
  const started = latestEvent("workplan_generation_started");
  if (started && (!failed || started.seq > failed.seq)) return { status: "generating", event: started };
  if (failed) return { status: "failed", event: failed };
  return { status: "none", event: null };
}
```

- [ ] **步骤 3：增加 Workplan 卡片渲染**

在 `app.js` 中加入：

```js
function renderWorkplanCard(session) {
  const state = workplanState();
  const section = document.createElement("section");
  section.className = "workplan-panel";

  const title = document.createElement("h3");
  title.textContent = "Workplan";
  section.append(title);

  if (!session || session.status !== "done") {
    const muted = document.createElement("p");
    muted.className = "muted";
    muted.textContent = "Workplan is available after a session finishes successfully.";
    section.append(muted);
    return section;
  }

  if (state.status === "none") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary";
    button.textContent = "Generate Workplan";
    button.addEventListener("click", generateWorkplan);
    section.append(button);
    return section;
  }

  if (state.status === "generating") {
    const muted = document.createElement("p");
    muted.className = "muted";
    muted.textContent = "Generating workplan...";
    section.append(muted);
    return section;
  }

  if (state.status === "failed") {
    const error = document.createElement("p");
    error.className = "error-text";
    error.textContent = state.event.message || "Workplan generation failed.";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary";
    button.textContent = "Generate Workplan";
    button.addEventListener("click", generateWorkplan);
    section.append(error, button);
    return section;
  }

  const plan = state.event.workplan || {};
  const heading = document.createElement("h4");
  heading.textContent = plan.title || "Untitled workplan";
  const goal = document.createElement("p");
  goal.textContent = plan.goal || "";
  section.append(heading, goal);

  const tasks = document.createElement("ol");
  tasks.className = "workplan-tasks";
  for (const task of plan.tasks || []) {
    const item = document.createElement("li");
    const strong = document.createElement("strong");
    strong.textContent = `${task.id || ""} ${task.title || "Task"}`.trim();
    const desc = document.createElement("p");
    desc.textContent = task.description || "";
    const verify = document.createElement("p");
    verify.className = "muted";
    verify.textContent = `Verify: ${(task.verification || []).join("; ")}`;
    item.append(strong, desc, verify);
    tasks.append(item);
  }
  section.append(tasks);

  const note = document.createElement("p");
  note.className = "muted";
  note.textContent = "Use Continue to discuss revisions in a new session.";
  section.append(note);
  return section;
}

async function generateWorkplan() {
  if (!activeSessionId) return;
  await postJson(`/api/sessions/${encodeURIComponent(activeSessionId)}/workplan`, {});
  await selectSession(activeSessionId);
}
```

- [ ] **步骤 4：挂入现有 renderThread**

修改 `apps/patchcouncil-ui/public/app.js` 的 `renderThread(session, events)`。

在 `if (isFinished) { ... }` 分支中，summary card loop 后立即加入：

```js
    if (session && session.status === "done") {
      els.threadBody.append(renderWorkplanCard(session));
    }
```

不要给 `cancelled` 或 `error` session 渲染 Workplan 面板；服务端也会用 `409` 保持同样规则。

- [ ] **步骤 5：增加样式**

在 `styles.css` 加入：

```css
.workplan-panel {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #f7f8fb;
  padding: 14px;
  display: grid;
  gap: 10px;
}

.workplan-panel h3,
.workplan-panel h4,
.workplan-panel p {
  margin: 0;
}

.workplan-tasks {
  margin: 0;
  padding-left: 20px;
  display: grid;
  gap: 10px;
}

.error-text {
  color: #9b2c2c;
}

.muted {
  color: var(--muted);
}
```

- [ ] **步骤 6：运行检查**

```powershell
cd apps\patchcouncil-ui
npm run check
npm run smoke
```

预期：两个命令都通过。

- [ ] **步骤 7：提交**

```powershell
git add apps/patchcouncil-ui/public/app.js apps/patchcouncil-ui/public/styles.css apps/patchcouncil-ui/scripts/smoke-test.js
git commit -m "feat: show workplans in workbench"
```

## 任务 7：Source Metadata 包含 Workplan 摘要

**文件：**
- 修改：`apps/patchcouncil-ui/engine/session-store.js`
- 修改：`apps/patchcouncil-ui/scripts/council-smoke.js`

- [ ] **步骤 1：写 source metadata 失败测试**

在 `council-smoke.js` 增加：

```js
async function testSourceMetadataIncludesWorkplanSummary() {
  setupTest("source metadata includes workplan summary");

  const store = new SessionStore(testDir);
  const session = store.createSession("planned topic");
  store.appendEvent(session.dir, {
    schema_version: 1, seq: 0, type: EVENTS.SESSION_STARTED, phase: "discussion",
    session_id: session.id, started_at: "2026-06-01T10:00:00+08:00",
    topic: "planned topic", mode: "council", config: {}, capabilities: {}, agents: [],
  });
  store.appendEvent(session.dir, {
    schema_version: 1, seq: 1, type: EVENTS.FINALIZED, phase: "discussion",
    session_id: session.id, summary: "Final summary", next_steps: [],
  });
  store.appendEvent(session.dir, {
    schema_version: 1, seq: 2, type: EVENTS.WORKPLAN_CREATED, phase: "finalized",
    session_id: session.id, created_at: "2026-06-01T10:02:00+08:00",
    generator: "codex", source: {},
    workplan: {
      title: "Workplan title",
      rationale: "Why",
      goal: "Goal text",
      scope: [],
      non_goals: [],
      tasks: [{ id: "T1", title: "Task", description: "Do it", files: [], depends_on: [], verification: ["npm run check"] }],
      risks: [],
    },
  });

  const meta = store.getSourceMetadata(session.dir);
  assert.match(meta.source_summary, /Final summary/);
  assert.match(meta.source_summary, /Workplan title/);
  assert.match(meta.source_summary, /Goal text/);

  teardownTest();
  pass();
}
```

在现有 source metadata 测试后调用。

- [ ] **步骤 2：运行测试确认失败**

```powershell
cd apps\patchcouncil-ui
npm run smoke
```

预期：source summary 不包含 workplan。

- [ ] **步骤 3：实现 source metadata 拼接**

在 `SessionStore.getSourceMetadata` 中，`finalized` 查找后加入：

```js
const workplanEvents = allEvents.filter((e) => e.type === "workplan_created");
const workplan = workplanEvents.length > 0 ? workplanEvents[workplanEvents.length - 1].workplan : null;
```

在 `summary` 计算后追加：

```js
if (workplan) {
  summary = [
    summary,
    "Source workplan: " + (workplan.title || "Untitled workplan"),
    "Goal: " + (workplan.goal || ""),
    "Tasks: " + (Array.isArray(workplan.tasks) ? workplan.tasks.map((task) => `${task.id}: ${task.title}`).join("; ") : ""),
  ].filter(Boolean).join("\n\n");
}
```

- [ ] **步骤 4：运行检查**

```powershell
cd apps\patchcouncil-ui
npm run check
npm run smoke
```

预期：两个命令都通过。

- [ ] **步骤 5：提交**

```powershell
git add apps/patchcouncil-ui/engine/session-store.js apps/patchcouncil-ui/scripts/council-smoke.js
git commit -m "feat: include workplans in session continuation"
```

## 任务 8：文档和最终验证

**文件：**
- 修改：`docs/COUNCIL_EVENTS.md`
- 修改：`docs/ROADMAP.md`
- 修改：`apps/patchcouncil-ui/README.md`
- 修改：`README.md`

- [ ] **步骤 1：更新事件文档**

在 `docs/COUNCIL_EVENTS.md` 的 council event 类型列表中加入：

```text
workplan_generation_started
workplan_created
workplan_generation_failed
```

新增小节：

```markdown
## Workplan events

Workplan events are post-discussion artifacts. They use `phase: "finalized"` because the discussion phase has already completed. They do not change `session_finished.outcome`; consumers should use `has_workplan` and `workplan_status` in derived state.
```

- [ ] **步骤 2：更新 Workbench README**

在 `apps/patchcouncil-ui/README.md` 的用户能力列表中加入：

```markdown
- 从已完成的 `done` session 生成结构化 workplan
```

在 API 表格中加入：

```markdown
| POST | `/api/sessions/:id/workplan` | 为 done session 生成结构化 workplan |
```

- [ ] **步骤 3：更新路线图**

在 `docs/ROADMAP.md` 中把 workplan 项标记为当前实现或已完成。

实现分支尚未合并时使用：

```markdown
3. （当前实现中）讨论后生成结构化 workplan，但暂不自动执行。
```

合并后再改为：

```markdown
3. （已完成）讨论后生成结构化 workplan，但暂不自动执行。
```

- [ ] **步骤 4：运行最终验证**

```powershell
cd apps\patchcouncil-ui
npm run check
npm run smoke
npm run runtime:fake
```

预期：

```text
check passes
smoke ok
runtime fake matrix passes
```

- [ ] **步骤 5：检查工作区**

```powershell
git status --short
```

预期：只剩本次有意修改和已有无关未跟踪目录。

- [ ] **步骤 6：提交**

```powershell
git add docs/COUNCIL_EVENTS.md docs/ROADMAP.md apps/patchcouncil-ui/README.md README.md
git commit -m "docs: document workplan generation"
```

## 最终交付检查

- 确认没有把 `.project-ai/sessions` 下的 session artifact 提交进 git。
- 确认 `state.outcome` 仍然反映 `session_finished.outcome`。
- 确认 UI 和 state 只通过 `workplan_status` 表达生成状态。
- 确认带 workplan 的 completed session 仍可以通过 Continue/Fork 进入下一轮讨论。
