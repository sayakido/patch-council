#!/usr/bin/env node
"use strict";

const path = require("path");
const { findProjectRoot, loadConfig } = require("../engine/config");
const { SessionStore } = require("../engine/session-store");
const { CouncilEngine } = require("../engine/council");
const { JsonlSink, StateSnapshotSink, CliRendererSink } = require("../engine/event-sink");
const { runCliRuntime } = require("../src/runtime/cli-adapter");
const prompts = require("../engine/prompts");

function makeRuntimeRunner(projectRoot) {
  return async (agentName, agentConfig, prompt) => {
    const run = runCliRuntime({
      runtime: agentName,
      command: agentConfig.command,
      args: agentConfig.args || [],
      input: prompt,
      input_mode: agentConfig.input_mode || (prompt ? "stdin" : "none"),
      timeoutMs: (agentConfig.timeout_sec || 1800) * 1000,
      cwd: projectRoot,
    });
    const result = await run.done;
    return {
      ok: result.ok,
      text: result.text || "",
      error: result.error || null,
    };
  };
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2 || args[0] !== "council") {
    process.stderr.write("Usage: node cli/cli.js council \"topic\"\n");
    process.exit(1);
  }

  const topic = args[1];

  let projectRoot;
  try {
    projectRoot = findProjectRoot();
  } catch {
    projectRoot = process.cwd();
  }

  const config = loadConfig(projectRoot);
  const sessionsRoot = path.join(projectRoot, ".project-ai", "sessions");
  const sessionStore = new SessionStore(sessionsRoot);
  const session = sessionStore.createSession(topic);

  const jsonlSink = new JsonlSink({ sessionStore, sessionDir: session.dir });
  const stateSink = new StateSnapshotSink({ sessionStore, sessionDir: session.dir });
  const cliSink = new CliRendererSink({ stream: process.stderr });

  const engine = new CouncilEngine({
    config,
    sessionStore,
    runAgent: makeRuntimeRunner(projectRoot),
    projectRoot,
    prompts,
    sessionDir: session.dir,
    sessionId: session.id,
  });

  engine.on("event", (event) => {
    jsonlSink.consume(event);
    stateSink.consume(event);
    cliSink.consume(event);
  });

  process.stderr.write(`[council] Session: ${session.id}\n`);
  process.stderr.write(`[council] Topic: ${topic}\n\n`);

  try {
    const result = await engine.run(topic);
    process.stdout.write(`${session.id}\n`);
    process.stderr.write(`\n[council] Done: ${result.outcome} (${result.turnCount} turns, ${result.distinctAgents.join(", ")})\n`);
    process.exit(result.errorCount > 0 ? 1 : 0);
  } catch (err) {
    process.stderr.write(`[council] Fatal: ${err.message}\n`);
    process.exit(1);
  }
}

main();
