const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { findProjectRoot } = require("../engine/config");
const { slugifyDesignTopic } = require("../engine/design-council");

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
    if (!appJs.includes("Approve Workplan")) {
      throw new Error("app js missing workplan approval action");
    }
    if (!appJs.includes("workplan_approval_requested")) {
      throw new Error("app js missing workplan artifact projection");
    }
    if (!appJs.includes("Responding to workplan review")) {
      throw new Error("app js missing workplan author response state");
    }
    if (!appJs.includes("Workplan approved")) {
      throw new Error("app js missing approved workplan state");
    }
    if (!appJs.includes("Workplan rejected")) {
      throw new Error("app js missing rejected workplan state");
    }
    if (!appJs.includes("Workplan generation failed")) {
      throw new Error("app js missing failed workplan state");
    }
    if (!appJs.includes("signal-meta")) {
      throw new Error("app js missing signal metadata rendering");
    }
    if (!appJs.includes("lead responding to design review")) {
      throw new Error("app js missing design author response status");
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

    // Workplan Council generation
    const planSession = await fetchJson("/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        topic: "workplan council smoke topic",
        mode: "design_council",
        brainstorming: { lead_agent: "codex", max_questions: 1 },
      }),
    });
    const planSessionId = planSession.session_id;
    const planEncoded = encodeURIComponent(planSessionId);

    // Clean up any prior workplan artifact so assertWorkplanWritable passes
    const today = new Date().toISOString().slice(0, 10);
    const workplanSlug = slugifyDesignTopic("workplan council smoke topic");
    const expectedWorkplanPath = path.join(projectRoot, "docs", "workplans", `${today}-${workplanSlug}.md`);
    const expectedDesignPath = path.join(projectRoot, "docs", "designs", `${today}-${workplanSlug}.md`);
    let savedWorkplan = null;
    try { savedWorkplan = fs.readFileSync(expectedWorkplanPath); } catch {}
    if (savedWorkplan !== null) fs.unlinkSync(expectedWorkplanPath);

    const designDeadline = Date.now() + 10000;
    let designState = null;
    while (Date.now() < designDeadline) {
      const all = await fetchJson("/api/sessions");
      designState = all.sessions.find((item) => item.session_id === planSessionId);
      if (designState && designState.status === "done" && designState.design && designState.design.latest_commit) break;
      if (designState && designState.status === "waiting_for_user" && designState.waiting_for === "brainstorming_answer") {
        await fetchJson(`/api/sessions/${planEncoded}/brainstorming/answer`, {
          method: "POST",
          body: JSON.stringify({ content: "主要使用者是本地 Workbench 用户，第一版只生成 workplan，不执行代码。" }),
        });
      }
      await wait(200);
    }
    if (!designState || designState.status !== "done" || !designState.design || !designState.design.latest_commit) {
      throw new Error("design council smoke session did not produce a design commit");
    }

    var designEvents = await fetchJson(`/api/sessions/${planEncoded}/events`);
    if (!(designEvents.events || []).some(function (e) { return e.type === "design_author_response_completed"; })) {
      throw new Error("transcript missing design author response");
    }

    const startedWorkplan = await fetchJson(`/api/sessions/${planEncoded}/workplan`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    if (startedWorkplan.status !== "generating") {
      throw new Error("expected workplan generation status");
    }

    const workplanDeadline = Date.now() + 8000;
    let workplanEvents = [];
    while (Date.now() < workplanDeadline) {
      const resp = await fetchJson(`/api/sessions/${planEncoded}/events`);
      workplanEvents = resp.events || [];
      if (workplanEvents.some((event) => event.type === "workplan_approval_requested")) break;
      await wait(200);
    }
    const approval = workplanEvents.find((event) => event.type === "workplan_approval_requested");
    if (!approval) {
      throw new Error("expected workplan_approval_requested event");
    }
    if (workplanEvents.some((event) => event.type === "workplan_created")) {
      throw new Error("new workplan flow must not emit legacy workplan_created");
    }

    await fetchJson(`/api/sessions/${planEncoded}/workplan/approve`, {
      method: "POST",
      body: JSON.stringify({}),
    });

    let duplicateRejected = false;
    try {
      await fetchJson(`/api/sessions/${planEncoded}/workplan`, { method: "POST", body: JSON.stringify({}) });
    } catch (error) {
      duplicateRejected = /409/.test(error.message);
    }
    if (!duplicateRejected) {
      throw new Error("expected duplicate workplan generation to return 409");
    }

    // Clean up generated artifacts (always delete, don't restore)
    try { fs.unlinkSync(expectedWorkplanPath); } catch {}
    try { fs.unlinkSync(expectedDesignPath); } catch {}

    console.log("smoke ok");
  } catch (error) {
    if (stderr.trim()) {
      console.error("[server stderr]", stderr.trim());
    }
    throw error;
  } finally {
    child.kill();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
