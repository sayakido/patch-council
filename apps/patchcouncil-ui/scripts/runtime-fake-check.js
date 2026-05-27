const assert = require("node:assert/strict");
const path = require("node:path");
const { runCliRuntime } = require("../src/runtime/cli-adapter");

async function collectRun(args, options = {}) {
  const events = [];
  const run = runCliRuntime({
    runtime: "fake",
    command: process.execPath,
    args: [path.join(__dirname, "fake-runtime.js"), ...args],
    cwd: path.join(__dirname, ".."),
    input: options.input,
    input_mode: options.input_mode,
    timeoutMs: options.timeoutMs || 3000,
    turnId: options.turnId || `fake-${args[0]}`,
  });
  run.emitter.on("event", (event) => events.push(event));
  const result = await run.done;
  return { result, events };
}

async function testStream() {
  const { result, events } = await collectRun(["stream"]);
  assert.equal(result.ok, true);
  assert(events.some((event) => event.type === "runtime.turn.started"));
  assert(events.filter((event) => event.type === "runtime.reply.delta").length >= 3);
  assert(events.some((event) => event.type === "runtime.reply.completed" && event.text === "Hello from fake runtime."));
  assert(events.some((event) => event.type === "runtime.turn.completed"));
}

async function testCrash() {
  const { result, events } = await collectRun(["crash"]);
  assert.equal(result.ok, false);
  assert(events.some((event) => event.type === "runtime.turn.failed" && event.message.includes("code 7")));
}

async function testTimeout() {
  const { result, events } = await collectRun(["hang"], { timeoutMs: 250 });
  assert.equal(result.ok, false);
  assert(events.some((event) => event.type === "runtime.reply.delta"));
  assert(events.some((event) => event.type === "runtime.turn.failed" && event.message.includes("timed out")));
}

async function testPlainOutput() {
  const { result, events } = await collectRun(["plain"]);
  assert.equal(result.ok, true);
  assert.equal(result.text, "plain line one\nplain line two");
  assert(events.some((event) => event.type === "runtime.reply.completed" && event.text.includes("plain line one")));
}

async function testStdinInput() {
  const { result } = await collectRun(["echo-stdin"], {
    input: "hello over stdin",
    input_mode: "stdin",
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, "hello over stdin");
}

async function testArgumentInput() {
  const { result, events } = await collectRun(["echo-arg"], {
    input: "hello as argument",
    input_mode: "argument",
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, "hello as argument");
  assert(events.some((event) => event.type === "runtime.turn.started" && event.args.includes("hello as argument")));
}

async function testCodexJsonlOutput() {
  const { result, events } = await collectRun(["codex-jsonl"]);
  assert.equal(result.ok, true);
  assert.equal(result.text, "Codex JSONL final text.");
  assert(events.some((event) => event.type === "runtime.reply.completed" && event.text === "Codex JSONL final text."));
  assert(!result.text.includes("thread.started"));
}

async function testClaudeJsonlOutput() {
  const { result, events } = await collectRun(["claude-jsonl"]);
  assert.equal(result.ok, true);
  assert.equal(result.text, "Claude JSONL final text.");
  assert(events.some((event) => event.type === "runtime.reply.delta" && event.text === "Claude "));
  assert(events.some((event) => event.type === "runtime.reply.completed" && event.text === "Claude JSONL final text."));
  assert(!result.text.includes("system"));
}

async function main() {
  await testStream();
  await testCrash();
  await testTimeout();
  await testPlainOutput();
  await testStdinInput();
  await testArgumentInput();
  await testCodexJsonlOutput();
  await testClaudeJsonlOutput();
  console.log("runtime fake ok");
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
