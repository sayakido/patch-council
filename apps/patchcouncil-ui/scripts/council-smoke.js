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
const eventBuilders = require("../engine/events");
const {
  buildDesignArtifactPath,
  parseAskOrDraft,
  summarizeDesignForBrief,
} = require("../engine/design-council");

const prompts = require("../engine/prompts");
const { buildWorkplanBrief, generateWorkplanForSession } = require("../engine/workplan");
const {
  buildWorkplanArtifactPath,
  ensureWorkplanDirectory,
  assertWorkplanWritable,
  scanWorkplanContract,
  commitWorkplanArtifact,
} = require("../engine/workplan-artifact");

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
    runGit: options.runGit,
  });

  const events = [];
  engine.on("event", (e) => { store.appendEvent(session.dir, e); events.push(e); });

  const result = await engine.run("test topic");
  return { engine, store, session, events, result };
}

// --- Test Cases ---

async function testDesignCouncilPureHelpers() {
  setupTest("design council pure helpers");

  const artifactPath = buildDesignArtifactPath(testDir, "Design Council Workflow!");
  assert.match(artifactPath, /docs[\\/]designs[\\/]\d{4}-\d{2}-\d{2}-design-council-workflow\.md$/);

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
  assert.ok(summary.length <= 160);
  assert.match(summary, /clipped/i);

  const event = eventBuilders.brainstormingQuestionCreated("s1", 1, "brainstorming", 2, "codex", "主要使用者是谁？", "reason", [], ["目标用户"]);
  assert.equal(event.type, eventBuilders.EVENTS.BRAINSTORMING_QUESTION_CREATED);
  assert.equal(event.question_seq, 2);

  teardownTest();
  pass();
}

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

async function testBrainstormingAskUserWaitsForAnswer() {
  setupTest("brainstorming ask_user waits for answer");

  const config = JSON.parse(JSON.stringify(MINIMAL_CONFIG));
  config.design_council = { lead_agent: "codex", max_questions: 8 };

  const { events, result, store, session } = await runEngine(config, [
    {
      match: (p) => p.includes("brainstorming") || p.includes("一次只问一个问题"),
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
      match: (p) => p.includes("brainstorming") || p.includes("一次只问一个问题"),
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

async function testWorkplanPromptRendersContract() {
  setupTest("workplan prompt renders contract");

  const rendered = prompts.renderPrompt("workplan_create.md", {
    topic: "topic",
    brief: "brief",
  });

  // Legacy prompt now redirects to new council prompt set
  assert.match(rendered, /Legacy prompt/i);
  assert.match(rendered, /workplan_draft\.md/);
  assert.match(rendered, /workplan_review\.md/);
  assert.match(rendered, /workplan_finalize\.md/);

  teardownTest();
  pass();
}

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

  const bad = scanWorkplanContract([
    "# Test Implementation Plan",
    "**Source Design:** docs/designs/x.md",
    "**Source Design Commit:** abc123",
    "## File Structure",
    "- File: `test.js`",
    "- [ ] **Step 1: Do it**",
    "Run: `npm run check`",
    "## Self-Review",
    "TBD: fix this",
  ].join("\n"));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /placeholder/i);

  fs.writeFileSync(artifactPath, "user edit", "utf8");
  assert.equal(assertWorkplanWritable(artifactPath, { allowExisting: false }).ok, false);

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
  let reviewCalls = 0;
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
        reviewCalls = (reviewCalls || 0) + 1;
        if (reviewCalls === 1) {
          return { ok: true, text: JSON.stringify({ stance: "mixed", confidence: "high", finalize_readiness: "not_ready", blockers: [{ type: "issue", text: "Need smoke verification." }], agreements: [], disagreements: [], recommended_next_step: "revise workplan", analysis: "Add smoke verification." }) };
        }
        return { ok: true, text: JSON.stringify({ stance: "agree", confidence: "high", finalize_readiness: "ready", blockers: [], agreements: ["Looks good."], disagreements: [], recommended_next_step: "request user approval", analysis: "No issues remain." }) };
      }
      if (prompt.includes("Review the reviewer findings and decide whether to accept")) {
        return { ok: true, text: JSON.stringify({ decision: "partially_accept", reason: "Smoke verification should be added; existing file scope is already sufficient.", revision_required: true, stance: "agree", confidence: "high", finalize_readiness: "ready", blockers: [], agreements: ["Add smoke verification."], disagreements: ["No extra file boundary needed."], recommended_next_step: "revise workplan", analysis: "Accept the verification concern and keep the scope narrow." }) };
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

async function testDesignRevisionCommittedAfterReview() {
  setupTest("design revision committed after review");

  const config = JSON.parse(JSON.stringify(MINIMAL_CONFIG));
  config.design_council = { lead_agent: "codex", max_questions: 8 };
  config.council.min_distinct_agents = 1;
  config.council.max_turns = 1;

  let revParseCount = 0;
  const { events } = await runEngine(config, [
    { match: (p) => p.includes("brainstorming") || p.includes("一次只问一个问题"), response: { ok: true, text: JSON.stringify({ decision: "draft_design", reason: "ok", known_context: [], missing_context: [] }) } },
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

async function testPreludeErrorEmitsSessionFinished() {
  setupTest("prelude error emits session_error + session_finished");

  const config = JSON.parse(JSON.stringify(MINIMAL_CONFIG));
  config.design_council = { lead_agent: "codex", max_questions: 8 };

  const { events, result, store, session } = await runEngine(config, [
    {
      match: (p) => p.includes("brainstorming") || p.includes("ask_or_draft"),
      response: { ok: false, error: "CLI crash" },
    },
  ], { mode: "design_council" });

  assert.equal(result.outcome, "error");
  assert.ok(events.some((e) => e.type === EVENTS.SESSION_ERROR), "should emit session_error");
  const finished = events.find((e) => e.type === EVENTS.SESSION_FINISHED);
  assert.ok(finished, "should emit session_finished");
  assert.equal(finished.outcome, "error");

  const state = store.deriveState(session.dir);
  assert.equal(state.status, "error");

  teardownTest();
  pass();
}

async function testDeriveStateExposesModeAndDesignStatus() {
  setupTest("deriveState exposes mode and design status for server preflight");

  const store = new SessionStore(testDir);
  const session = store.createSession("design no commit");
  store.appendEvent(session.dir, {
    schema_version: 1, seq: 0,
    type: EVENTS.SESSION_STARTED,
    phase: "brainstorming",
    session_id: session.id,
    started_at: new Date().toISOString(),
    topic: "test design",
    mode: "design_council",
    config: {},
  });
  store.appendEvent(session.dir, {
    schema_version: 1, seq: 1,
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

  const state = store.deriveState(session.dir);
  assert.equal(state.mode, "design_council");
  assert.equal(state.design.status, "none");

  teardownTest();
  pass();
}

// --- Main ---

async function main() {
  process.stderr.write("\nCouncil Smoke Tests\n\n");

  await testDesignCouncilPureHelpers();
  await testDesignCouncilSessionStartedConfig();
  await testRequiredAgentValidation();
  await testBrainstormingAskUserWaitsForAnswer();
  await testBrainstormingAnswerResumesIntoCouncilReview();
  await testDesignRevisionCommittedAfterReview();
  await testDesignCouncilWorkplanRequiresDesignCommit();
  await testPreludeErrorEmitsSessionFinished();
  await testDeriveStateExposesModeAndDesignStatus();
  await testWorkbenchEventConstants();
  await testWorkplanEventConstants();
  await testWorkbenchStateAndTranscriptEvents();
  await testWorkplanBriefIncludesAllAgentTurns();
  await testWorkplanPromptRendersContract();
  await testWorkplanCouncilPromptsRenderContract();
  await testWorkplanArtifactHelpers();
  await testGenerateMarkdownWorkplanCouncilFlow();
  await testWorkplanStateAndTranscriptEvents();
  await testWorkplanCouncilStateAndTranscriptEvents();
  await testLegacyJsonWorkplanStillDerivesState();
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
