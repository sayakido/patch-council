# PatchCouncil Workbench v1 实现计划

> **给 agentic workers：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 按任务逐步执行本计划。步骤使用 checkbox（`- [ ]`）语法追踪进度。

**目标：** 实现 Workbench v1，让 Web UI 可以创建、观察、主持插话、取消和继续 council sessions，并让 Node 成为活跃产品路径。

**架构：** 保持现有单 Node 进程应用。先补事件和 session 状态基础，再让 `CouncilEngine` 支持 host 控制点，然后暴露 HTTP API，最后把当前 timeline viewer 改造成聊天式工作台。已完成 session 保持不可变；Continue 会创建带 source metadata 的新 session。

**技术栈：** Node.js CommonJS、内置 `http` server、`js-yaml`、vanilla JS/CSS 前端、现有 `apps/patchcouncil-ui/scripts` smoke 脚本。

---

## 范围说明

本计划只实现 Workbench v1。

不实现：

- WebSocket。
- worker/daemon/queue。
- 执行或写文件模式。
- 桌面应用打包。
- workplan 审批。

每个任务完成后都应单独提交。不要提交 `.superpowers/` 或 `docs/mockups/` 预览产物，除非用户明确要求。

## 文件边界

- 修改 `apps/patchcouncil-ui/engine/events.js`：新增 `USER_INTERJECTION`、`SESSION_CANCEL_REQUESTED` 常量和构造函数。
- 修改 `apps/patchcouncil-ui/engine/session-store.js`：支持 source metadata、`cancelling` state、interjection transcript 渲染和 source summary helper。
- 修改 `apps/patchcouncil-ui/engine/event-sink.js`：让 CLI/debug 输出识别新事件。
- 修改 `apps/patchcouncil-ui/engine/council.js`：增加 interjection/cancellation 控制点、source metadata、config snapshot 行为。
- 修改 `apps/patchcouncil-ui/src/runtime/cli-adapter.js`：复用现有 `cancel()` 路径，让 server 能取消当前 runtime 调用。
- 修改 `apps/patchcouncil-ui/server.js`：增加 JSON body parser、active session controllers、create/interject/cancel/config APIs。
- 修改 `apps/patchcouncil-ui/public/index.html`：从事件查看器骨架改为 workbench 骨架。
- 修改 `apps/patchcouncil-ui/public/app.js`：增加 UI 状态机、聊天投影、composer 行为、API 调用和 raw-events view。
- 修改 `apps/patchcouncil-ui/public/styles.css`：实现三态聊天工作台布局。
- 新增 `apps/patchcouncil-ui/public/config.html`：最小可用全局配置页面。
- 新增 `apps/patchcouncil-ui/public/config.js`：读取、编辑并保存全局配置。
- 修改 `apps/patchcouncil-ui/scripts/council-smoke.js`：增加 engine 层 interjection、cancellation、source metadata 测试。
- 修改 `apps/patchcouncil-ui/scripts/smoke-test.js`：增加 HTTP API smoke 覆盖。
- 修改 `apps/patchcouncil-ui/package.json`：把新增 `public/config.js` 纳入 `npm run check`。
- 修改 `README.md`、`apps/patchcouncil-ui/README.md`、`docs/ROADMAP.md`、`docs/AI_CONTEXT.md`：说明 Node Workbench 是活跃路径，Python 是参考原型。

## 任务 1：事件和状态基础

**文件：**
- 修改：`apps/patchcouncil-ui/engine/events.js`
- 修改：`apps/patchcouncil-ui/engine/session-store.js`
- 修改：`apps/patchcouncil-ui/engine/event-sink.js`
- 测试：`apps/patchcouncil-ui/scripts/council-smoke.js`

- [ ] **步骤 1：为新事件常量写失败测试**

在 `apps/patchcouncil-ui/scripts/council-smoke.js` 中增加测试：

```js
async function testWorkbenchEventConstants() {
  setupTest("workbench event constants");

  assert.equal(EVENTS.USER_INTERJECTION, "user_interjection");
  assert.equal(EVENTS.SESSION_CANCEL_REQUESTED, "session_cancel_requested");

  teardownTest();
  pass();
}
```

在 `main()` 中、其他 engine 行为测试之前调用：

```js
await testWorkbenchEventConstants();
```

- [ ] **步骤 2：运行测试，确认失败**

运行：

```powershell
cd apps\patchcouncil-ui
npm run smoke
```

预期：`workbench event constants` 失败，因为 `EVENTS.USER_INTERJECTION` 还不存在。

- [ ] **步骤 3：增加事件常量和构造函数**

在 `apps/patchcouncil-ui/engine/events.js` 中扩展 `EVENTS`：

```js
USER_INTERJECTION: "user_interjection",
SESSION_CANCEL_REQUESTED: "session_cancel_requested",
```

增加构造函数：

```js
function userInterjection(sessionId, seq, phase, turn, content, createdAt) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.USER_INTERJECTION, phase), {
    turn,
    content,
    created_at: createdAt,
  });
}

function sessionCancelRequested(sessionId, seq, phase, requestedAt, reason) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.SESSION_CANCEL_REQUESTED, phase), {
    requested_at: requestedAt,
    reason: reason || "user",
  });
}
```

导出这两个函数。

- [ ] **步骤 4：为 state/transcript 写失败测试**

在 `council-smoke.js` 中增加手动写入事件的测试：

```js
async function testWorkbenchStateAndTranscriptEvents() {
  setupTest("workbench events derive state and transcript");

  const store = new SessionStore(testDir);
  const session = store.createSession("cancel me");
  store.appendEvent(session.dir, {
    schema_version: 1,
    seq: 0,
    type: EVENTS.SESSION_STARTED,
    phase: "discussion",
    session_id: session.id,
    started_at: "2026-05-28T10:00:00+08:00",
    topic: "cancel me",
    mode: "council",
    config: {},
    capabilities: {},
    agents: [],
  });
  store.appendEvent(session.dir, {
    schema_version: 1,
    seq: 1,
    type: EVENTS.USER_INTERJECTION,
    phase: "discussion",
    session_id: session.id,
    turn: 0,
    content: "please focus",
    created_at: "2026-05-28T10:00:10+08:00",
  });
  store.appendEvent(session.dir, {
    schema_version: 1,
    seq: 2,
    type: EVENTS.SESSION_CANCEL_REQUESTED,
    phase: "discussion",
    session_id: session.id,
    requested_at: "2026-05-28T10:00:20+08:00",
    reason: "user",
  });

  const state = store.deriveState(session.dir);
  const transcript = store.generateTranscript(session.dir);

  assert.equal(state.status, "cancelling");
  assert.match(transcript, /Host/);
  assert.match(transcript, /please focus/);
  assert.match(transcript, /Cancellation requested/);

  teardownTest();
  pass();
}
```

在 `main()` 中调用。

- [ ] **步骤 5：运行测试，确认失败**

运行：

```powershell
cd apps\patchcouncil-ui
npm run smoke
```

预期：state 仍是 `running`，transcript 也没有 Host/cancellation 内容。

- [ ] **步骤 6：更新 state 派生和 transcript 渲染**

在 `SessionStore.deriveState` 中，在 `session_error` fallback 前增加：

```js
} else if (allEvents.some((e) => e.type === "session_cancel_requested")) {
  status = "cancelling";
```

在 `generateTranscript` 中增加：

```js
case "user_interjection":
  lines.push(`## Host Interjection (turn ${event.turn})`);
  lines.push("");
  lines.push(event.content);
  lines.push("");
  break;

case "session_cancel_requested":
  lines.push("## Cancellation requested");
  lines.push("");
  lines.push(`**Reason:** ${event.reason || "user"}`);
  lines.push(`**Requested:** ${event.requested_at}`);
  lines.push("");
  break;
```

- [ ] **步骤 7：更新 CLI renderer**

在 `CliRendererSink.format` 中增加：

```js
case "user_interjection":
  return `[host] Interjection queued: ${(event.content || "").slice(0, 120)}`;
case "session_cancel_requested":
  return `[council] Cancellation requested (${event.reason || "user"})`;
```

- [ ] **步骤 8：运行检查**

运行：

```powershell
cd apps\patchcouncil-ui
npm run check
npm run smoke
```

预期：两个命令都通过。

- [ ] **步骤 9：提交**

```powershell
git add apps/patchcouncil-ui/engine/events.js apps/patchcouncil-ui/engine/session-store.js apps/patchcouncil-ui/engine/event-sink.js apps/patchcouncil-ui/scripts/council-smoke.js
git commit -m "feat: add workbench session events"
```

## 任务 2：Engine 的插话和取消控制

**文件：**
- 修改：`apps/patchcouncil-ui/engine/council.js`
- 修改：`apps/patchcouncil-ui/scripts/council-smoke.js`

- [ ] **步骤 1：增加 interjection 失败测试**

增加测试：第一轮 agent 发言期间追加 interjection，并断言下一次 decide prompt 包含它。

```js
async function testInterjectionIncludedInNextCoordinatorBrief() {
  setupTest("interjection included in next coordinator brief");

  const config = JSON.parse(JSON.stringify(MINIMAL_CONFIG));
  config.council.min_distinct_agents = 1;
  config.council.max_turns = 2;

  let capturedDecidePrompt = "";
  let engineRef = null;

  const scenarios = [
    {
      match: isRoutePrompt,
      response: { ok: true, text: JSON.stringify({ decision: "continue", next_agent: "codex", role: "analyze", reason: "first" }) },
    },
    {
      match: isAgentTurnPrompt,
      response: async () => {
        engineRef.addInterjection("please include security");
        return { ok: true, text: "Codex analysis." };
      },
    },
    {
      match: isDecidePrompt,
      response: (prompt) => {
        capturedDecidePrompt = prompt;
        return { ok: true, text: JSON.stringify({ decision: "finalize", next_agent: null, role: null, reason: "done" }) };
      },
    },
    {
      match: isFinalizePrompt,
      response: { ok: true, text: JSON.stringify({ consensus: "ok", next_steps: [] }) },
    },
  ];

  const store = new SessionStore(testDir);
  const session = store.createSession("test topic");
  const engine = new CouncilEngine({
    config,
    sessionStore: store,
    runAgent: makeFakeRuntime(scenarios),
    projectRoot: testDir,
    prompts,
    sessionDir: session.dir,
    sessionId: session.id,
  });
  engineRef = engine;
  engine.on("event", (e) => store.appendEvent(session.dir, e));

  await engine.run("test topic");

  assert.match(capturedDecidePrompt, /please include security/);
  assert.ok(store.readEvents(session.dir).some((e) => e.type === EVENTS.USER_INTERJECTION));

  teardownTest();
  pass();
}
```

- [ ] **步骤 2：运行并确认失败**

运行：

```powershell
cd apps\patchcouncil-ui
npm run smoke
```

预期：失败，因为 `engine.addInterjection` 还不存在。

- [ ] **步骤 3：增加 interjection controller state**

在 `CouncilEngine.constructor` 中增加：

```js
this.cancelRequested = false;
this.cancelReason = null;
this.interjections = [];
```

增加方法：

```js
addInterjection(content) {
  const text = String(content || "").trim();
  if (!text) return null;
  const event = this.emitEvent(events.EVENTS.USER_INTERJECTION, {
    turn: this.turnCount,
    content: text,
    created_at: new Date().toISOString(),
  });
  this.interjections.push(event);
  return event;
}
```

- [ ] **步骤 4：把 interjections 放进 brief**

在 `buildBrief` 中加入 `user_interjection` 投影：

```js
} else if (event.type === "user_interjection") {
  messages.push(`### Host interjection (turn ${event.turn})\n\n${clipText(event.content, limits.maxMessageChars)}`);
```

因为 `addInterjection` 会通过 `emitEvent` 写入 `this.eventLog`，下一次 coordinator brief 会沿用现有 recent-log 路径看到它。

- [ ] **步骤 5：增加 cancellation 失败测试**

增加：

```js
async function testCancellationStopsAfterCurrentTurn() {
  setupTest("cancellation stops after current turn");

  const config = JSON.parse(JSON.stringify(MINIMAL_CONFIG));
  config.council.min_distinct_agents = 1;
  config.council.max_turns = 3;

  let engineRef = null;
  let decideCalled = false;
  const scenarios = [
    {
      match: isRoutePrompt,
      response: { ok: true, text: JSON.stringify({ decision: "continue", next_agent: "codex", role: "analyze", reason: "first" }) },
    },
    {
      match: isAgentTurnPrompt,
      response: async () => {
        engineRef.requestCancel("user");
        return { ok: true, text: "Codex analysis after cancel." };
      },
    },
    {
      match: isDecidePrompt,
      response: () => {
        decideCalled = true;
        return { ok: true, text: JSON.stringify({ decision: "continue", next_agent: "claude", role: "challenge", reason: "continue" }) };
      },
    },
    {
      match: isFinalizePrompt,
      response: { ok: true, text: JSON.stringify({ consensus: "cancelled", next_steps: [] }) },
    },
  ];

  const store = new SessionStore(testDir);
  const session = store.createSession("test topic");
  const engine = new CouncilEngine({
    config,
    sessionStore: store,
    runAgent: makeFakeRuntime(scenarios),
    projectRoot: testDir,
    prompts,
    sessionDir: session.dir,
    sessionId: session.id,
  });
  engineRef = engine;
  engine.on("event", (e) => store.appendEvent(session.dir, e));

  const result = await engine.run("test topic");
  const stored = store.readEvents(session.dir);

  assert.equal(decideCalled, false);
  assert.equal(result.outcome, "cancelled");
  assert.ok(stored.some((e) => e.type === EVENTS.SESSION_CANCEL_REQUESTED));

  teardownTest();
  pass();
}
```

- [ ] **步骤 6：运行并确认失败**

运行：

```powershell
cd apps\patchcouncil-ui
npm run smoke
```

预期：失败，因为 `requestCancel` 不存在，且 outcome 不是 `cancelled`。

- [ ] **步骤 7：增加 cancellation 方法和检查点**

增加方法：

```js
requestCancel(reason = "user") {
  if (this.cancelRequested) return null;
  this.cancelRequested = true;
  this.cancelReason = reason;
  return this.emitEvent(events.EVENTS.SESSION_CANCEL_REQUESTED, {
    requested_at: new Date().toISOString(),
    reason,
  });
}
```

在 `run()` 中，每个 awaited model call 边界之后、启动 `decideCoordinator` 之前检查：

```js
if (this.cancelRequested) break;
```

finalize 前，对 cancelled session 跳过 `finalizeCouncil`，直接写简单总结：

```js
if (this.cancelRequested) {
  this.emitEvent(events.EVENTS.FINALIZED, {
    summary: "Session cancelled by host.",
    next_steps: [],
  });
} else {
  await this.finalizeCouncil(topic, context, limits);
}
```

设置 outcome：

```js
const outcome = this.cancelRequested ? "cancelled" : (this.errorCount > 0 ? "error" : "discussion_only");
```

- [ ] **步骤 8：补齐 session_started 配置快照**

现有 `session_started.config` 只写 `config.council`，不足以表达完整启动时配置。把 `session_started` 里的 `config` 字段改为完整快照，至少包含 `council` 和 `agents`：

```js
const sessionConfigSnapshot = {
  council: councilCfg,
  agents: Object.fromEntries(
    Object.entries(agents).map(([id, cfg]) => [
      id,
      {
        command: cfg.command,
        args: cfg.args || [],
        input_mode: cfg.input_mode,
        capabilities: cfg.capabilities || [],
        write_access: Boolean(cfg.write_access),
        timeout_sec: cfg.timeout_sec,
        enabled: cfg.enabled !== false,
        roles: id === selectCoordinator(this.config)?.name ? ["coordinator", "agent"] : ["agent"],
      },
    ])
  ),
};
```

然后 `session_started` 使用：

```js
config: sessionConfigSnapshot,
```

并继续保留顶层 `agents` 数组，方便 UI 和旧 replay 消费。

- [ ] **步骤 9：增加配置快照测试**

在 `council-smoke.js` 中增加断言：运行任意最小 session 后，`session_started.config.council.max_turns` 和 `session_started.config.agents.codex.capabilities` 存在。

示例断言可加到 `testHappyPathSingleAgent`：

```js
const started = events.find((e) => e.type === EVENTS.SESSION_STARTED);
assert.equal(started.config.council.max_turns, 1);
assert.deepStrictEqual(started.config.agents.codex.capabilities, ["plan", "synthesize", "review", "judge"]);
```

- [ ] **步骤 10：运行检查**

运行：

```powershell
cd apps\patchcouncil-ui
npm run check
npm run smoke
```

预期：两个命令都通过。

- [ ] **步骤 11：提交**

```powershell
git add apps/patchcouncil-ui/engine/council.js apps/patchcouncil-ui/scripts/council-smoke.js
git commit -m "feat: add council host controls"
```

## 任务 3：Workbench Server API

**文件：**
- 修改：`apps/patchcouncil-ui/server.js`
- 修改：`apps/patchcouncil-ui/scripts/smoke-test.js`

- [ ] **步骤 1：为 config read 增加失败 HTTP smoke**

在 `scripts/smoke-test.js` 中增加 helper：

```js
async function fetchJson(path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    cache: "no-store",
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}: ${text}`);
  }
  return data;
}
```

server 启动后断言：

```js
const config = await fetchJson("/api/config");
if (!config.council || !config.agents) {
  throw new Error("expected config response with council and agents");
}
```

- [ ] **步骤 2：运行并确认失败**

运行：

```powershell
cd apps\patchcouncil-ui
npm run smoke
```

预期：`/api/config` 返回 404。

- [ ] **步骤 3：实现 GET /api/config**

在 `server.js` 中引入 `loadConfig` 并暴露：

```js
if (pathname === "/api/config" && req.method === "GET") {
  sendJson(res, 200, loadConfig(projectRoot));
  return true;
}
```

如果 `projectRoot` 为空，返回 `500` 和 `{ error: "project root not found" }`。

- [ ] **步骤 4：增加 JSON body parser**

增加：

```js
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body.trim()) return resolve({});
      try { resolve(JSON.parse(body)); } catch (error) { reject(new Error("invalid JSON body")); }
    });
    req.on("error", reject);
  });
}
```

把 `handleApi` 改为 async，并在 POST/PUT routes 中 await body parsing。

- [ ] **步骤 5：为 create session 增加 fake runtime smoke**

为避免 smoke 调真实 CLI，在 smoke test env 中增加：

```js
PATCHCOUNCIL_FAKE_RUNTIME: "1"
```

然后增加：

```js
const created = await fetchJson("/api/sessions", {
  method: "POST",
  body: JSON.stringify({ topic: "smoke workbench topic", mode: "council" }),
});
if (!created.session_id || created.status !== "running") {
  throw new Error("expected running session from POST /api/sessions");
}
```

预期失败：route 还未实现。

- [ ] **步骤 6：实现 active session registry 和 fake runtime**

在 `server.js` 中引入：

```js
const { loadConfig } = require("./engine/config");
const { SessionStore } = require("./engine/session-store");
const { CouncilEngine } = require("./engine/council");
const { JsonlSink, StateSnapshotSink } = require("./engine/event-sink");
const { runCliRuntime } = require("./src/runtime/cli-adapter");
const prompts = require("./engine/prompts");
```

增加：

```js
const activeSessions = new Map();
```

创建 `makeRuntimeRunner(projectRoot, activeSession)`：

- `PATCHCOUNCIL_FAKE_RUNTIME=1` 时返回 fake responses。
- 真实 runtime 时包装 `runCliRuntime`。
- 保存当前 run，供 cancel 调用：

```js
activeSession.currentRun = run;
const result = await run.done;
activeSession.currentRun = null;
```

- [ ] **步骤 7：实现 POST /api/sessions**

行为：

```js
const body = await readJsonBody(req);
const topic = String(body.topic || "").trim();
if (!topic) sendJson(res, 400, { error: "topic is required" });
```

通过 `SessionStore` 创建 session，创建 engine，接上 sinks，把 controller 放进 `activeSessions`，先返回 response，再后台运行 engine：

```js
sendJson(res, 202, { session_id: session.id, status: "running" });
setImmediate(async () => {
  try { await engine.run(topic); }
  finally { activeSessions.delete(session.id); }
});
```

- [ ] **步骤 8：实现 POST /api/sessions/:id/interjections**

在 `activeSessions` 中找 controller。找不到则拒绝：

```js
sendJson(res, 409, { error: "session is not running" });
```

找到后调用：

```js
const event = controller.engine.addInterjection(body.content);
controller.sessionStore.deriveState(controller.sessionDir);
sendJson(res, 202, { event });
```

- [ ] **步骤 9：实现 POST /api/sessions/:id/cancel**

找到 controller 时：

```js
const event = controller.engine.requestCancel("user");
if (controller.currentRun) controller.currentRun.cancel("cancelled by host");
controller.sessionStore.deriveState(controller.sessionDir);
sendJson(res, 202, { session_id: sessionId, status: "cancelling", event });
```

找不到 active session 时：

```js
sendJson(res, 409, { error: "session is not running" });
```

- [ ] **步骤 10：为 interjection 和 cancel 增加 smoke 断言**

create-session response 后增加：

```js
await fetchJson(`/api/sessions/${encodeURIComponent(created.session_id)}/interjections`, {
  method: "POST",
  body: JSON.stringify({ content: "host note from smoke" }),
});
await fetchJson(`/api/sessions/${encodeURIComponent(created.session_id)}/cancel`, {
  method: "POST",
  body: JSON.stringify({}),
});
```

读取 events，并断言两个事件类型都出现。

- [ ] **步骤 11：运行检查**

运行：

```powershell
cd apps\patchcouncil-ui
npm run check
npm run smoke
```

预期：两个命令都通过。

- [ ] **步骤 12：提交**

```powershell
git add apps/patchcouncil-ui/server.js apps/patchcouncil-ui/scripts/smoke-test.js
git commit -m "feat: add workbench server APIs"
```

## 任务 4：Config 写入 API

**文件：**
- 修改：`apps/patchcouncil-ui/engine/config.js`
- 修改：`apps/patchcouncil-ui/server.js`
- 修改：`apps/patchcouncil-ui/scripts/smoke-test.js`

- [ ] **步骤 1：增加 config write 失败 smoke**

在 `scripts/smoke-test.js` 中，`GET /api/config` 后执行：

```js
const updatedConfig = JSON.parse(JSON.stringify(config));
updatedConfig.council.max_turns = 4;
const savedConfig = await fetchJson("/api/config", {
  method: "PUT",
  body: JSON.stringify(updatedConfig),
});
if (savedConfig.council.max_turns !== 4) {
  throw new Error("expected PUT /api/config to persist max_turns");
}
```

预期失败：PUT 尚未实现。

- [ ] **步骤 2：增加 saveConfig helper**

在 `engine/config.js` 中增加：

```js
function saveConfig(config, projectRoot = null) {
  const root = projectRoot || findProjectRoot();
  const aiDir = path.join(root, PROJECT_DIR);
  fs.mkdirSync(aiDir, { recursive: true });
  const configFile = path.join(aiDir, CONFIG_FILE);
  fs.writeFileSync(configFile, yaml.dump(config, { sortKeys: false }), "utf8");
  return loadConfig(root);
}
```

导出 `saveConfig`。

- [ ] **步骤 3：实现 PUT /api/config**

在 `server.js` 中引入 `saveConfig`。route：

```js
if (pathname === "/api/config" && req.method === "PUT") {
  const nextConfig = await readJsonBody(req);
  sendJson(res, 200, saveConfig(nextConfig, projectRoot));
  return true;
}
```

不要修改 active sessions。running sessions 已经在 engine instance 和 `session_started` event 中持有 config snapshot。

- [ ] **步骤 4：smoke 结束时恢复 config**

因为 smoke 会写真实 `.project-ai/config.yaml`，PUT 测试必须用 `try/finally` 恢复：

```js
const originalConfig = config;
try {
  // PUT modified config
} finally {
  await fetchJson("/api/config", { method: "PUT", body: JSON.stringify(originalConfig) });
}
```

- [ ] **步骤 5：运行检查**

运行：

```powershell
cd apps\patchcouncil-ui
npm run check
npm run smoke
```

预期：两个命令通过，并且 `.project-ai/config.yaml` 回到原始内容。

- [ ] **步骤 6：提交**

```powershell
git add apps/patchcouncil-ui/engine/config.js apps/patchcouncil-ui/server.js apps/patchcouncil-ui/scripts/smoke-test.js
git commit -m "feat: add workbench config API"
```

## 任务 5：聊天工作台 UI

**文件：**
- 修改：`apps/patchcouncil-ui/public/index.html`
- 修改：`apps/patchcouncil-ui/public/app.js`
- 修改：`apps/patchcouncil-ui/public/styles.css`
- 修改：`apps/patchcouncil-ui/scripts/smoke-test.js`

- [ ] **步骤 1：增加静态 smoke 失败断言**

在 `scripts/smoke-test.js` 中替换旧 title 断言：

```js
if (!html.includes("PatchCouncil Workbench")) {
  throw new Error("index html did not render workbench title");
}
if (!html.includes("composerInput")) {
  throw new Error("index html missing workbench composer");
}
```

预期失败：现有 HTML 仍是 `PatchCouncil UI Spike`。

- [ ] **步骤 2：更新 HTML 骨架**

把 `index.html` 标题改为：

```html
<title>PatchCouncil Workbench</title>
```

需要包含这些 IDs：

```html
<button id="newCouncilButton" type="button">+ New</button>
<nav id="sessionList" class="session-list" aria-label="Session list"></nav>
<main id="workspace" class="workspace idle">
  <header class="thread-header">
    <p class="eyebrow">Council Thread</p>
    <h2 id="sessionTitle">New Council</h2>
    <div id="phaseBadge" class="phase-badge">idle</div>
  </header>
  <section id="threadBody" class="thread-body"></section>
  <form id="composerForm" class="composer">
    <textarea id="composerInput" placeholder="输入讨论主题..."></textarea>
    <button id="composerButton" class="primary" type="submit">Start Council</button>
  </form>
</main>
<aside class="status-panel">
  <dl id="statusGrid" class="status-grid"></dl>
  <div id="agentList" class="agent-list"></div>
  <p id="latestSignal" class="latest-signal">No events loaded.</p>
  <button id="cancelButton" type="button">Cancel</button>
  <button id="rawEventsButton" type="button">Raw events</button>
  <ol id="rawEvents" class="raw-events hidden"></ol>
</aside>
```

- [ ] **步骤 3：把 timeline projection 改为 chat projection**

在 `app.js` 中引入状态：

```js
let activeSessionId = "";
let activeEvents = [];
let sessions = [];
let pollInterval = null;
let rawEventsVisible = false;
```

增加投影函数：

```js
function projectEvent(event) {
  switch (event.type) {
    case "session_started":
      return { kind: "user", speaker: "Host", text: event.topic };
    case "user_interjection":
      return { kind: "host", speaker: "Host", text: event.content };
    case "agent_turn_completed":
      return { kind: `agent ${event.agent}`, speaker: event.agent, text: event.content };
    case "finalized":
      return { kind: "summary", speaker: "Final", text: `${event.summary}\n\n${(event.next_steps || []).map((s) => `- ${s}`).join("\n")}` };
    case "coordinator_decided":
      return { kind: "system", speaker: "Coordinator", text: `${event.coordinator} -> ${event.decision}${event.next_agent ? ` (${event.next_agent})` : ""}: ${event.reason || ""}` };
    case "policy_override":
      return { kind: "system policy", speaker: "Policy", text: `${event.original_decision} -> ${event.new_decision}: ${event.reason}` };
    case "agent_error":
    case "coordinator_error":
    case "session_error":
      return { kind: "error", speaker: "Error", text: `${event.message}\naction: ${event.action}` };
    default:
      return null;
  }
}
```

主线程只渲染非 null 投影事件。`rawEvents` 渲染所有事件。

- [ ] **步骤 4：实现结束态对话折叠**

增加状态：

```js
let discussionExpanded = false;
```

判断当前 session 是否结束：

```js
function isTerminalSession(session) {
  return session && ["done", "error", "cancelled"].includes(session.status);
}
```

渲染主线程时：

- 如果 session 未结束，正常渲染所有投影消息。
- 如果 session 已结束，先渲染 `finalized` 对应的 summary 卡片。
- 非 summary 消息默认隐藏，只显示一个按钮：`展开完整讨论过程`。
- 点击后切换为 `收起完整讨论过程`，并渲染完整消息流。

示例逻辑：

```js
function visibleProjectedMessages(session, events) {
  const projected = events.map(projectEvent).filter(Boolean);
  if (!isTerminalSession(session) || discussionExpanded) return projected;
  return projected.filter((item) => item.kind === "summary");
}
```

当选择新 session 或 New Council 时，把 `discussionExpanded = false`。

- [ ] **步骤 5：实现 composer 状态**

增加：

```js
function currentSession() {
  return sessions.find((item) => item.session_id === activeSessionId) || null;
}

function composerMode() {
  const session = currentSession();
  if (!session) return "start";
  if (session.status === "running" || session.status === "cancelling") return "interject";
  return "continue";
}
```

mode 映射：

```text
start: "Start Council" / "输入讨论主题..."
interject: "Add note" / "输入插话，下一轮生效..."
continue: "Continue" / "继续讨论..."
```

- [ ] **步骤 6：实现 POST 调用**

增加：

```js
async function postJson(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `${response.status} ${response.statusText}`);
  return data;
}
```

composer submit：

```js
if (mode === "start") {
  const data = await postJson("/api/sessions", { topic: text, mode: "council" });
  activeSessionId = data.session_id;
  await loadSessions();
} else if (mode === "interject") {
  await postJson(`/api/sessions/${encodeURIComponent(activeSessionId)}/interjections`, { content: text });
  await selectSession(activeSessionId);
} else {
  const data = await postJson("/api/sessions", { topic: text, mode: "council", source_session_id: activeSessionId });
  activeSessionId = data.session_id;
  await loadSessions();
}
```

- [ ] **步骤 7：实现 Cancel 和 New 控制**

Cancel：

```js
await postJson(`/api/sessions/${encodeURIComponent(activeSessionId)}/cancel`, {});
await selectSession(activeSessionId);
```

New：

```js
activeSessionId = "";
activeEvents = [];
renderWorkbench();
```

- [ ] **步骤 8：实现 Raw events 开关**

给 `rawEventsButton` 绑定点击事件：

```js
els.rawEventsButton.addEventListener("click", () => {
  rawEventsVisible = !rawEventsVisible;
  renderRawEvents(activeEvents);
});
```

渲染函数：

```js
function renderRawEvents(events) {
  els.rawEvents.classList.toggle("hidden", !rawEventsVisible);
  els.rawEventsButton.textContent = rawEventsVisible ? "Hide raw events" : "Raw events";
  els.rawEvents.replaceChildren(...events.map((event) => {
    const li = document.createElement("li");
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(event, null, 2);
    li.append(pre);
    return li;
  }));
}
```

每次 `activeEvents` 更新后调用 `renderRawEvents(activeEvents)`，确保 raw view 和主线程同步。

- [ ] **步骤 9：更新 CSS**

实现：

```css
.workspace.idle .thread-body { display: grid; place-items: center; }
.thread-body { overflow: auto; }
.message { display: grid; grid-template-columns: 86px minmax(0, 1fr); gap: 12px; }
.message.host { grid-template-columns: minmax(0, 1fr) 86px; }
.message.host .bubble { background: #e7f3eb; border-color: #8eb89c; }
.message.system { display: block; text-align: center; color: var(--muted); font-size: 12px; }
.message.summary .bubble { background: #e8f0f7; border-color: #bdd3e5; }
.raw-events.hidden { display: none; }
.discussion-toggle { justify-self: center; }
```

卡片和控件圆角保持 `8px` 或更小。

- [ ] **步骤 10：运行检查**

运行：

```powershell
cd apps\patchcouncil-ui
npm run check
npm run smoke
```

预期：两个命令都通过。

- [ ] **步骤 11：浏览器验证**

启动 server：

```powershell
cd apps\patchcouncil-ui
npm run start
```

在浏览器打开 `http://127.0.0.1:8765`，验证：

- 空闲态显示居中 topic 输入框。
- 选择 mock/real session 后显示 chat projection。
- 已结束 session 默认只显示总结卡片，点击后能展开完整讨论过程。
- Raw events toggle 能显示完整 event stream。
- 桌面和窄屏下文字不重叠。

- [ ] **步骤 12：提交**

```powershell
git add apps/patchcouncil-ui/public/index.html apps/patchcouncil-ui/public/app.js apps/patchcouncil-ui/public/styles.css apps/patchcouncil-ui/scripts/smoke-test.js
git commit -m "feat: add workbench chat UI"
```

## 任务 6：Config 前端页面

**文件：**
- 新增：`apps/patchcouncil-ui/public/config.html`
- 新增：`apps/patchcouncil-ui/public/config.js`
- 修改：`apps/patchcouncil-ui/public/styles.css`
- 修改：`apps/patchcouncil-ui/package.json`
- 修改：`apps/patchcouncil-ui/scripts/smoke-test.js`

- [ ] **步骤 1：增加静态 smoke 失败断言**

在 `scripts/smoke-test.js` 中读取 `/config.html`：

```js
const configHtml = await fetchText("/config.html");
if (!configHtml.includes("PatchCouncil Config")) {
  throw new Error("config html did not render expected title");
}
if (!configHtml.includes("maxTurnsInput")) {
  throw new Error("config html missing max turns input");
}
```

预期失败：`/config.html` 不存在。

- [ ] **步骤 2：新增最小 config.html**

创建 `apps/patchcouncil-ui/public/config.html`，包含：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>PatchCouncil Config</title>
    <link rel="stylesheet" href="/styles.css">
  </head>
  <body>
    <main class="config-page">
      <header class="config-header">
        <div>
          <p class="eyebrow">Global Defaults</p>
          <h1>PatchCouncil Config</h1>
        </div>
        <a class="button-link" href="/">Back to Workbench</a>
      </header>

      <form id="configForm" class="config-form">
        <section class="config-section">
          <h2>Council</h2>
          <label>Max turns <input id="maxTurnsInput" type="number" min="1" max="20"></label>
          <label>Min distinct agents <input id="minDistinctAgentsInput" type="number" min="1" max="10"></label>
        </section>

        <section class="config-section">
          <h2>Agents</h2>
          <label><input id="codexEnabledInput" type="checkbox"> codex enabled</label>
          <label><input id="claudeEnabledInput" type="checkbox"> claude enabled</label>
        </section>

        <button class="primary" type="submit">Save</button>
        <p id="configStatus" class="latest-signal"></p>
      </form>
    </main>
    <script src="/config.js"></script>
  </body>
</html>
```

- [ ] **步骤 3：新增 config.js**

实现：

```js
const els = {
  form: document.getElementById("configForm"),
  maxTurns: document.getElementById("maxTurnsInput"),
  minDistinctAgents: document.getElementById("minDistinctAgentsInput"),
  codexEnabled: document.getElementById("codexEnabledInput"),
  claudeEnabled: document.getElementById("claudeEnabledInput"),
  status: document.getElementById("configStatus"),
};

let currentConfig = null;

async function requestJson(path, options = {}) {
  const response = await fetch(path, {
    cache: "no-store",
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `${response.status} ${response.statusText}`);
  return data;
}

function renderConfig(config) {
  currentConfig = config;
  els.maxTurns.value = String(config.council?.max_turns ?? 3);
  els.minDistinctAgents.value = String(config.council?.min_distinct_agents ?? 2);
  els.codexEnabled.checked = config.agents?.codex?.enabled !== false;
  els.claudeEnabled.checked = config.agents?.claude?.enabled !== false;
}

function readConfigForm() {
  const next = JSON.parse(JSON.stringify(currentConfig || {}));
  next.council = next.council || {};
  next.agents = next.agents || {};
  next.agents.codex = next.agents.codex || {};
  next.agents.claude = next.agents.claude || {};
  next.council.max_turns = Number(els.maxTurns.value || 3);
  next.council.min_distinct_agents = Number(els.minDistinctAgents.value || 2);
  next.agents.codex.enabled = els.codexEnabled.checked;
  next.agents.claude.enabled = els.claudeEnabled.checked;
  return next;
}

els.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const saved = await requestJson("/api/config", {
      method: "PUT",
      body: JSON.stringify(readConfigForm()),
    });
    renderConfig(saved);
    els.status.textContent = "Saved. Changes apply to new sessions.";
  } catch (error) {
    els.status.textContent = error.message;
  }
});

requestJson("/api/config")
  .then(renderConfig)
  .catch((error) => { els.status.textContent = error.message; });
```

- [ ] **步骤 4：把 config.js 加入语法检查**

在 `package.json` 的 `check` script 中追加：

```text
&& node --check ./public/config.js
```

- [ ] **步骤 5：补 CSS**

在 `styles.css` 中增加最小样式：

```css
.config-page {
  max-width: 860px;
  margin: 0 auto;
  padding: 28px;
}

.config-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 18px;
}

.config-form,
.config-section {
  display: grid;
  gap: 14px;
}

.config-section {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  padding: 16px;
}

.config-section label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.config-section input[type="number"] {
  width: 120px;
}

.button-link {
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 7px 10px;
  color: var(--ink);
  background: #fff;
  text-decoration: none;
}
```

- [ ] **步骤 6：运行检查**

运行：

```powershell
cd apps\patchcouncil-ui
npm run check
npm run smoke
```

预期：两个命令都通过。

- [ ] **步骤 7：提交**

```powershell
git add apps/patchcouncil-ui/public/config.html apps/patchcouncil-ui/public/config.js apps/patchcouncil-ui/public/styles.css apps/patchcouncil-ui/package.json apps/patchcouncil-ui/scripts/smoke-test.js
git commit -m "feat: add workbench config page"
```

## 任务 7：Source Session Metadata

**文件：**
- 修改：`apps/patchcouncil-ui/engine/session-store.js`
- 修改：`apps/patchcouncil-ui/engine/council.js`
- 修改：`apps/patchcouncil-ui/server.js`
- 修改：`apps/patchcouncil-ui/scripts/council-smoke.js`
- 修改：`apps/patchcouncil-ui/scripts/smoke-test.js`

- [ ] **步骤 1：增加 source-summary helper 测试**

在 `council-smoke.js` 中增加测试：覆盖有 `finalized` 的完成 session，以及没有 `finalized` 的 cancelled session。期望 helper 输出：

```js
assert.equal(doneSource.summary, "Final summary");
assert.match(cancelledSource.summary, /Original topic/);
assert.match(cancelledSource.summary, /Agent answer/);
```

- [ ] **步骤 2：实现 source metadata helper**

在 `session-store.js` 中增加：

```js
getSourceMetadata(sessionDir) {
  const allEvents = this.readEvents(sessionDir);
  const started = allEvents.find((e) => e.type === "session_started");
  const finalized = [...allEvents].reverse().find((e) => e.type === "finalized");
  const agentTurns = allEvents.filter((e) => e.type === "agent_turn_completed");
  const summary = finalized?.summary || [
    `Source topic: ${started?.topic || path.basename(sessionDir)}`,
    ...agentTurns.slice(-2).map((e) => `${e.agent}: ${String(e.content || "").slice(0, 500)}`),
  ].join("\n\n");
  return {
    source_session_id: started?.session_id || path.basename(sessionDir),
    source_summary: summary,
    source_transcript_path: path.join(sessionDir, "transcript.jsonl"),
  };
}
```

- [ ] **步骤 3：把 source metadata 传给 engine**

在 `CouncilEngine.constructor` 中增加 `sourceMetadata` option：

```js
this.sourceMetadata = options.sourceMetadata || null;
```

把它写进 `session_started` fields：

```js
...(this.sourceMetadata || {}),
```

- [ ] **步骤 4：在 server POST /api/sessions 中使用 source metadata**

如果 request 有 `source_session_id`：

- 找到对应真实 session dir。
- 调用 `sessionStore.getSourceMetadata(sourceDir)`。
- 把结果传给 engine。
- 找不到 source session 时返回 404。

- [ ] **步骤 5：把 source summary 放进初始 context**

在 `CouncilEngine.run` 中，`context` 收集后追加 source summary：

```js
const sourceContext = this.sourceMetadata
  ? `### Source session\n\n${this.sourceMetadata.source_summary}\n\nTranscript: ${this.sourceMetadata.source_transcript_path}`
  : "";
const contextWithSource = [sourceContext, context].filter(Boolean).join("\n\n");
```

后续 prompts 使用 `contextWithSource`。

- [ ] **步骤 6：运行检查**

运行：

```powershell
cd apps\patchcouncil-ui
npm run check
npm run smoke
```

预期：两个命令都通过。

- [ ] **步骤 7：提交**

```powershell
git add apps/patchcouncil-ui/engine/session-store.js apps/patchcouncil-ui/engine/council.js apps/patchcouncil-ui/server.js apps/patchcouncil-ui/scripts/council-smoke.js apps/patchcouncil-ui/scripts/smoke-test.js
git commit -m "feat: add session continuation metadata"
```

## 任务 8：文档和 Python 退场说明

**文件：**
- 修改：`README.md`
- 修改：`apps/patchcouncil-ui/README.md`
- 修改：`docs/ROADMAP.md`
- 修改：`docs/AI_CONTEXT.md`

- [ ] **步骤 1：更新 README 产品入口**

说明活跃入口是：

```text
cd apps/patchcouncil-ui
npm run start
open http://127.0.0.1:8765
```

说明用户从 Web UI 创建和控制 sessions。Node CLI 只保留为开发/调试入口。

- [ ] **步骤 2：标记 Python 为参考原型**

在 README 和 AI_CONTEXT 中写明：

```text
src/aictl/ 是历史 Python 原型/参考实现，不再承接 Workbench v1 新功能。
```

- [ ] **步骤 3：更新 roadmap**

把 Workbench v1 标记为当前重点：设计已完成，实现任务进行中。

- [ ] **步骤 4：运行 docs-safe 检查**

运行：

```powershell
cd apps\patchcouncil-ui
npm run check
```

预期：JS 语法检查仍然通过。

- [ ] **步骤 5：提交**

```powershell
git add README.md apps/patchcouncil-ui/README.md docs/ROADMAP.md docs/AI_CONTEXT.md
git commit -m "docs: document workbench entry point"
```

## 最终验证

- [ ] **运行完整 Node 验证**

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

- [ ] **手动 UI 验证**

启动：

```powershell
cd apps\patchcouncil-ui
npm run start
```

在 `http://127.0.0.1:8765` 验证：

- New Council 空闲态。
- Start Council 可以通过 fake runtime 路径验证。
- Running session 可以 Add note。
- Cancel 会进入 cancelling/cancelled。
- Completed session 的 Continue 会创建新的 source-linked session。
- Raw events view 能显示完整事件日志。

- [ ] **最终状态检查**

```powershell
git status --short
```

预期：只剩有意保留的本地未跟踪产物；如果清理过，则工作区干净。
