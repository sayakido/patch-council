"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { SessionStore } = require("../engine/session-store");
const { CouncilEngine } = require("../engine/council");
const { EVENTS } = require("../engine/events");

const prompts = require("../engine/prompts");

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
        return typeof s.response === "function" ? s.response() : s.response;
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
      response: { ok: true, text: "Codex analysis here." },
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
  assert.ok(!events.some((e) => e.type === EVENTS.POLICY_OVERRIDE), "unexpected policy_override");

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
      response: { ok: true, text: "Codex says X." },
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
      response: { ok: true, text: "Claude challenges Y." },
    },
    {
      match: isFinalizePrompt,
      response: { ok: true, text: JSON.stringify({ consensus: "Good", disagreements: "none", recommended_next_step: "go", needs_confirmation: false, next_steps: ["do it"] }) },
    },
  ];

  const { events, result } = await runEngine(config, scenarios);

  assert.equal(result.turnCount, 2);
  assert.equal(result.errorCount, 0);
  assert.deepStrictEqual(result.distinctAgents.sort(), ["claude", "codex"]);
  assert.equal(result.outcome, "discussion_only");
  assert.ok(!events.some((e) => e.type === EVENTS.POLICY_OVERRIDE), "unexpected policy_override");

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
      response: { ok: true, text: "Codex analysis." },
    },
    {
      match: isDecidePrompt,
      response: { ok: true, text: JSON.stringify({ decision: "finalize", next_agent: null, role: null, reason: "done after one agent" }) },
    },
    {
      match: (p) => isAgentTurnPrompt(p) && p.includes("independent second perspective"),
      response: { ok: true, text: "Claude second opinion." },
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
      response: { ok: true, text: "Codex analysis." },
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

// --- Main ---

async function main() {
  process.stderr.write("\nCouncil Smoke Tests\n\n");

  await testHappyPathSingleAgent();
  await testHappyPathTwoAgents();
  await testJsonParseFailure();
  await testUnknownAgentAbort();
  await testMinDistinctAgentsPolicy();
  await testAgentCrashRecovery();
  await testMaxTurnsEnforced();

  process.stderr.write(`\n${passCount}/${testCount} passed\n`);
  if (passCount < testCount) process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`\nFATAL: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
