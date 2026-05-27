const { spawn } = require("node:child_process");

const port = 9876;
const env = {
  ...process.env,
  PATCHCOUNCIL_UI_PORT: String(port),
  PATCHCOUNCIL_FAKE_RUNTIME: "1",
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

    // GET /api/config
    const config = await fetchJson("/api/config");
    if (!config.council || !config.agents) {
      throw new Error("expected config response with council and agents");
    }

    // PUT /api/config
    const originalConfig = JSON.parse(JSON.stringify(config));
    try {
      originalConfig.council.max_turns = 4;
      const savedConfig = await fetchJson("/api/config", {
        method: "PUT",
        body: JSON.stringify(originalConfig),
      });
      if (savedConfig.council.max_turns !== 4) {
        throw new Error("expected PUT /api/config to persist max_turns=4");
      }
    } finally {
      // Restore original config
      await fetchJson("/api/config", {
        method: "PUT",
        body: JSON.stringify(config),
      });
    }

    // POST /api/sessions with FAKE_RUNTIME
    const created = await fetchJson("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ topic: "smoke workbench topic", mode: "council" }),
    });
    if (!created.session_id || created.status !== "running") {
      throw new Error("expected running session from POST /api/sessions");
    }

    const sessionId = created.session_id;
    const encoded = encodeURIComponent(sessionId);

    // Wait for engine.run() to emit session_started before sending interjection/cancel
    const eventDeadline = Date.now() + 5000;
    let started = false;
    while (Date.now() < eventDeadline) {
      const resp = await fetchJson(`/api/sessions/${encoded}/events`);
      if (resp.events && resp.events.some((e) => e.type === "session_started")) {
        started = true;
        break;
      }
      await wait(100);
    }
    if (!started) {
      throw new Error("session_started event not emitted within 5s");
    }

    // POST interjection
    await fetchJson(`/api/sessions/${encoded}/interjections`, {
      method: "POST",
      body: JSON.stringify({ content: "host note from smoke" }),
    });

    // POST cancel
    await fetchJson(`/api/sessions/${encoded}/cancel`, {
      method: "POST",
      body: JSON.stringify({}),
    });

    // Wait briefly for async engine to process
    await wait(500);

    // Verify events contain interjection and cancel
    const eventsResp = await fetchJson(`/api/sessions/${encoded}/events`);
    if (!eventsResp.events || !eventsResp.events.some((e) => e.type === "user_interjection")) {
      throw new Error("expected user_interjection event");
    }
    if (!eventsResp.events || !eventsResp.events.some((e) => e.type === "session_cancel_requested")) {
      throw new Error("expected session_cancel_requested event");
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
