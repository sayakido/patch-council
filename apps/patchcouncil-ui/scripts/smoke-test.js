const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { findProjectRoot } = require("../engine/config");

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
    if (!html.includes("PatchCouncil Workbench")) {
      throw new Error("index html did not render workbench title");
    }
    if (!html.includes("composerInput")) {
      throw new Error("index html missing workbench composer");
    }

    const appJs = await fetchText("/app.js");
    if (!appJs.includes("Generate Workplan")) {
      throw new Error("app js missing workplan action text");
    }
    if (!appJs.includes("signal-meta")) {
      throw new Error("app js missing signal metadata rendering");
    }

    // Config page
    var configHtml = await fetchText("/config.html");
    if (!configHtml.includes("PatchCouncil Config")) {
      throw new Error("config html did not render expected title");
    }
    if (!configHtml.includes("maxTurnsInput")) {
      throw new Error("config html missing max turns input");
    }

    // GET /api/config
    const config = await fetchJson("/api/config");
    if (!config.council || !config.agents) {
      throw new Error("expected config response with council and agents");
    }

    // PUT /api/config
    // Save raw config file to restore byte-for-byte after test
    const projectRoot = findProjectRoot();
    const configPath = path.join(projectRoot, ".project-ai", "config.yaml");
    let originalConfigRaw = null;
    try { originalConfigRaw = fs.readFileSync(configPath); } catch {}
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
      // Restore original config byte-for-byte
      if (originalConfigRaw !== null) {
        fs.writeFileSync(configPath, originalConfigRaw);
      }
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

    // Wait for the first session to finish (it gets cancelled so it should finish fast)
    await wait(2000);

    // Create a fork session
    const continued = await fetchJson("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ topic: "continued discussion", mode: "council", source_session_id: sessionId }),
    });
    if (!continued.session_id || continued.status !== "running") {
      throw new Error("expected running session from continued POST /api/sessions");
    }

    // Verify source metadata in session_started event
    const continuedEvents = await fetchJson(`/api/sessions/${encodeURIComponent(continued.session_id)}/events`);
    const startedEvent = (continuedEvents.events || []).find((e) => e.type === "session_started");
    if (!startedEvent) {
      throw new Error("continued session missing session_started event");
    }
    // The source_session_id and source_summary should be present
    if (!startedEvent.source_session_id) {
      throw new Error("continued session_started missing source_session_id");
    }

    // Workplan generation
    const planSession = await fetchJson("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ topic: "workplan smoke topic", mode: "council" }),
    });
    const planSessionId = planSession.session_id;
    const planEncoded = encodeURIComponent(planSessionId);

    const doneDeadline = Date.now() + 8000;
    let doneState = null;
    while (Date.now() < doneDeadline) {
      const all = await fetchJson("/api/sessions");
      doneState = all.sessions.find((item) => item.session_id === planSessionId);
      if (doneState && doneState.status === "done") break;
      await wait(200);
    }
    if (!doneState || doneState.status !== "done") {
      throw new Error("workplan smoke session did not finish");
    }

    const planEventsResp = await fetchJson(`/api/sessions/${planEncoded}/events`);
    const completedTurn = (planEventsResp.events || []).find((e) => e.type === "agent_turn_completed");
    if (completedTurn && !completedTurn.signal) {
      throw new Error("expected agent_turn_completed signal");
    }

    const startedWorkplan = await fetchJson(`/api/sessions/${planEncoded}/workplan`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    if (startedWorkplan.status !== "generating") {
      throw new Error("expected workplan generation status");
    }

    const workplanDeadline = Date.now() + 5000;
    let workplanEvents = [];
    while (Date.now() < workplanDeadline) {
      const resp = await fetchJson(`/api/sessions/${planEncoded}/events`);
      workplanEvents = resp.events || [];
      if (workplanEvents.some((event) => event.type === "workplan_created")) break;
      await wait(200);
    }
    if (!workplanEvents.some((event) => event.type === "workplan_created")) {
      throw new Error("expected workplan_created event");
    }

    let duplicateRejected = false;
    try {
      await fetchJson(`/api/sessions/${planEncoded}/workplan`, { method: "POST", body: JSON.stringify({}) });
    } catch (error) {
      duplicateRejected = /409/.test(error.message);
    }
    if (!duplicateRejected) {
      throw new Error("expected duplicate workplan generation to return 409");
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
