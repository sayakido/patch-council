const { runCliRuntime } = require("../src/runtime/cli-adapter");
const { DEFAULT_CONFIG } = require("../engine/config");

const target = (process.argv[2] || "").trim().toLowerCase();
const prompt = "Reply with exactly: PatchCouncil runtime check ok";
const configs = {
  codex: {
    runtime: "codex",
    command: DEFAULT_CONFIG.agents.codex.command,
    args: DEFAULT_CONFIG.agents.codex.args,
    input: prompt,
    input_mode: DEFAULT_CONFIG.agents.codex.input_mode,
    timeoutMs: 60_000,
  },
  claude: {
    runtime: "claude",
    command: DEFAULT_CONFIG.agents.claude.command,
    args: DEFAULT_CONFIG.agents.claude.args,
    input: prompt,
    input_mode: DEFAULT_CONFIG.agents.claude.input_mode,
    timeoutMs: 60_000,
  },
};

async function main() {
  const config = configs[target];
  if (!config) {
    throw new Error("usage: node ./scripts/runtime-real-check.js codex|claude");
  }

  const events = [];
  const run = runCliRuntime({
    ...config,
    turnId: `${target}-real-check`,
  });
  run.emitter.on("event", (event) => {
    events.push(event);
    console.log(JSON.stringify(event));
  });
  const result = await run.done;
  if (!result.ok) {
    throw new Error(result.error || `${target} check failed`);
  }
  if (!events.some((event) => event.type === "runtime.turn.completed")) {
    throw new Error("missing runtime.turn.completed");
  }
  console.error(`${target} runtime check ok`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
