# Agent Turn Signal v1 实现计划

> **给 agentic workers：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 按任务逐步执行本计划。步骤使用 checkbox（`- [ ]`）语法追踪进度。

**目标：** 为 council 的每轮 agent 发言增加结构化 signal，并用 finalize gate 防止 coordinator 过早收束。

**架构：** 不新增事件类型，扩展现有 `agent_turn_completed`：`content` 保存展示用 `analysis`，`signal` 保存结构化判断。Coordinator 仍负责路由和提议 finalize，engine policy 在接受 finalize 前读取 latest signal per distinct agent 做客观门禁。旧 session 没有 signal 时仍可读取和展示。

**技术栈：** Node.js CommonJS、现有 `CouncilEngine`、JSONL event log、vanilla JS Workbench、`npm run check`、`npm run smoke`。

---

## 规格来源

实现以下设计：

```text
docs/superpowers/specs/2026-06-01-agent-turn-signal-v1-design.md
```

固定规则：

- agent turn 输出 strict JSON。
- `agent_turn_completed.content` 保存 `analysis`。
- `agent_turn_completed.signal` 保存 `stance/confidence/finalize_readiness/blockers/agreements/disagreements/recommended_next_step`。
- JSON 解析失败时生成 fallback signal，且该 fallback signal 必须阻止 finalize。
- finalize gate 使用 latest signal per distinct agent。
- `confidence` v1 不参与 gate，只用于 UI/transcript/分析。
- 首轮 route 在有多个 enabled agent 时优先选择非 coordinator agent。
- 连续 gate override 达到 `finalize_gate_max_overrides` 且没有未发言 agent 时 fallback finalize。

## 文件边界

- 修改 `apps/patchcouncil-ui/engine/events.js`
  - 扩展 `agentTurnCompleted()` 签名，支持可选 `signal` 和 `signal_parse_error`。
- 修改 `apps/patchcouncil-ui/engine/council.js`
  - 增加 agent signal parser / validator / fallback。
  - `runAgentTurn()` 解析 JSON，落 `content + signal`。
  - 增加 finalize gate、gate override 计数、防卡死 fallback。
  - route 后首轮优先避免 coordinator 自己作为发言 agent。
- 修改 `apps/patchcouncil-ui/engine/prompts/council_agent_turn.md`
  - 改为 strict JSON signal 输出 prompt。
- 修改 `apps/patchcouncil-ui/engine/session-store.js`
  - `transcript.md` 渲染 stance/confidence/readiness/first blocker。
- 修改 `apps/patchcouncil-ui/engine/event-sink.js`
  - CLI 输出 agent signal 概要。
- 修改 `apps/patchcouncil-ui/public/app.js`
  - agent bubble 展示 `analysis`，同时显示轻量 signal meta。
  - signal parse error 显示系统提示。
- 修改 `apps/patchcouncil-ui/scripts/council-smoke.js`
  - 覆盖 parser、fallback、finalize gate、防卡死、首轮非 coordinator。
- 修改 `apps/patchcouncil-ui/scripts/smoke-test.js`
  - fake runtime 输出合法 agent signal JSON。
- 修改 `docs/COUNCIL_EVENTS.md`
  - 更新 `agent_turn_completed` schema。
- 修改 `docs/AI_CONTEXT.md` / `docs/ARCHITECTURE.md`
  - 简短记录 agent signal 和 finalize gate。

## 任务 1：Signal Parser 和事件字段

**文件：**
- 修改：`apps/patchcouncil-ui/engine/events.js`
- 修改：`apps/patchcouncil-ui/engine/council.js`
- 测试：`apps/patchcouncil-ui/scripts/council-smoke.js`

- [ ] **步骤 1：写 parser 失败测试**

在 `apps/patchcouncil-ui/scripts/council-smoke.js` 的 import 中加入：

```js
const {
  CouncilEngine,
  parseJsonDecision,
  parseAgentTurnSignal,
  fallbackAgentSignal,
} = require("../engine/council");
```

如果当前文件已有 `CouncilEngine` import，把它替换为上面的解构 import。

新增测试：

```js
async function testAgentTurnSignalParser() {
  setupTest("agent turn signal parser");

  const raw = JSON.stringify({
    stance: "mixed",
    confidence: "medium",
    finalize_readiness: "not_ready",
    blockers: [{ type: "question", text: "Need user confirmation." }],
    agreements: ["Keep discussion read-only."],
    disagreements: ["Do not finalize yet."],
    recommended_next_step: "Ask another agent to respond.",
    analysis: "The direction is plausible, but one blocking question remains.",
  });

  const parsed = parseAgentTurnSignal(raw);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.content, "The direction is plausible, but one blocking question remains.");
  assert.equal(parsed.signal.stance, "mixed");
  assert.equal(parsed.signal.finalize_readiness, "not_ready");
  assert.equal(parsed.signal.blockers[0].text, "Need user confirmation.");

  const fenced = parseAgentTurnSignal("```json\n" + raw + "\n```");
  assert.equal(fenced.ok, true);
  assert.equal(fenced.signal.confidence, "medium");

  const invalid = parseAgentTurnSignal("not json");
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /parse/i);

  teardownTest();
  pass();
}
```

在 `main()` 中、engine 行为测试前调用：

```js
await testAgentTurnSignalParser();
```

- [ ] **步骤 2：写 fallback 失败测试**

继续在 `council-smoke.js` 增加：

```js
async function testFallbackAgentSignalBlocksFinalize() {
  setupTest("fallback agent signal blocks finalize");

  const fallback = fallbackAgentSignal();
  assert.equal(fallback.stance, "mixed");
  assert.equal(fallback.confidence, "low");
  assert.equal(fallback.finalize_readiness, "not_ready");
  assert.equal(fallback.blockers.length, 1);
  assert.match(fallback.blockers[0].text, /parseable/);

  teardownTest();
  pass();
}
```

在 `testAgentTurnSignalParser()` 后调用。

- [ ] **步骤 3：运行测试确认失败**

```powershell
cd apps\patchcouncil-ui
npm run smoke
```

预期：`parseAgentTurnSignal` / `fallbackAgentSignal` 未导出。

- [ ] **步骤 4：实现 parser 和 fallback**

在 `apps/patchcouncil-ui/engine/council.js` 中，放在 `parseJsonDecision()` 后面：

```js
const STANCES = new Set(["agree", "disagree", "mixed"]);
const CONFIDENCES = new Set(["low", "medium", "high"]);
const READINESS = new Set(["ready", "not_ready"]);
const BLOCKER_TYPES = new Set(["issue", "question"]);

function normalizeStringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function fallbackAgentSignal() {
  return {
    stance: "mixed",
    confidence: "low",
    finalize_readiness: "not_ready",
    blockers: [{
      type: "issue",
      text: "Agent response did not provide a parseable deliberation signal.",
    }],
    agreements: [],
    disagreements: [],
    recommended_next_step: "Continue discussion with a parseable structured response.",
  };
}

function parseAgentTurnSignal(raw) {
  const text = String(raw || "").trim();
  if (!text) return { ok: false, error: "empty agent signal response" };

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenceMatch) {
      try { parsed = JSON.parse(fenceMatch[1].trim()); } catch (_) { parsed = null; }
    }
    if (!parsed) {
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start !== -1 && end > start) {
        try { parsed = JSON.parse(text.slice(start, end + 1)); } catch (_) { parsed = null; }
      }
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "failed to parse agent turn signal JSON" };
  }

  if (!STANCES.has(parsed.stance)) return { ok: false, error: "invalid signal.stance" };
  if (!CONFIDENCES.has(parsed.confidence)) return { ok: false, error: "invalid signal.confidence" };
  if (!READINESS.has(parsed.finalize_readiness)) return { ok: false, error: "invalid signal.finalize_readiness" };
  if (typeof parsed.analysis !== "string" || !parsed.analysis.trim()) {
    return { ok: false, error: "signal.analysis is required" };
  }

  const blockers = Array.isArray(parsed.blockers) ? parsed.blockers.map((item) => ({
    type: BLOCKER_TYPES.has(item?.type) ? item.type : "issue",
    text: typeof item?.text === "string" ? item.text : "",
  })).filter((item) => item.text.trim()) : [];

  const signal = {
    stance: parsed.stance,
    confidence: parsed.confidence,
    finalize_readiness: parsed.finalize_readiness,
    blockers,
    agreements: normalizeStringArray(parsed.agreements),
    disagreements: normalizeStringArray(parsed.disagreements),
    recommended_next_step: typeof parsed.recommended_next_step === "string" ? parsed.recommended_next_step : "",
  };

  return { ok: true, content: parsed.analysis, signal };
}
```

在 `module.exports` 中加入：

```js
parseAgentTurnSignal,
fallbackAgentSignal,
```

- [ ] **步骤 5：扩展事件构造函数**

修改 `apps/patchcouncil-ui/engine/events.js` 中 `agentTurnCompleted` 签名：

```js
function agentTurnCompleted(sessionId, seq, phase, turn, agent, content, contentLength, durationMs, signal, signalParseError) {
  const event = Object.assign(baseEvent(sessionId, seq, EVENTS.AGENT_TURN_COMPLETED, phase), {
    turn, agent, content, content_length: contentLength, duration_ms: durationMs,
  });
  if (signal) event.signal = signal;
  if (signalParseError) event.signal_parse_error = signalParseError;
  return event;
}
```

当前 engine 直接用 `emitEvent()` 构造事件，不一定调用该 helper；仍要同步签名，保证事件模型文档和 helper 一致。

- [ ] **步骤 6：运行检查**

```powershell
cd apps\patchcouncil-ui
npm run check
npm run smoke
```

预期：两个命令都通过。

- [ ] **步骤 7：提交**

```powershell
git add apps/patchcouncil-ui/engine/council.js apps/patchcouncil-ui/engine/events.js apps/patchcouncil-ui/scripts/council-smoke.js
git commit -m "feat: parse agent turn signals"
```

## 任务 2：Agent Turn 输出 strict JSON 并落 signal

**文件：**
- 修改：`apps/patchcouncil-ui/engine/prompts/council_agent_turn.md`
- 修改：`apps/patchcouncil-ui/engine/council.js`
- 修改：`apps/patchcouncil-ui/scripts/council-smoke.js`

- [ ] **步骤 1：写 prompt 失败测试**

在 `council-smoke.js` 增加：

```js
async function testAgentTurnPromptRequiresSignalJson() {
  setupTest("agent turn prompt requires signal JSON");

  const rendered = prompts.renderPrompt("council_agent_turn.md", {
    agent_name: "claude",
    turn_role: "challenge",
    topic: "topic",
    context: "context",
    transcript: "transcript",
  });

  assert.match(rendered, /strict JSON|严格 JSON/i);
  assert.match(rendered, /finalize_readiness/);
  assert.match(rendered, /blockers/);
  assert.match(rendered, /analysis/);
  assert.doesNotMatch(rendered, /## View/);

  teardownTest();
  pass();
}
```

在 prompt/parse 类测试附近调用。

- [ ] **步骤 2：写 agent turn 落 signal 失败测试**

新增：

```js
async function testAgentTurnCompletedStoresSignal() {
  setupTest("agent turn completed stores signal");

  const config = JSON.parse(JSON.stringify(MINIMAL_CONFIG));
  config.council.min_distinct_agents = 1;
  config.council.max_turns = 1;

  const agentPayload = {
    stance: "agree",
    confidence: "high",
    finalize_readiness: "ready",
    blockers: [],
    agreements: ["The plan is bounded."],
    disagreements: [],
    recommended_next_step: "Finalize.",
    analysis: "I agree with the bounded plan.",
  };

  const scenarios = [
    {
      match: isRoutePrompt,
      response: { ok: true, text: JSON.stringify({ decision: "continue", next_agent: "codex", role: "analyze", reason: "first" }) },
    },
    {
      match: isAgentTurnPrompt,
      response: { ok: true, text: JSON.stringify(agentPayload) },
    },
    {
      match: isFinalizePrompt,
      response: { ok: true, text: JSON.stringify({ consensus: "Done", next_steps: ["ship"] }) },
    },
  ];

  const { events } = await runEngine(config, scenarios);
  const completed = events.find((e) => e.type === EVENTS.AGENT_TURN_COMPLETED);

  assert.equal(completed.content, agentPayload.analysis);
  assert.equal(completed.signal.stance, "agree");
  assert.equal(completed.signal.confidence, "high");
  assert.equal(completed.signal.finalize_readiness, "ready");

  teardownTest();
  pass();
}
```

- [ ] **步骤 3：运行测试确认失败**

```powershell
cd apps\patchcouncil-ui
npm run smoke
```

预期：prompt 仍是 Markdown 章节，或者 `agent_turn_completed.signal` 缺失。

- [ ] **步骤 4：更新 agent prompt**

替换 `apps/patchcouncil-ui/engine/prompts/council_agent_turn.md` 内容：

```markdown
你是多 agent council 的参与者。

当前阶段只讨论，不编辑文件，不执行命令。

你的任务是根据 coordinator 指定的角色发表观点，并输出一个严格 JSON 对象。不要输出 Markdown 代码块，不要输出 JSON 之外的文字。

你的名字：
{{ agent_name }}

本轮角色：
{{ turn_role }}

用户主题：
{{ topic }}

项目上下文：
{{ context }}

当前 transcript：
{{ transcript }}

`analysis` 是给用户阅读的自然语言发言，必须有实质内容。
`stance` 只表达你对当前方向的立场。
`finalize_readiness` 表达你是否认为当前讨论已经可以收束。
你可以同意方向，但仍认为不能收束：此时使用 `"stance": "agree"` 和 `"finalize_readiness": "not_ready"`。

`blockers` 只放不解决就不应 finalize 的问题。非阻塞注意事项写进 `analysis` 或 `recommended_next_step`。
不要为了礼貌写 agree。如果只有部分同意，使用 mixed。

请只返回如下 JSON：

{
  "stance": "agree | disagree | mixed",
  "confidence": "low | medium | high",
  "finalize_readiness": "ready | not_ready",
  "blockers": [
    { "type": "issue | question", "text": "string" }
  ],
  "agreements": ["string"],
  "disagreements": ["string"],
  "recommended_next_step": "string",
  "analysis": "markdown string"
}
```

- [ ] **步骤 5：解析 agent 输出并落 signal**

在 `CouncilEngine.runAgentTurn()` 中替换成功分支：

```js
const parsedSignal = parseAgentTurnSignal(result.text || "");
let content = result.text || "";
let signal = null;
let signalParseError = null;

if (parsedSignal.ok) {
  content = parsedSignal.content;
  signal = parsedSignal.signal;
} else {
  signal = fallbackAgentSignal();
  signalParseError = parsedSignal.error;
}

this.emitEvent(events.EVENTS.AGENT_TURN_COMPLETED, {
  turn: turnNum,
  agent: agentName,
  content,
  content_length: content.length,
  duration_ms: durationMs,
  signal,
  ...(signalParseError ? { signal_parse_error: signalParseError } : {}),
});
```

- [ ] **步骤 6：运行检查**

```powershell
cd apps\patchcouncil-ui
npm run check
npm run smoke
```

预期：两个命令都通过。现有测试中如果 fake agent 仍返回纯文本，需要把对应 scenario 的 agent response 改成合法 signal JSON，或在预期中接受 fallback signal。

- [ ] **步骤 7：提交**

```powershell
git add apps/patchcouncil-ui/engine/prompts/council_agent_turn.md apps/patchcouncil-ui/engine/council.js apps/patchcouncil-ui/scripts/council-smoke.js
git commit -m "feat: store agent turn signals"
```

## 任务 3：Finalize Gate v1

**文件：**
- 修改：`apps/patchcouncil-ui/engine/council.js`
- 修改：`apps/patchcouncil-ui/scripts/council-smoke.js`

- [ ] **步骤 1：写 gate helper 失败测试**

在 `council-smoke.js` import 中加入：

```js
const {
  shouldAllowFinalize,
  latestSignalsByAgent,
} = require("../engine/council");
```

如果已经从 `../engine/council` 解构 import，把这些名字合并进去。

新增：

```js
async function testFinalizeGateBlocksBlockers() {
  setupTest("finalize gate blocks blockers");

  const log = [
    { type: EVENTS.AGENT_TURN_COMPLETED, agent: "codex", signal: { stance: "agree", confidence: "high", finalize_readiness: "ready", blockers: [], agreements: [], disagreements: [], recommended_next_step: "finalize" } },
    { type: EVENTS.AGENT_TURN_COMPLETED, agent: "claude", signal: { stance: "mixed", confidence: "medium", finalize_readiness: "not_ready", blockers: [{ type: "question", text: "Need confirmation." }], agreements: [], disagreements: [], recommended_next_step: "continue" } },
  ];

  const latest = latestSignalsByAgent(log);
  assert.equal(latest.length, 2);

  const result = shouldAllowFinalize(log, { minDistinctAgents: 2 });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /Need confirmation/);

  teardownTest();
  pass();
}
```

新增：

```js
async function testFinalizeGateAllowsReadyDisagreement() {
  setupTest("finalize gate allows ready disagreement");

  const log = [
    { type: EVENTS.AGENT_TURN_COMPLETED, agent: "codex", signal: { stance: "agree", confidence: "high", finalize_readiness: "ready", blockers: [], agreements: [], disagreements: [], recommended_next_step: "finalize" } },
    { type: EVENTS.AGENT_TURN_COMPLETED, agent: "claude", signal: { stance: "disagree", confidence: "medium", finalize_readiness: "ready", blockers: [], agreements: [], disagreements: ["Prefer smaller v1."], recommended_next_step: "finalize with disagreement" } },
  ];

  const result = shouldAllowFinalize(log, { minDistinctAgents: 2 });
  assert.equal(result.allowed, true);

  teardownTest();
  pass();
}
```

新增：

```js
async function testFinalizeGateBlocksAllNotReady() {
  setupTest("finalize gate blocks all not ready");

  const log = [
    { type: EVENTS.AGENT_TURN_COMPLETED, agent: "codex", signal: { stance: "agree", confidence: "low", finalize_readiness: "not_ready", blockers: [], agreements: [], disagreements: [], recommended_next_step: "continue" } },
    { type: EVENTS.AGENT_TURN_COMPLETED, agent: "claude", signal: { stance: "mixed", confidence: "low", finalize_readiness: "not_ready", blockers: [], agreements: [], disagreements: [], recommended_next_step: "continue" } },
  ];

  const result = shouldAllowFinalize(log, { minDistinctAgents: 2 });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /not_ready/);

  teardownTest();
  pass();
}
```

在 parser 测试后调用。

- [ ] **步骤 2：运行测试确认失败**

```powershell
cd apps\patchcouncil-ui
npm run smoke
```

预期：`shouldAllowFinalize` / `latestSignalsByAgent` 未导出。

- [ ] **步骤 3：实现 latest signal 和 gate helper**

在 `council.js` 中加入：

```js
function latestSignalsByAgent(eventLog) {
  const byAgent = new Map();
  for (const event of eventLog) {
    if (event.type === events.EVENTS.AGENT_TURN_COMPLETED && event.agent && event.signal) {
      byAgent.set(event.agent, { agent: event.agent, turn: event.turn, signal: event.signal });
    }
  }
  return [...byAgent.values()];
}

function firstBlockerText(signal) {
  const blocker = Array.isArray(signal?.blockers) ? signal.blockers.find((item) => item && item.text) : null;
  return blocker ? blocker.text : "";
}

function shouldAllowFinalize(eventLog, options) {
  const minDistinctAgents = options.minDistinctAgents || 1;
  const latest = latestSignalsByAgent(eventLog);
  if (latest.length < minDistinctAgents) {
    return { allowed: false, reason: `min_distinct_agents=${minDistinctAgents} not satisfied` };
  }

  for (const item of latest) {
    const blocker = firstBlockerText(item.signal);
    if (blocker) return { allowed: false, reason: `blocker remains: ${blocker}` };
  }

  if (latest.length > 0 && latest.every((item) => item.signal.finalize_readiness === "not_ready")) {
    return { allowed: false, reason: "all latest signals are finalize_readiness=not_ready" };
  }

  const notReadyDisagree = latest.find((item) =>
    item.signal.stance === "disagree" && item.signal.finalize_readiness === "not_ready"
  );
  if (notReadyDisagree) {
    return { allowed: false, reason: `${notReadyDisagree.agent} disagrees and is not ready to finalize` };
  }

  return { allowed: true, reason: "finalize gate passed" };
}
```

导出：

```js
latestSignalsByAgent,
shouldAllowFinalize,
```

- [ ] **步骤 4：接入 decision loop**

在 `CouncilEngine.constructor` 增加：

```js
this.finalizeGateOverrideCount = 0;
```

在 `run()` 中，`enforceMinDistinctAgents()` 之后、赋值 `decision = enforced` 附近，加入 finalize gate 检查。推荐把策略封装成方法：

```js
applyFinalizeGate(decision, agents, minDistinctAgents, maxTurns) {
  if (!decision || decision.decision !== "finalize") return decision;
  if (this.turnCount >= maxTurns) return decision;

  const gate = shouldAllowFinalize(this.eventLog, { minDistinctAgents });
  if (gate.allowed) return decision;

  const nextAgent = this.selectPolicyContinuationAgent(agents);
  if (!nextAgent) return decision;

  this.finalizeGateOverrideCount++;
  this.emitEvent(events.EVENTS.POLICY_OVERRIDE, {
    turn: this.turnCount,
    policy: "finalize_gate",
    original_decision: "finalize",
    new_decision: "continue",
    selected_agent: nextAgent,
    reason: gate.reason,
  });

  return {
    decision: "continue",
    next_agent: nextAgent,
    role: "Respond to unresolved blockers and assess whether the council can finalize.",
    reason: gate.reason,
  };
}
```

在 loop 中调用：

```js
decision = this.applyFinalizeGate(decision, agents, minDistinctAgents, maxTurns);
```

确保调用顺序：

```text
coordinator decide
-> min_distinct_agents policy
-> finalize_gate policy
-> 下一轮 agent
```

- [ ] **步骤 5：实现 policy continuation agent 选择**

在 `CouncilEngine` 类中加入：

```js
selectPolicyContinuationAgent(agents) {
  for (const name of Object.keys(agents)) {
    if (!this.spokenAgents.has(name)) return name;
  }
  const coordinator = selectCoordinator(this.config);
  for (const name of Object.keys(agents)) {
    if (name !== coordinator?.name) return name;
  }
  return Object.keys(agents)[0] || null;
}
```

- [ ] **步骤 6：写 finalize brief 携带 signal 的失败测试**

这一步保证 final summary prompt 能看到结构化分歧，而不是只能从自然语言 `content` 里猜。

在 `council-smoke.js` 新增：

```js
async function testFinalizePromptReceivesSignalSummary() {
  setupTest("finalize prompt receives signal summary");

  const config = JSON.parse(JSON.stringify(MINIMAL_CONFIG));
  config.council.min_distinct_agents = 2;
  config.council.max_turns = 2;

  const firstPayload = {
    stance: "agree",
    confidence: "high",
    finalize_readiness: "ready",
    blockers: [],
    agreements: ["The implementation path is bounded."],
    disagreements: [],
    recommended_next_step: "Ask for a second view.",
    analysis: "The implementation path is bounded.",
  };

  const secondPayload = {
    stance: "disagree",
    confidence: "medium",
    finalize_readiness: "ready",
    blockers: [],
    agreements: [],
    disagreements: ["Prefer a smaller v1 before UI changes."],
    recommended_next_step: "Finalize while recording the disagreement.",
    analysis: "I can finalize, but I prefer a smaller v1.",
  };

  let agentCalls = 0;
  const scenarios = [
    { match: isRoutePrompt, response: { ok: true, text: JSON.stringify({ decision: "continue", next_agent: "codex", role: "analyze", reason: "first" }) } },
    { match: isAgentTurnPrompt, response: () => ({ ok: true, text: JSON.stringify(agentCalls++ === 0 ? firstPayload : secondPayload) }) },
    { match: isDecidePrompt, response: { ok: true, text: JSON.stringify({ decision: "finalize", next_agent: null, role: null, reason: "ready" }) } },
    {
      match: isFinalizePrompt,
      response: (prompt) => {
        assert.match(prompt, /Signal:/);
        assert.match(prompt, /disagree/);
        assert.match(prompt, /Prefer a smaller v1 before UI changes/);
        return { ok: true, text: JSON.stringify({ consensus: "Ready with recorded disagreement.", next_steps: [] }) };
      },
    },
  ];

  await runEngine(config, scenarios);

  teardownTest();
  pass();
}
```

在 gate helper 测试后调用。

- [ ] **步骤 7：在 buildBrief 中加入 signal summary**

在 `council.js` 中加入 helper：

```js
function formatSignalForBrief(signal) {
  if (!signal) return "";
  const parts = [
    `stance=${signal.stance || "unknown"}`,
    `confidence=${signal.confidence || "unknown"}`,
    `readiness=${signal.finalize_readiness || "unknown"}`,
  ];
  const blockers = Array.isArray(signal.blockers) ? signal.blockers.map((item) => item.text).filter(Boolean) : [];
  const agreements = Array.isArray(signal.agreements) ? signal.agreements.filter(Boolean) : [];
  const disagreements = Array.isArray(signal.disagreements) ? signal.disagreements.filter(Boolean) : [];
  if (blockers.length) parts.push(`blockers=${blockers.join(" | ")}`);
  if (agreements.length) parts.push(`agreements=${agreements.join(" | ")}`);
  if (disagreements.length) parts.push(`disagreements=${disagreements.join(" | ")}`);
  if (signal.recommended_next_step) parts.push(`recommended_next_step=${signal.recommended_next_step}`);
  return parts.join("; ");
}
```

在 `buildBrief()` 的 `agent_turn_completed` 分支中改成：

```js
if (event.type === "agent_turn_completed") {
  const signalSummary = formatSignalForBrief(event.signal);
  const signalBlock = signalSummary ? `\n\nSignal: ${signalSummary}` : "";
  messages.push(`### ${event.agent} (turn ${event.turn})\n\n${clipText(event.content, limits.maxMessageChars)}${signalBlock}`);
}
```

这样 `council_finalize.md` 收到的 transcript 明确包含 ready disagreement、blockers 和 recommended next step。最终 summary prompt 不需要重新解析 agent 的 JSON 原文。

- [ ] **步骤 8：写集成测试：blocker 阻止 finalize**

在 `council-smoke.js` 新增：

```js
async function testFinalizeGatePolicyOverrideForBlocker() {
  setupTest("finalize gate policy override for blocker");

  const config = JSON.parse(JSON.stringify(MINIMAL_CONFIG));
  config.council.min_distinct_agents = 1;
  config.council.max_turns = 2;

  const blockerPayload = {
    stance: "agree",
    confidence: "medium",
    finalize_readiness: "not_ready",
    blockers: [{ type: "question", text: "Need one more view." }],
    agreements: [],
    disagreements: [],
    recommended_next_step: "continue",
    analysis: "I agree, but one more view is needed.",
  };

  const readyPayload = {
    stance: "agree",
    confidence: "high",
    finalize_readiness: "ready",
    blockers: [],
    agreements: [],
    disagreements: [],
    recommended_next_step: "finalize",
    analysis: "The blocker is resolved.",
  };

  let agentCalls = 0;
  const scenarios = [
    { match: isRoutePrompt, response: { ok: true, text: JSON.stringify({ decision: "continue", next_agent: "codex", role: "analyze", reason: "first" }) } },
    { match: isAgentTurnPrompt, response: () => ({ ok: true, text: JSON.stringify(agentCalls++ === 0 ? blockerPayload : readyPayload) }) },
    { match: isDecidePrompt, response: { ok: true, text: JSON.stringify({ decision: "finalize", next_agent: null, role: null, reason: "done" }) } },
    { match: isFinalizePrompt, response: { ok: true, text: JSON.stringify({ consensus: "ok", next_steps: [] }) } },
  ];

  const { events, result } = await runEngine(config, scenarios);
  assert.ok(events.some((e) => e.type === EVENTS.POLICY_OVERRIDE && e.policy === "finalize_gate"));
  assert.equal(result.turnCount, 2);

  teardownTest();
  pass();
}
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
git add apps/patchcouncil-ui/engine/council.js apps/patchcouncil-ui/scripts/council-smoke.js
git commit -m "feat: gate council finalization with agent signals"
```

## 任务 4：防卡死 fallback finalize

**文件：**
- 修改：`apps/patchcouncil-ui/engine/config.js`
- 修改：`apps/patchcouncil-ui/engine/council.js`
- 修改：`apps/patchcouncil-ui/scripts/council-smoke.js`

- [ ] **步骤 1：写默认配置失败测试**

在 `council-smoke.js` 中，任意配置快照测试处加入断言：

```js
assert.equal(started.config.council.finalize_gate_max_overrides, 2);
```

如果当前 `session_started.config.council` 只复制用户配置，需要先在 config defaults 中补默认值。

- [ ] **步骤 2：更新默认配置**

在 `apps/patchcouncil-ui/engine/config.js` 的默认 `council` 中加入：

```js
finalize_gate_max_overrides: 2,
```

- [ ] **步骤 3：实现 fallback 判断**

在 `CouncilEngine.applyFinalizeGate()` 中，gate 拒绝后、选择 next agent 前加入：

```js
const maxOverrides = this.config.council?.finalize_gate_max_overrides ?? 2;
const hasUnspokenAgent = Object.keys(agents).some((name) => !this.spokenAgents.has(name));
if (this.finalizeGateOverrideCount >= maxOverrides && !hasUnspokenAgent) {
  this.emitEvent(events.EVENTS.POLICY_OVERRIDE, {
    turn: this.turnCount,
    policy: "finalize_gate_fallback",
    original_decision: "finalize",
    new_decision: "finalize",
    selected_agent: null,
    reason: `fallback finalize after ${maxOverrides} finalize_gate overrides; unresolved: ${gate.reason}`,
  });
  return decision;
}
```

注意：`finalizeGateOverrideCount` 在真正 override 为 continue 时递增。这里的判断使用“已经发生过的 override 次数”，到达阈值后允许本次 finalize。

- [ ] **步骤 4：让 final summary 能看到 unresolved blockers**

不新增事件字段。因为 fallback 会写入 `policy_override`，后续 `finalizeCouncil()` 的 `buildBrief()` 会包含 recent policy override。确保 `buildBrief()` 已保留 `policy_override` 内容；当前已有：

```js
messages.push(`### Policy override: ${event.policy}\n${event.original_decision} → ${event.new_decision}\nReason: ${event.reason}`);
```

如果箭头字符不适合当前文件编码，保持已有写法即可。

- [ ] **步骤 5：写 fallback 集成测试**

新增：

```js
async function testFinalizeGateFallbackAfterMaxOverrides() {
  setupTest("finalize gate fallback after max overrides");

  const config = JSON.parse(JSON.stringify(MINIMAL_CONFIG));
  config.council.min_distinct_agents = 1;
  config.council.max_turns = 4;
  config.council.finalize_gate_max_overrides = 1;

  const blockerPayload = {
    stance: "agree",
    confidence: "low",
    finalize_readiness: "not_ready",
    blockers: [{ type: "question", text: "Need user input." }],
    agreements: [],
    disagreements: [],
    recommended_next_step: "ask user",
    analysis: "This needs user input.",
  };

  const scenarios = [
    { match: isRoutePrompt, response: { ok: true, text: JSON.stringify({ decision: "continue", next_agent: "codex", role: "analyze", reason: "first" }) } },
    { match: isAgentTurnPrompt, response: { ok: true, text: JSON.stringify(blockerPayload) } },
    { match: isDecidePrompt, response: { ok: true, text: JSON.stringify({ decision: "finalize", next_agent: null, role: null, reason: "done" }) } },
    { match: isFinalizePrompt, response: { ok: true, text: JSON.stringify({ consensus: "Fallback with unresolved blockers", next_steps: ["Need user input."] }) } },
  ];

  const { events, result } = await runEngine(config, scenarios);
  assert.ok(events.some((e) => e.type === EVENTS.POLICY_OVERRIDE && e.policy === "finalize_gate_fallback"));
  assert.equal(result.outcome, "discussion_only");

  teardownTest();
  pass();
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
git add apps/patchcouncil-ui/engine/config.js apps/patchcouncil-ui/engine/council.js apps/patchcouncil-ui/scripts/council-smoke.js
git commit -m "feat: add finalization gate fallback"
```

## 任务 5：首轮避免 coordinator 自己发言

**文件：**
- 修改：`apps/patchcouncil-ui/engine/council.js`
- 修改：`apps/patchcouncil-ui/scripts/council-smoke.js`

- [ ] **步骤 1：写 route policy 失败测试**

在 `council-smoke.js` 增加：

```js
async function testRouteAvoidsCoordinatorAsFirstAgent() {
  setupTest("route avoids coordinator as first agent");

  const config = JSON.parse(JSON.stringify(MINIMAL_CONFIG));
  config.council.min_distinct_agents = 1;
  config.council.max_turns = 1;

  const readyPayload = {
    stance: "agree",
    confidence: "high",
    finalize_readiness: "ready",
    blockers: [],
    agreements: [],
    disagreements: [],
    recommended_next_step: "finalize",
    analysis: "Ready.",
  };

  const scenarios = [
    {
      match: isRoutePrompt,
      response: { ok: true, text: JSON.stringify({ decision: "continue", next_agent: "codex", role: "analyze", reason: "coordinator picked itself" }) },
    },
    {
      match: isAgentTurnPrompt,
      response: { ok: true, text: JSON.stringify(readyPayload) },
    },
    {
      match: isFinalizePrompt,
      response: { ok: true, text: JSON.stringify({ consensus: "ok", next_steps: [] }) },
    },
  ];

  const { events } = await runEngine(config, scenarios);
  const started = events.find((e) => e.type === EVENTS.AGENT_TURN_STARTED);
  assert.equal(started.agent, "claude");
  assert.ok(events.some((e) => e.type === EVENTS.POLICY_OVERRIDE && e.policy === "avoid_coordinator_first_agent"));

  teardownTest();
  pass();
}
```

- [ ] **步骤 2：运行测试确认失败**

```powershell
cd apps\patchcouncil-ui
npm run smoke
```

预期：第一轮仍按 coordinator 选择的 `codex` 执行。

- [ ] **步骤 3：实现首轮 route policy**

在 `CouncilEngine` 类中加入：

```js
avoidCoordinatorAsFirstAgent(decision, agents) {
  if (!decision || decision.decision !== "continue") return decision;
  if (this.turnCount !== 0) return decision;
  const coordinator = selectCoordinator(this.config);
  if (!coordinator || decision.next_agent !== coordinator.name) return decision;

  const alternative = Object.keys(agents).find((name) => name !== coordinator.name);
  if (!alternative) return decision;

  this.emitEvent(events.EVENTS.POLICY_OVERRIDE, {
    turn: 0,
    policy: "avoid_coordinator_first_agent",
    original_decision: "continue",
    new_decision: "continue",
    selected_agent: alternative,
    reason: "enabled agent count > 1; first agent should not be the coordinator",
  });

  return {
    decision: "continue",
    next_agent: alternative,
    role: decision.role || "Provide the first independent perspective.",
    reason: "Policy selected a non-coordinator agent for the first turn.",
  };
}
```

在 `run()` 中 route 后、进入 loop 前调用：

```js
decision = this.avoidCoordinatorAsFirstAgent(decision, agents);
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
git add apps/patchcouncil-ui/engine/council.js apps/patchcouncil-ui/scripts/council-smoke.js
git commit -m "feat: avoid coordinator as first speaker"
```

## 任务 6：Transcript / CLI / UI 展示

**文件：**
- 修改：`apps/patchcouncil-ui/engine/session-store.js`
- 修改：`apps/patchcouncil-ui/engine/event-sink.js`
- 修改：`apps/patchcouncil-ui/public/app.js`
- 修改：`apps/patchcouncil-ui/scripts/council-smoke.js`
- 修改：`apps/patchcouncil-ui/scripts/smoke-test.js`

- [ ] **步骤 1：写 transcript 失败测试**

在 `council-smoke.js` 增加：

```js
async function testTranscriptRendersAgentSignalSummary() {
  setupTest("transcript renders agent signal summary");

  const store = new SessionStore(testDir);
  const session = store.createSession("signal transcript");
  store.appendEvent(session.dir, {
    schema_version: 1, seq: 0, type: EVENTS.SESSION_STARTED, phase: "discussion",
    session_id: session.id, started_at: "2026-06-01T10:00:00+08:00",
    topic: "signal transcript", mode: "council", config: {}, capabilities: {}, agents: [],
  });
  store.appendEvent(session.dir, {
    schema_version: 1, seq: 1, type: EVENTS.AGENT_TURN_COMPLETED, phase: "discussion",
    session_id: session.id, turn: 1, agent: "claude", content: "Analysis text.", content_length: 14, duration_ms: 10,
    signal: {
      stance: "mixed",
      confidence: "medium",
      finalize_readiness: "not_ready",
      blockers: [{ type: "question", text: "Need user input." }],
      agreements: [],
      disagreements: [],
      recommended_next_step: "Ask user.",
    },
  });

  const transcript = store.generateTranscript(session.dir);
  assert.match(transcript, /Stance:\*\* mixed/);
  assert.match(transcript, /Readiness:\*\* not_ready/);
  assert.match(transcript, /Need user input/);

  teardownTest();
  pass();
}
```

- [ ] **步骤 2：实现 transcript 渲染**

在 `SessionStore.generateTranscript()` 的 `agent_turn_completed` case 中，`lines.push(event.content);` 前加入：

```js
if (event.signal) {
  lines.push(`**Stance:** ${event.signal.stance || "unknown"}`);
  lines.push(`**Confidence:** ${event.signal.confidence || "unknown"}`);
  lines.push(`**Readiness:** ${event.signal.finalize_readiness || "unknown"}`);
  const firstBlocker = Array.isArray(event.signal.blockers) ? event.signal.blockers.find((item) => item && item.text) : null;
  if (firstBlocker) {
    lines.push(`**First blocker:** ${firstBlocker.text}`);
  }
  lines.push("");
}
if (event.signal_parse_error) {
  lines.push(`**Signal parse error:** ${event.signal_parse_error}`);
  lines.push("");
}
```

- [ ] **步骤 3：更新 CLI 输出**

在 `CliRendererSink.format()` 的 `agent_turn_completed` case 中改为：

```js
case "agent_turn_completed": {
  const signal = event.signal ? `, ${event.signal.stance}/${event.signal.finalize_readiness}` : "";
  return `[${event.agent}] Done (${event.content_length} chars, ${event.duration_ms}ms${signal})`;
}
```

- [ ] **步骤 4：更新 UI projection**

在 `public/app.js` 的 `projectEvent()` 中，把 `agent_turn_completed` case 改成：

```js
case "agent_turn_completed":
  return {
    kind: "agent",
    speaker: event.agent,
    text: event.content,
    agent: event.agent,
    signal: event.signal || null,
    signalParseError: event.signal_parse_error || "",
  };
```

在 `renderMessage(msg)` 中，`bubble.innerHTML = ...` 后追加 signal meta：

```js
  if (msg.signal) {
    var meta = document.createElement("div");
    meta.className = "signal-meta";
    meta.textContent = [msg.signal.stance, msg.signal.confidence + " confidence", msg.signal.finalize_readiness].filter(Boolean).join(" · ");
    bubble.append(meta);
  }
  if (msg.signalParseError) {
    var parseError = document.createElement("div");
    parseError.className = "signal-error";
    parseError.textContent = "Agent signal parse failed; continuing discussion.";
    bubble.append(parseError);
  }
```

- [ ] **步骤 5：增加 CSS**

在 `styles.css` 加入：

```css
.signal-meta {
  margin-top: 8px;
  color: var(--muted);
  font-size: 12px;
}

.signal-error {
  margin-top: 8px;
  color: #9b2c2c;
  font-size: 12px;
}
```

- [ ] **步骤 6：更新 smoke 静态断言**

在 `smoke-test.js` 中读取 `/app.js` 后增加：

```js
if (!appJs.includes("signal-meta")) {
  throw new Error("app js missing signal metadata rendering");
}
```

如果已经在 Workplan smoke 中读取 `appJs`，复用同一个变量。

- [ ] **步骤 7：运行检查**

```powershell
cd apps\patchcouncil-ui
npm run check
npm run smoke
```

预期：两个命令都通过。

- [ ] **步骤 8：提交**

```powershell
git add apps/patchcouncil-ui/engine/session-store.js apps/patchcouncil-ui/engine/event-sink.js apps/patchcouncil-ui/public/app.js apps/patchcouncil-ui/public/styles.css apps/patchcouncil-ui/scripts/council-smoke.js apps/patchcouncil-ui/scripts/smoke-test.js
git commit -m "feat: display agent turn signals"
```

## 任务 7：Fake runtime 和 HTTP smoke 适配

**文件：**
- 修改：`apps/patchcouncil-ui/server.js`
- 修改：`apps/patchcouncil-ui/scripts/smoke-test.js`

- [ ] **步骤 1：让 server fake runtime 返回 signal JSON**

在 `server.js` 的 `makeRuntimeRunner()` 中，`PATCHCOUNCIL_FAKE_RUNTIME === "1"` 分支里，保留 workplan prompt 特判；在通用 fake response 前增加 agent turn prompt 特判：

```js
      if (prompt.includes("finalize_readiness") && prompt.includes("blockers") && prompt.includes("analysis")) {
        return {
          ok: true,
          text: JSON.stringify({
            stance: "agree",
            confidence: "high",
            finalize_readiness: "ready",
            blockers: [],
            agreements: ["Fake runtime can provide structured agent signal."],
            disagreements: [],
            recommended_next_step: "Finalize when policy allows.",
            analysis: `Fake response from ${agentName}: structured signal generated for smoke tests.`,
          }),
        };
      }
```

- [ ] **步骤 2：增加 HTTP smoke 验证 signal**

在 `smoke-test.js` 的创建 session 流程中，读取 events 后增加：

```js
const completedTurn = (eventsResp.events || []).find((e) => e.type === "agent_turn_completed");
if (completedTurn && !completedTurn.signal) {
  throw new Error("expected agent_turn_completed signal");
}
```

如果该检查发生在 cancel 很早的 session 上，可能没有 completed turn。把它放到另一个正常 done session 的 events 检查里。

- [ ] **步骤 3：运行检查**

```powershell
cd apps\patchcouncil-ui
npm run check
npm run smoke
```

预期：两个命令都通过。

- [ ] **步骤 4：提交**

```powershell
git add apps/patchcouncil-ui/server.js apps/patchcouncil-ui/scripts/smoke-test.js
git commit -m "test: adapt smoke runtime to agent signals"
```

## 任务 8：文档同步和最终验证

**文件：**
- 修改：`docs/COUNCIL_EVENTS.md`
- 修改：`docs/ARCHITECTURE.md`
- 修改：`docs/AI_CONTEXT.md`
- 修改：`apps/patchcouncil-ui/README.md`

- [ ] **步骤 1：更新 COUNCIL_EVENTS.md**

在 `agent_turn_completed` 示例中加入：

```json
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
```

补充说明：

```markdown
新 session 的 agent turn 应包含 `signal`。旧 session 可能没有该字段，消费者必须兼容缺失。
```

- [ ] **步骤 2：更新架构文档**

在 `docs/ARCHITECTURE.md` 的 policy 层部分加入：

```markdown
Agent 发言会携带结构化 signal。Coordinator 可以提议 finalize，但 engine 会通过 finalize gate 检查 latest signal per distinct agent，避免过早收束。
```

- [ ] **步骤 3：更新 AI_CONTEXT.md**

在当前策略和限制段落加入：

```markdown
- 新 session 的 `agent_turn_completed` 会包含 `signal`，其中 `content` 是展示用 analysis。Finalize gate 使用 latest signal per distinct agent 判断是否允许收束。
```

- [ ] **步骤 4：更新 Workbench README**

在 `apps/patchcouncil-ui/README.md` 的用户能力或架构说明中加入：

```markdown
- Agent turns include structured signals used by policy to avoid premature finalization.
```

- [ ] **步骤 5：运行最终验证**

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

- [ ] **步骤 6：检查工作区**

```powershell
git status --short
```

预期：只剩本次有意修改和已有无关未跟踪目录。

- [ ] **步骤 7：提交**

```powershell
git add docs/COUNCIL_EVENTS.md docs/ARCHITECTURE.md docs/AI_CONTEXT.md apps/patchcouncil-ui/README.md
git commit -m "docs: document agent turn signals"
```

## 最终交付检查

- `agent_turn_completed.content` 是 `analysis`，不是完整 JSON。
- `agent_turn_completed.signal` 存在于新 session。
- 非 JSON agent 输出会生成 fallback signal，并阻止普通 finalize。
- finalize gate 会写 `policy_override`，reason 可解释。
- `finalize_gate_max_overrides` 能防止无限循环。
- enabled agent 数大于 1 时，首轮不优先选择 coordinator 自己。
- 旧 session 缺少 `signal` 时 UI、transcript 和 replay 不报错。
