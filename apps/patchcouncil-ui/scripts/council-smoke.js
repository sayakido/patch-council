"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { SessionStore } = require("../engine/session-store");
const {
  CouncilEngine,
  parseAgentTurnSignal,
  fallbackAgentSignal,
  shouldAllowFinalize,
  latestSignalsByAgent,
} = require("../engine/council");
const { EVENTS } = require("../engine/events");

const prompts = require("../engine/prompts");
const { buildWorkplanBrief, parseWorkplanJson, validateWorkplan, generateWorkplanForSession } = require("../engine/workplan");

const MINIMAL_CONFIG = {
  agents: {
    codex: {
      command: "fake-codex",
      args: [],
      input_mode: "stdin",
      capabilities: ["plan", "synthesize", "review", "judge"],
      write_access: false,
      timeout_sec: 60,
    },
    claude: {
      command: "fake-claude",
      args: [],
      input_mode: "stdin",
      capabilities: ["challenge", "implement", "fix"],
      write_access: false,
      timeout_sec: 60,
    },
  },
  council: {
    max_turns: 3,
    min_distinct_agents: 2,
    max_context_chars: 2500,
    max_transcript_chars: 2500,
    max_message_chars: 800,
    finalize_gate_max_overrides: 2,
  },
};

function isRoutePrompt(prompt) {
  return prompt.includes("下一位") && prompt.includes("coordinator");
}

function isDecidePrompt(prompt) {
  return prompt.includes("继续讨论") && prompt.includes("已经可以收束");
}

function isFinalizePrompt(prompt) {
  return prompt.includes("最终总结") || prompt.includes("共识");
}

function isAgentTurnPrompt(prompt) {
  return prompt.includes("多 agent council 讨论") || prompt.includes("本轮角色");
}

function makeFakeRuntime(scenarios) {
  return async (_agentName, _agentConfig, prompt) => {
    for (const s of scenarios) {
      if (s.match(prompt)) {
        return typeof s.response === "function" ? s.response(prompt) : s.response;
      }
    }
    return { ok: false, text: "", error: "no matching scenario for prompt: " + prompt.slice(0, 100) };
  };
}

let testDir;
let testCount = 0;
let passCount = 0;

function setupTest(name) {
  testDir = path.join(os.tmpdir(), "council-smoke-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6));
  fs.mkdirSync(testDir, { recursive: true });
  testCount++;
  process.stderr.write(`  ${testCount}. ${name} ... `);
}

function teardownTest() {
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (_) { /* ok */ }
}

function pass() {
  passCount++;
  process.stderr.write("ok\n");
}

async function runEngine(config, scenarios) {
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
  });

  const events = [];
  engine.on("event", (e) => { store.appendEvent(session.dir, e); events.push(e); });

  const result = await engine.run("test topic");
  return { engine, store, session, events, result };
}

// --- Test Cases ---

async function testHappyPathSingleAgent() {
  setupTest("happy path single agent");

  const config = JSON.parse(JSON.stringify(MINIMAL_CONFIG));
  config.council.min_distinct_agents = 1;
  config.council.max_turns = 1;

  const scenarios = [
    {
      match: isRoutePrompt,
      response: { ok: true, text: JSON.stringify({ decision: "continue", next_agent: "codex", role: "analyze", reason: "needs analysis" }) },
    },
    {
      match: isAgentTurnPrompt,
      response: { ok: true, text: JSON.stringify({ stance: "agree", confidence: "high", finalize_readiness: "ready", blockers: [], agreements: [], disagreements: [], recommended_next_step: "finalize", analysis: "Codex analysis here." }) },
    },
    {
      match: isDecidePrompt,
      response: { ok: true, text: JSON.stringify({ decision: "finalize", next_agent: null, role: null, reason: "done" }) },
    },
    {
      match: isFinalizePrompt,
      response: { ok: true, text: JSON.stringify({ consensus: "Agreed", disagreements: "none", recommended_next_step: "proceed", needs_confirmation: false, next_steps: ["step 1"] }) },
    },
  ];

  const { events, result } = await runEngine(config, scenarios);

  assert.ok(events.some((e) => e.type === EVENTS.SESSION_STARTED), "missing session_started");
  assert.ok(events.some((e) => e.type === EVENTS.SESSION_FINISHED), "missing session_finished");
  assert.equal(result.turnCount, 1);
  assert.equal(result.errorCount, 0);
  assert.equal(result.outcome, "discussion_only");

  const started = events.find((e) => e.type === EVENTS.SESSION_STARTED);
  assert.equal(started.config.council.max_turns, 1);
  assert.equal(started.config.council.finalize_gate_max_overrides, 2);
  assert.deepStrictEqual(started.config.agents.codex.capabilities, ["plan", "synthesize", "review", "judge"]);

  teardownTest();
  pass();
}

async function testHappyPathTwoAgents() {
  setupTest("happy path two agents");

  const config = JSON.parse(JSON.stringify(MINIMAL_CONFIG));
  config.council.min_distinct_agents = 2;
  config.council.max_turns = 3;

  let decideCount2 = 0;
  const scenarios = [
    {
      match: isRoutePrompt,
      response: { ok: true, text: JSON.stringify({ decision: "continue", next_agent: "codex", role: "analyze", reason: "first" }) },
    },
    {
      match: (p) => isAgentTurnPrompt(p) && p.includes("codex"),
      response: { ok: true, text: JSON.stringify({ stance: "agree", confidence: "high", finalize_readiness: "ready", blockers: [], agreements: [], disagreements: [], recommended_next_step: "continue", analysis: "Codex says X." }) },
    },
    {
      match: isDecidePrompt,
      response: () => {
        decideCount2++;
        if (decideCount2 === 1) {
          return { ok: true, text: JSON.stringify({ decision: "continue", next_agent: "claude", role: "challenge", reason: "need another view" }) };
        }
        return { ok: true, text: JSON.stringify({ decision: "finalize", next_agent: null, role: null, reason: "enough discussion" }) };
      },
    },
    {
      match: (p) => isAgentTurnPrompt(p) && p.includes("claude"),
      response: { ok: true, text: JSON.stringify({ stance: "agree", confidence: "high", finalize_readiness: "ready", blockers: [], agreements: [], disagreements: [], recommended_next_step: "finalize", analysis: "Claude challenges Y." }) },
    },
    {
      match: isFinalizePrompt,
      response: { ok: true, text: JSON.stringify({ consensus: "Good", disagreements: "none", recommended_next_step: "go", needs_confirmation: false, next_steps: ["do it"] }) },
    },
  ];

  const { events, result } = await runEngine(config, scenarios);

  assert.ok(result.turnCount >= 2);
  assert.equal(result.errorCount, 0);
  assert.deepStrictEqual(result.distinctAgents.sort(), ["claude", "codex"]);
  assert.equal(result.outcome, "discussion_only");

  teardownTest();
  pass();
}

async function testJsonParseFailure() {
  setupTest("JSON parse failure → coordinator_error");

  const config = JSON.parse(JSON.stringify(MINIMAL_CONFIG));
  config.council.min_distinct_agents = 1;
  config.council.max_turns = 1;

  const scenarios = [
    {
      match: isRoutePrompt,
      response: { ok: true, text: "I think claude should speak first because it has a fresh perspective..." },
    },
    // no other scenarios needed - should fallback_finalize
  ];

  const { events, result } = await runEngine(config, scenarios);

  assert.ok(events.some((e) => e.type === EVENTS.COORDINATOR_ERROR), "missing coordinator_error");
  assert.ok(events.some((e) => e.type === EVENTS.SESSION_FINISHED), "missing session_finished");
  assert.ok(result.errorCount >= 1, "should have errors");
  assert.equal(result.outcome, "error");

  teardownTest();
  pass();
}

async function testUnknownAgentAbort() {
  setupTest("unknown agent → coordinator_error + abort");

  const config = JSON.parse(JSON.stringify(MINIMAL_CONFIG));
  config.council.min_distinct_agents = 1;
  config.council.max_turns = 2;

  const scenarios = [
    {
      match: isRoutePrompt,
      response: { ok: true, text: JSON.stringify({ decision: "continue", next_agent: "nonexistent-agent", role: "test", reason: "test" }) },
    },
    {
      match: isFinalizePrompt,
      response: { ok: true, text: JSON.stringify({ consensus: "ok", disagreements: "none", recommended_next_step: "", needs_confirmation: false, next_steps: [] }) },
    },
  ];

  const { events } = await runEngine(config, scenarios);

  // unknown agent should trigger coordinator_error, not silently fallback
  assert.ok(events.some((e) => e.type === EVENTS.COORDINATOR_ERROR), "missing coordinator_error for unknown agent");
  const agentStarts = events.filter((e) => e.type === EVENTS.AGENT_TURN_STARTED);
  assert.equal(agentStarts.length, 0, "should not start any agent turn for unknown agent");
  assert.ok(events.some((e) => e.type === EVENTS.SESSION_FINISHED), "should still finish session");

  teardownTest();
  pass();
}

async function testDisabledAgentExcludedFromCouncil() {
  setupTest("disabled agent excluded from council");

  const config = JSON.parse(JSON.stringify(MINIMAL_CONFIG));
  config.agents.opencode = {
    command: "opencode",
    args: ["run"],
    input_mode: "argument",
    capabilities: ["challenge", "implement", "fix"],
    write_access: true,
    timeout_sec: 60,
    enabled: false,
  };
  config.council.min_distinct_agents = 1;
  config.council.max_turns = 1;

  let routePrompt = "";
  const scenarios = [
    {
      match: isRoutePrompt,
      response: (prompt) => {
        routePrompt = prompt;
        return { ok: true, text: JSON.stringify({ decision: "continue", next_agent: "opencode", role: "test", reason: "test disabled filtering" }) };
      },
    },
    {
      match: isFinalizePrompt,
      response: { ok: true, text: JSON.stringify({ consensus: "ok", disagreements: "none", recommended_next_step: "", needs_confirmation: false, next_steps: [] }) },
    },
  ];

  const { events } = await runEngine(config, scenarios);

  assert.ok(!routePrompt.includes("opencode"), "disabled agent should not be shown to coordinator");
  const started = events.find((e) => e.type === EVENTS.SESSION_STARTED);
  assert.ok(started, "missing session_started");
  assert.ok(!started.agents.some((agent) => agent.id === "opencode"), "disabled agent should not be in session agent list");
  assert.ok(events.some((e) => e.type === EVENTS.COORDINATOR_ERROR), "disabled agent selection should be rejected");
  assert.equal(events.some((e) => e.type === EVENTS.AGENT_TURN_STARTED && e.agent === "opencode"), false, "disabled agent should not run");

  teardownTest();
  pass();
}

async function testMinDistinctAgentsPolicy() {
  setupTest("min_distinct_agents policy override");

  const config = JSON.parse(JSON.stringify(MINIMAL_CONFIG));
  config.council.min_distinct_agents = 2;
  config.council.max_turns = 3;

  const scenarios = [
    {
      match: isRoutePrompt,
      response: { ok: true, text: JSON.stringify({ decision: "continue", next_agent: "codex", role: "analyze", reason: "first" }) },
    },
    {
      match: isAgentTurnPrompt,
      response: { ok: true, text: JSON.stringify({ stance: "agree", confidence: "high", finalize_readiness: "ready", blockers: [], agreements: [], disagreements: [], recommended_next_step: "finalize", analysis: "Codex analysis." }) },
    },
    {
      match: isDecidePrompt,
      response: { ok: true, text: JSON.stringify({ decision: "finalize", next_agent: null, role: null, reason: "done after one agent" }) },
    },
    {
      match: (p) => isAgentTurnPrompt(p) && p.includes("independent second perspective"),
      response: { ok: true, text: JSON.stringify({ stance: "agree", confidence: "high", finalize_readiness: "ready", blockers: [], agreements: [], disagreements: [], recommended_next_step: "finalize", analysis: "Claude second opinion." }) },
    },
    {
      match: isFinalizePrompt,
      response: { ok: true, text: JSON.stringify({ consensus: "ok", disagreements: "none", recommended_next_step: "", needs_confirmation: false, next_steps: [] }) },
    },
  ];

  const { events, result } = await runEngine(config, scenarios);

  assert.ok(events.some((e) => e.type === EVENTS.POLICY_OVERRIDE), "missing policy_override");
  assert.ok(result.turnCount >= 2, "should have at least 2 turns after policy override");
  assert.ok(result.distinctAgents.length >= 2, "should have 2 distinct agents");

  teardownTest();
  pass();
}

async function testAgentCrashRecovery() {
  setupTest("agent crash → agent_error + recovery");

  const config = JSON.parse(JSON.stringify(MINIMAL_CONFIG));
  config.council.min_distinct_agents = 1;
  config.council.max_turns = 2;

  const scenarios = [
    {
      match: isRoutePrompt,
      response: { ok: true, text: JSON.stringify({ decision: "continue", next_agent: "codex", role: "analyze", reason: "first" }) },
    },
    {
      match: isAgentTurnPrompt,
      response: { ok: false, text: "", error: "command crashed" },
    },
    {
      match: isFinalizePrompt,
      response: { ok: true, text: JSON.stringify({ consensus: "failed", disagreements: "none", recommended_next_step: "", needs_confirmation: false, next_steps: [] }) },
    },
  ];

  const { events, result } = await runEngine(config, scenarios);

  assert.ok(events.some((e) => e.type === EVENTS.AGENT_ERROR), "missing agent_error");
  const agentError = events.find((e) => e.type === EVENTS.AGENT_ERROR);
  assert.equal(agentError.recoverable, true);
  assert.equal(agentError.action, "skip_turn");
  assert.equal(result.turnCount, 1, "turn should count even on error");
  assert.ok(events.some((e) => e.type === EVENTS.SESSION_FINISHED), "should still reach session_finished");

  teardownTest();
  pass();
}

async function testMaxTurnsEnforced() {
  setupTest("max turns enforced");

  const config = JSON.parse(JSON.stringify(MINIMAL_CONFIG));
  config.council.min_distinct_agents = 1;
  config.council.max_turns = 1;

  const scenarios = [
    {
      match: isRoutePrompt,
      response: { ok: true, text: JSON.stringify({ decision: "continue", next_agent: "codex", role: "analyze", reason: "first" }) },
    },
    {
      match: isAgentTurnPrompt,
      response: { ok: true, text: JSON.stringify({ stance: "agree", confidence: "high", finalize_readiness: "ready", blockers: [], agreements: [], disagreements: [], recommended_next_step: "finalize", analysis: "Codex analysis." }) },
    },
    {
      match: isFinalizePrompt,
      response: { ok: true, text: JSON.stringify({ consensus: "ok", disagreements: "none", recommended_next_step: "", needs_confirmation: false, next_steps: [] }) },
    },
  ];

  const { events, result } = await runEngine(config, scenarios);

  assert.equal(result.turnCount, 1, "should have exactly 1 turn");
  // should NOT call decide after max turns reached
  const decides = events.filter((e) => e.type === EVENTS.COORDINATOR_DECIDED);
  assert.equal(decides.length, 1, "should only have route decision, not decide");

  teardownTest();
  pass();
}

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
        return { ok: true, text: JSON.stringify({ stance: "agree", confidence: "high", finalize_readiness: "ready", blockers: [], agreements: [], disagreements: [], recommended_next_step: "finalize", analysis: "Codex analysis." }) };
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

async function testWorkbenchEventConstants() {
  setupTest("workbench event constants");

  assert.equal(EVENTS.USER_INTERJECTION, "user_interjection");
  assert.equal(EVENTS.SESSION_CANCEL_REQUESTED, "session_cancel_requested");

  teardownTest();
  pass();
}

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

async function testWorkplanEventConstants() {
  setupTest("workplan event constants");

  assert.equal(EVENTS.WORKPLAN_GENERATION_STARTED, "workplan_generation_started");
  assert.equal(EVENTS.WORKPLAN_CREATED, "workplan_created");
  assert.equal(EVENTS.WORKPLAN_GENERATION_FAILED, "workplan_generation_failed");

  teardownTest();
  pass();
}

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

async function testWorkplanBriefIncludesAllAgentTurns() {
  setupTest("workplan brief includes all agent turns");

  const events = [
    { type: EVENTS.SESSION_STARTED, seq: 0, topic: "topic", session_id: "s1", source_summary: "Prior discussion about architecture.", source_transcript_path: ".project-ai/sessions/s0/transcript.jsonl" },
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
  assert.match(brief, /Prior discussion about architecture/);
  assert.match(brief, /Source Session Summary/);

  teardownTest();
  pass();
}

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

async function testGenerateWorkplanExceptionWritesFailed() {
  setupTest("generate workplan exception writes failed");

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
    runAgent: async () => { throw new Error("simulated crash"); },
    onEvent: (event) => {
      emitted.push(event);
      store.appendEvent(session.dir, event);
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /simulated crash/);
  assert.ok(emitted.some((e) => e.type === EVENTS.WORKPLAN_GENERATION_FAILED), "missing workplan_generation_failed after exception");
  assert.equal(store.deriveState(session.dir).workplan_status, "failed");

  teardownTest();
  pass();
}

async function testSourceMetadataFromFinalizedSession() {
  setupTest("source metadata from finalized session");

  const store = new SessionStore(testDir);
  const session = store.createSession("original topic");

  store.appendEvent(session.dir, {
    schema_version: 1, seq: 0, type: EVENTS.SESSION_STARTED, phase: "discussion",
    session_id: session.id, started_at: "2026-05-28T10:00:00+08:00",
    topic: "original topic", mode: "council", config: {}, capabilities: {}, agents: [],
  });
  store.appendEvent(session.dir, {
    schema_version: 1, seq: 1, type: EVENTS.AGENT_TURN_COMPLETED, phase: "discussion",
    session_id: session.id, turn: 1, agent: "codex", content: "Agent answer here",
  });
  store.appendEvent(session.dir, {
    schema_version: 1, seq: 2, type: EVENTS.FINALIZED, phase: "finalized",
    session_id: session.id, summary: "Final summary text", next_steps: [],
  });

  const meta = store.getSourceMetadata(session.dir);
  assert.equal(meta.source_session_id, session.id);
  assert.equal(meta.source_summary, "Final summary text");
  assert.ok(meta.source_transcript_path.includes("transcript.jsonl"));

  teardownTest();
  pass();
}

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

async function testSourceMetadataFromCancelledSession() {
  setupTest("source metadata from cancelled session (no finalized)");

  const store = new SessionStore(testDir);
  const session = store.createSession("cancelled topic");

  store.appendEvent(session.dir, {
    schema_version: 1, seq: 0, type: EVENTS.SESSION_STARTED, phase: "discussion",
    session_id: session.id, started_at: "2026-05-28T10:00:00+08:00",
    topic: "cancelled topic", mode: "council", config: {}, capabilities: {}, agents: [],
  });
  store.appendEvent(session.dir, {
    schema_version: 1, seq: 1, type: EVENTS.AGENT_TURN_COMPLETED, phase: "discussion",
    session_id: session.id, turn: 1, agent: "codex", content: "Partial answer",
  });

  const meta = store.getSourceMetadata(session.dir);
  assert.match(meta.source_summary, /cancelled topic/);
  assert.match(meta.source_summary, /Partial answer/);

  teardownTest();
  pass();
}

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

async function testFinalizePromptIncludesSignalDisagreements() {
  setupTest("finalize prompt includes signal disagreements");

  const config = JSON.parse(JSON.stringify(MINIMAL_CONFIG));
  config.council.min_distinct_agents = 1;
  config.council.max_turns = 1;

  let capturedFinalizePrompt = "";

  const readyDisagreePayload = {
    stance: "disagree",
    confidence: "high",
    finalize_readiness: "ready",
    blockers: [],
    agreements: ["The direction is sound."],
    disagreements: ["Prefer smaller v1 scope."],
    recommended_next_step: "Finalize with recorded disagreement.",
    analysis: "I disagree on scope but am ready to finalize.",
  };

  const scenarios = [
    {
      match: isRoutePrompt,
      response: { ok: true, text: JSON.stringify({ decision: "continue", next_agent: "claude", role: "challenge", reason: "first" }) },
    },
    {
      match: isAgentTurnPrompt,
      response: { ok: true, text: JSON.stringify(readyDisagreePayload) },
    },
    {
      match: isFinalizePrompt,
      response: (prompt) => {
        capturedFinalizePrompt = prompt;
        return { ok: true, text: JSON.stringify({ consensus: "Accepted with disagreement noted.", next_steps: [] }) };
      },
    },
  ];

  await runEngine(config, scenarios);

  assert.match(capturedFinalizePrompt, /Signal:/);
  assert.match(capturedFinalizePrompt, /Prefer smaller v1 scope/);

  teardownTest();
  pass();
}

async function testBuildBriefPreservesEarlyAgentSignal() {
  setupTest("buildBrief preserves early agent signal");

  const config = JSON.parse(JSON.stringify(MINIMAL_CONFIG));
  config.council.min_distinct_agents = 1;
  config.council.max_turns = 1;

  const readyDisagree = {
    stance: "disagree",
    confidence: "high",
    finalize_readiness: "ready",
    blockers: [],
    agreements: [],
    disagreements: ["Scope too broad for v1."],
    recommended_next_step: "Finalize with note.",
    analysis: "Disagree on scope.",
  };

  let capturedFinalizePrompt = "";

  const scenarios = [
    {
      match: isRoutePrompt,
      response: { ok: true, text: JSON.stringify({ decision: "continue", next_agent: "claude", role: "challenge", reason: "first" }) },
    },
    {
      match: isAgentTurnPrompt,
      response: { ok: true, text: JSON.stringify(readyDisagree) },
    },
    {
      match: isFinalizePrompt,
      response: (prompt) => {
        capturedFinalizePrompt = prompt;
        return { ok: true, text: JSON.stringify({ consensus: "Noted.", next_steps: [] }) };
      },
    },
  ];

  await runEngine(config, scenarios);

  // The "Latest Agent Signals" block must be present and contain the disagreement.
  assert.match(capturedFinalizePrompt, /Latest Agent Signals/);
  assert.match(capturedFinalizePrompt, /Scope too broad for v1/);

  teardownTest();
  pass();
}

async function testSignalBlockSurvivesTranscriptBudget() {
  setupTest("signal block survives tight transcript budget");

  const config = JSON.parse(JSON.stringify(MINIMAL_CONFIG));
  config.council.min_distinct_agents = 1;
  config.council.max_turns = 3;
  // Tight transcript budget — should still not clip signal block.
  config.council.max_transcript_chars = 200;

  const disagreePayload = {
    stance: "disagree",
    confidence: "high",
    finalize_readiness: "ready",
    blockers: [],
    agreements: [],
    disagreements: ["A1-disagreement-scope", "A2-disagreement-risk", "A3-disagreement-timeline"],
    recommended_next_step: "Finalize with noted disagreements.",
    analysis: "Disagree on some points but ready to finalize.",
  };

  let capturedFinalizePrompt = "";

  const scenarios = [
    {
      match: isRoutePrompt,
      response: { ok: true, text: JSON.stringify({ decision: "continue", next_agent: "claude", role: "analyze", reason: "first" }) },
    },
    {
      match: isAgentTurnPrompt,
      response: { ok: true, text: JSON.stringify(disagreePayload) },
    },
    {
      match: isDecidePrompt,
      response: { ok: true, text: JSON.stringify({ decision: "finalize", next_agent: null, role: null, reason: "done" }) },
    },
    {
      match: isFinalizePrompt,
      response: (prompt) => {
        capturedFinalizePrompt = prompt;
        return { ok: true, text: JSON.stringify({ consensus: "Done with disagreements.", next_steps: [] }) };
      },
    },
  ];

  await runEngine(config, scenarios);

  // Signal block must always be present.
  assert.match(capturedFinalizePrompt, /Latest Agent Signals/);
  // Even with tight budget, disagreement text must survive.
  assert.match(capturedFinalizePrompt, /A1-disagreement-scope/);

  teardownTest();
  pass();
}

// --- Main ---

async function main() {
  process.stderr.write("\nCouncil Smoke Tests\n\n");

  await testWorkbenchEventConstants();
  await testWorkplanEventConstants();
  await testWorkbenchStateAndTranscriptEvents();
  await testWorkplanJsonParserAndValidator();
  await testWorkplanBriefIncludesAllAgentTurns();
  await testWorkplanPromptRendersContract();
  await testGenerateWorkplanForDoneSession();
  await testGenerateWorkplanFailureAllowsRetry();
  await testGenerateWorkplanExceptionWritesFailed();
  await testWorkplanStateAndTranscriptEvents();
  await testHappyPathSingleAgent();
  await testHappyPathTwoAgents();
  await testJsonParseFailure();
  await testUnknownAgentAbort();
  await testDisabledAgentExcludedFromCouncil();
  await testMinDistinctAgentsPolicy();
  await testAgentCrashRecovery();
  await testMaxTurnsEnforced();
  await testInterjectionIncludedInNextCoordinatorBrief();
  await testCancellationStopsAfterCurrentTurn();
  await testSourceMetadataFromFinalizedSession();
  await testSourceMetadataFromCancelledSession();
  await testSourceMetadataIncludesWorkplanSummary();

  await testAgentTurnSignalParser();
  await testFallbackAgentSignalBlocksFinalize();

  await testAgentTurnPromptRequiresSignalJson();
  await testAgentTurnCompletedStoresSignal();

  await testFinalizeGateBlocksBlockers();
  await testFinalizeGateAllowsReadyDisagreement();
  await testFinalizeGateBlocksAllNotReady();
  await testFinalizeGatePolicyOverrideForBlocker();

  await testFinalizeGateFallbackAfterMaxOverrides();

  await testRouteAvoidsCoordinatorAsFirstAgent();

  await testTranscriptRendersAgentSignalSummary();

  await testFinalizePromptIncludesSignalDisagreements();

  await testBuildBriefPreservesEarlyAgentSignal();

  await testSignalBlockSurvivesTranscriptBudget();

  process.stderr.write(`\n${passCount}/${testCount} passed\n`);
  if (passCount < testCount) process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`\nFATAL: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
