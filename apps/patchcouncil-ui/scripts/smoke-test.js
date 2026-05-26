const { spawn } = require("node:child_process");

const port = 9876;
const env = {
  ...process.env,
  PATCHCOUNCIL_UI_PORT: String(port),
};

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}`);
  }
  return response.text();
}

async function waitForServer() {
  const deadline = Date.now() + 5000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      await fetchText("/api/sessions");
      return;
    } catch (error) {
      lastError = error;
      await wait(150);
    }
  }
  throw lastError || new Error("server did not start");
}

async function main() {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: `${__dirname}/..`,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await waitForServer();
    const sessions = JSON.parse(await fetchText("/api/sessions"));
    if (!Array.isArray(sessions.sessions) || sessions.sessions.length === 0) {
      throw new Error("expected at least one mock session");
    }
    const html = await fetchText("/");
    if (!html.includes("PatchCouncil UI Spike")) {
      throw new Error("index html did not render expected title");
    }
    console.log("smoke ok");
  } finally {
    child.kill();
  }

  if (stderr.trim()) {
    console.error(stderr.trim());
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
