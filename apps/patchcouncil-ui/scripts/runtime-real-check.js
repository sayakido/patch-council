const { runCliRuntime } = require("../src/runtime/cli-adapter");

const target = (process.argv[2] || "").trim().toLowerCase();
const configs = {
  codex: {
    runtime: "codex",
    command: "codex",
    args: ["--help"],
    timeoutMs: 15_000,
  },
  opencode: {
    runtime: "opencode",
    command: "opencode",
    args: ["run", "Reply with exactly: PatchCouncil runtime check"],
    timeoutMs: 60_000,
  },
};

async function main() {
  const config = configs[target];
  if (!config) {
    throw new Error("usage: node ./scripts/runtime-real-check.js codex|opencode");
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
