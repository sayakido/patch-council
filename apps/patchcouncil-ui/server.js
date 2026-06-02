const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const url = require("node:url");
const { findProjectRoot, loadConfig, saveConfig } = require("./engine/config");
const { SessionStore } = require("./engine/session-store");
const { CouncilEngine } = require("./engine/council");
const { JsonlSink, StateSnapshotSink } = require("./engine/event-sink");
const { runCliRuntime } = require("./src/runtime/cli-adapter");
const { EVENTS } = require("./engine/events");
const { generateWorkplanForSession } = require("./engine/workplan");
const prompts = require("./engine/prompts");

const root = __dirname;
const publicDir = path.join(root, "public");
const mockSessionRoot = path.join(root, "mock-sessions");
const port = Number(process.env.PATCHCOUNCIL_UI_PORT || 8765);
const host = process.env.PATCHCOUNCIL_UI_HOST || "127.0.0.1";

let projectRoot;
let realSessionRoot;
try {
  projectRoot = findProjectRoot();
  realSessionRoot = path.join(projectRoot, ".project-ai", "sessions");
} catch {
  realSessionRoot = null;
}

const mimeByExt = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value, null, 2), {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
}

function safeJoin(base, requestPath) {
  const resolved = path.resolve(base, requestPath);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    return null;
  }
  return resolved;
}

const activeSessions = new Map();
const activeWorkplans = new Set();

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body.trim()) return resolve({});
      try {
        const parsed = JSON.parse(body);
        resolve(typeof parsed === "object" && parsed !== null ? parsed : {});
      } catch (error) { reject(new Error("invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

function makeRuntimeRunner(projectRoot, activeSession) {
  return async (agentName, agentConfig, prompt) => {
    if (process.env.PATCHCOUNCIL_FAKE_RUNTIME === "1") {
      await new Promise((r) => setTimeout(r, 50));

      if (prompt.includes("drafting a writing-plans-style")) {
        return {
          ok: true,
          text: [
            "# Smoke Workplan Implementation Plan",
            "",
            "**Source Design:** docs/designs/smoke.md",
            "**Source Design Commit:** abc123",
            "**Goal:** Verify Workplan Council.",
            "**Architecture:** Use fake runtime.",
            "**Tech Stack:** Node.js",
            "",
            "---",
            "",
            "## File Structure",
            "",
            "- Modify: `apps/patchcouncil-ui/server.js` - API route.",
            "",
            "### Task 1: Verify API",
            "",
            "- [ ] **Step 1: Run smoke**",
            "",
            "Run: `npm run smoke`",
            "Expected: PASS",
            "",
            "## Self-Review",
            "",
            "- Spec coverage: covered",
            "- Placeholder scan: clean",
            "- Type / naming consistency: consistent",
            "- Scope check: scoped",
          ].join("\n"),
        };
      }
      if (prompt.includes("reviewing a PatchCouncil Markdown workplan")) {
        return { ok: true, text: JSON.stringify({ stance: "agree", confidence: "high", finalize_readiness: "ready", blockers: [], agreements: ["Plan follows contract."], disagreements: [], recommended_next_step: "request user approval", analysis: "The workplan is ready for user approval." }) };
      }
      if (prompt.includes("Review the reviewer findings and decide whether to accept")) {
        return { ok: true, text: JSON.stringify({ decision: "accept", reason: "Reviewer finding is valid.", revision_required: true, stance: "agree", confidence: "high", finalize_readiness: "not_ready", blockers: [], agreements: ["Apply reviewer finding."], disagreements: [], recommended_next_step: "revise workplan", analysis: "The author accepts the review and will revise the workplan." }) };
      }
      if (prompt.includes("finalizing a PatchCouncil workplan review loop")) {
        return { ok: true, text: JSON.stringify({ decision: "finalize", next_agent: null, role: null, reason: "ready for user approval" }) };
      }

      // Design council brainstorming prelude
      if (prompt.includes("brainstorming prelude")) {
        return { ok: true, text: JSON.stringify({ decision: "draft_design", reason: "smoke test skips questions", known_context: ["smoke"], missing_context: [] }) };
      }
      // Design draft
      if (prompt.includes("writing a Markdown design doc for PatchCouncil")) {
        return { ok: true, text: "# Smoke Design\n\n## Goal\n\nVerify Workplan Council end-to-end.\n\n## Scope\n\nHTTP API and event flow.\n" };
      }
      // Design revision
      if (prompt.includes("Revise the design Markdown") || prompt.includes("revise the design")) {
        return { ok: true, text: "# Smoke Design v2\n\n## Goal\n\nVerify Workplan Council end-to-end with revisions.\n\n## Scope\n\nHTTP API, event flow, and approval.\n" };
      }

      // Return valid JSON for coordinator prompts, plain text for agent turns
      if (prompt.includes("下一位") && prompt.includes("coordinator")) {
        return { ok: true, text: JSON.stringify({ decision: "continue", next_agent: "codex", role: "analyze", reason: "fake route" }) };
      }
      if (prompt.includes("继续讨论") && prompt.includes("收束")) {
        return { ok: true, text: JSON.stringify({ decision: "finalize", next_agent: null, role: null, reason: "fake decide" }) };
      }
      if (prompt.includes("最终总结")) {
        return { ok: true, text: JSON.stringify({ consensus: "Fake consensus", disagreements: "none", recommended_next_step: "proceed", needs_confirmation: false, next_steps: ["step 1"] }) };
      }

      if (prompt.includes("finalize_readiness") && prompt.includes("blockers") && prompt.includes("analysis")) {
        return {
          ok: true,
          text: JSON.stringify({
            stance: "agree",
            confidence: "high",
            finalize_readiness: "ready",
            blockers: [],
            agreements: ["Fake runtime can provide structured agent signal."],
            disagreements: [],
            recommended_next_step: "Finalize when policy allows.",
            analysis: `Fake response from ${agentName}: structured signal generated for smoke tests.`,
          }),
        };
      }

      return { ok: true, text: `Fake response from ${agentName}: received prompt (${prompt.length} chars)` };
    }

    const turnId = `${activeSession.sessionId}-${agentName}-${Date.now()}`;
    const runtime = runCliRuntime({
      runtime: agentName,
      command: agentConfig.command,
      args: agentConfig.args || [],
      input: prompt,
      input_mode: agentConfig.input_mode,
      cwd: projectRoot,
      timeoutMs: (agentConfig.timeout_sec || 1800) * 1000,
      threadId: `${activeSession.sessionId}-thread`,
      turnId,
    });

    activeSession.currentRun = runtime;
    const result = await runtime.done;
    activeSession.currentRun = null;
    return result;
  };
}

function listSessionsFrom(rootDir) {
  if (!rootDir || !fs.existsSync(rootDir)) return [];
  return fs.readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const statePath = path.join(rootDir, entry.name, "state.json");
      try {
        return JSON.parse(fs.readFileSync(statePath, "utf8"));
      } catch {
        return {
          session_id: entry.name,
          status: "error",
          phase: "finalized",
          topic: "Unreadable session",
          started_at: "",
          finished_at: null,
          turn_count: 0,
          distinct_agents: [],
          last_seq: -1,
          outcome: "error",
          error_count: 1,
        };
      }
    });
}

function listSessions() {
  const seen = new Set();
  const sessions = [];

  // real sessions first, then mock
  for (const rootDir of [realSessionRoot, mockSessionRoot]) {
    for (const s of listSessionsFrom(rootDir)) {
      if (!seen.has(s.session_id)) {
        seen.add(s.session_id);
        sessions.push(s);
      }
    }
  }

  return sessions.sort((a, b) => String(b.started_at || "").localeCompare(String(a.started_at || "")));
}

function readEventsFrom(rootDir, sessionId, sinceSeq = -1) {
  const dir = safeJoin(rootDir, sessionId);
  if (!dir) return null;
  const jsonlPath = path.join(dir, "transcript.jsonl");
  if (!fs.existsSync(jsonlPath)) return null;
  const lines = fs.readFileSync(jsonlPath, "utf8").split(/\r?\n/).filter(Boolean);
  return lines
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean)
    .filter((e) => e.seq > sinceSeq)
    .sort((a, b) => Number(a.seq) - Number(b.seq));
}

function readSessionEvents(sessionId, sinceSeq = -1) {
  // try real sessions first, then mock
  let events = readEventsFrom(realSessionRoot, sessionId, sinceSeq);
  if (!events) events = readEventsFrom(mockSessionRoot, sessionId, sinceSeq);
  return events;
}

async function handleApi(req, res, parsed) {
  const pathname = decodeURIComponent(parsed.pathname || "/");
  const query = parsed.query || {};

  // GET /api/config
  if (pathname === "/api/config" && req.method === "GET") {
    if (!projectRoot) {
      sendJson(res, 500, { error: "project root not found" });
      return true;
    }
    sendJson(res, 200, loadConfig(projectRoot));
    return true;
  }

  // PUT /api/config
  if (pathname === "/api/config" && req.method === "PUT") {
    if (!projectRoot) {
      sendJson(res, 500, { error: "project root not found" });
      return true;
    }
    const nextConfig = await readJsonBody(req);
    sendJson(res, 200, saveConfig(nextConfig, projectRoot));
    return true;
  }

  // GET /api/sessions
  if (pathname === "/api/sessions" && req.method === "GET") {
    sendJson(res, 200, { sessions: listSessions() });
    return true;
  }

  // POST /api/sessions
  if (pathname === "/api/sessions" && req.method === "POST") {
    if (!projectRoot) {
      sendJson(res, 500, { error: "project root not found" });
      return true;
    }
    const body = await readJsonBody(req);
    const topic = String(body.topic || "").trim();
    if (!topic) {
      sendJson(res, 400, { error: "topic is required" });
      return true;
    }

    // Resolve source metadata for session fork/continue
    let sourceMetadata = null;
    const sourceSessionId = String(body.source_session_id || "").trim();
    if (sourceSessionId) {
      const sourceDir = safeJoin(realSessionRoot, sourceSessionId);
      if (!sourceDir || !fs.existsSync(sourceDir)) {
        sendJson(res, 404, { error: "source session not found" });
        return true;
      }
      sourceMetadata = new SessionStore(realSessionRoot).getSourceMetadata(sourceDir);
    }

    const config = loadConfig(projectRoot);
    const mode = String(body.mode || "council");
    const brainstorming = body.brainstorming && typeof body.brainstorming === "object" ? body.brainstorming : null;
    try {
      CouncilEngine.validateRequiredAgents(config, { mode, brainstorming });
    } catch (error) {
      sendJson(res, 409, { error: error.message });
      return true;
    }

    const sessionStore = new SessionStore(realSessionRoot);
    const session = sessionStore.createSession(topic);

    const controller = {
      sessionId: session.id,
      sessionDir: session.dir,
      sessionStore,
      topic,
      engine: null,
      currentRun: null,
    };

    const engine = new CouncilEngine({
      config,
      sessionStore,
      runAgent: makeRuntimeRunner(projectRoot, controller),
      projectRoot,
      prompts,
      sessionDir: session.dir,
      sessionId: session.id,
      sourceMetadata,
      mode,
      brainstorming,
    });
    controller.engine = engine;

    const jsonlSink = new JsonlSink({ sessionStore, sessionDir: session.dir });
    const stateSink = new StateSnapshotSink({ sessionStore, sessionDir: session.dir });
    engine.on("event", (e) => {
      jsonlSink.consume(e);
      stateSink.consume(e);
    });

    activeSessions.set(session.id, controller);

    sendJson(res, 202, { session_id: session.id, status: "running" });

    setImmediate(async () => {
      try {
        await engine.run(topic);
      } catch (err) {
        console.error(`[patchcouncil-ui] session ${session.id} error:`, err.message);
      } finally {
        if (!controller.engine?.waitingForUser) {
          activeSessions.delete(session.id);
        }
      }
    });

    return true;
  }

  // POST /api/sessions/:id/interjections
  const interjectionMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/interjections$/);
  if (interjectionMatch && req.method === "POST") {
    const sessionId = decodeURIComponent(interjectionMatch[1]);
    const controller = activeSessions.get(sessionId);
    if (!controller) {
      sendJson(res, 409, { error: "session is not running" });
      return true;
    }
    const body = await readJsonBody(req);
    const event = controller.engine.addInterjection(body.content);
    if (!event) {
      sendJson(res, 400, { error: "content is required" });
      return true;
    }
    controller.sessionStore.deriveState(controller.sessionDir);
    sendJson(res, 202, { event });
    return true;
  }

  // POST /api/sessions/:id/cancel
  const cancelMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/cancel$/);
  if (cancelMatch && req.method === "POST") {
    const sessionId = decodeURIComponent(cancelMatch[1]);
    const controller = activeSessions.get(sessionId);
    if (!controller) {
      sendJson(res, 409, { error: "session is not running" });
      return true;
    }
    const event = controller.engine.requestCancel("user");
    if (controller.currentRun) {
      controller.currentRun.cancel("cancelled by host");
    }
    controller.sessionStore.deriveState(controller.sessionDir);
    sendJson(res, 202, { session_id: sessionId, status: "cancelling", event });
    return true;
  }

  // POST /api/sessions/:id/brainstorming/answer
  const brainstormingAnswerMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/brainstorming\/answer$/);
  if (brainstormingAnswerMatch && req.method === "POST") {
    const sessionId = decodeURIComponent(brainstormingAnswerMatch[1]);
    const controller = activeSessions.get(sessionId);
    if (!controller) {
      sendJson(res, 409, { error: "session is not waiting for brainstorming answer" });
      return true;
    }
    const body = await readJsonBody(req);
    const event = controller.engine.addBrainstormingAnswer(body.content);
    if (!event) {
      sendJson(res, 400, { error: "content is required" });
      return true;
    }
    controller.sessionStore.deriveState(controller.sessionDir);
    sendJson(res, 202, { event });
    setImmediate(async () => {
      try {
        await controller.engine.resumeDesignCouncil(controller.topic);
        controller.sessionStore.deriveState(controller.sessionDir);
        controller.sessionStore.generateTranscript(controller.sessionDir);
      } catch (err) {
        console.error(`[patchcouncil-ui] resume ${sessionId} error:`, err.message);
      } finally {
        if (!controller.engine?.waitingForUser) activeSessions.delete(sessionId);
      }
    });
    return true;
  }

  // POST /api/sessions/:id/workplan
  const workplanMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/workplan$/);
  if (workplanMatch && req.method === "POST") {
    if (!projectRoot || !realSessionRoot) {
      sendJson(res, 500, { error: "project root not found" });
      return true;
    }
    const sessionId = decodeURIComponent(workplanMatch[1]);
    const sessionDir = safeJoin(realSessionRoot, sessionId);
    if (!sessionDir || !fs.existsSync(path.join(sessionDir, "transcript.jsonl"))) {
      sendJson(res, 404, { error: "session not found" });
      return true;
    }
    if (activeWorkplans.has(sessionId)) {
      sendJson(res, 409, { error: "workplan generation already in progress" });
      return true;
    }

    const sessionStore = new SessionStore(realSessionRoot);
    const state = sessionStore.deriveState(sessionDir);
    if (state.mode !== "design_council") {
      sendJson(res, 409, { error: "workplan requires a design_council session" });
      return true;
    }
    if (!state.design || !state.design.latest_commit) {
      sendJson(res, 409, { error: "workplan requires a design commit" });
      return true;
    }
    if (state.workplan && !["none", "failed", "rejected"].includes(state.workplan.status)) {
      sendJson(res, 409, { error: "workplan already exists or is awaiting approval" });
      return true;
    }
    // Session must be done (or failed/rejected) — engine won't process a running session.
    if (state.status === "running") {
      sendJson(res, 409, { error: "session must be done before generating workplan" });
      return true;
    }

    activeWorkplans.add(sessionId);
    sendJson(res, 202, { session_id: sessionId, status: "generating" });

    const config = loadConfig(projectRoot);
    setImmediate(async () => {
      try {
        const result = await generateWorkplanForSession({
          config,
          sessionStore,
          sessionDir,
          sessionId,
          projectRoot,
          topic: state.topic,
          runGit: null,
          prompts,
          runAgent: makeRuntimeRunner(projectRoot, { sessionId, sessionDir, currentRun: null }),
          onEvent: (event) => sessionStore.appendEvent(sessionDir, event),
        });
        if (!result.ok) {
          // Preflight or internal rejection — write a failure event so UI can see it.
          sessionStore.appendEvent(sessionDir, {
            schema_version: 1,
            seq: (sessionStore.readEvents(sessionDir).length || 0),
            type: EVENTS.WORKPLAN_GENERATION_FAILED,
            phase: "finalized",
            session_id: sessionId,
            failed_at: new Date().toISOString(),
            generator: "codex",
            message: result.error || "workplan generation rejected by preflight",
            recoverable: result.status !== 409,
            action: result.status === 409 ? "resolve_preflight" : "retry",
            details: result,
          });
          sessionStore.deriveState(sessionDir);
          sessionStore.generateTranscript(sessionDir);
        }
      } catch (error) {
        console.error(`[patchcouncil-ui] workplan ${sessionId} error:`, error.message);
        sessionStore.appendEvent(sessionDir, {
          schema_version: 1,
          seq: (sessionStore.readEvents(sessionDir).length || 0),
          type: EVENTS.WORKPLAN_GENERATION_FAILED,
          phase: "finalized",
          session_id: sessionId,
          failed_at: new Date().toISOString(),
          generator: "codex",
          message: error.message,
          recoverable: true,
          action: "retry",
          details: {},
        });
        sessionStore.deriveState(sessionDir);
        sessionStore.generateTranscript(sessionDir);
      } finally {
        activeWorkplans.delete(sessionId);
      }
    });

    return true;
  }

  // POST /api/sessions/:id/workplan/approve
  const approveMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/workplan\/approve$/);
  if (approveMatch && req.method === "POST") {
    const sessionId = decodeURIComponent(approveMatch[1]);
    const sessionDir = safeJoin(realSessionRoot, sessionId);
    if (!sessionDir || !fs.existsSync(path.join(sessionDir, "transcript.jsonl"))) {
      sendJson(res, 404, { error: "session not found" });
      return true;
    }
    const sessionStore = new SessionStore(realSessionRoot);
    const state = sessionStore.deriveState(sessionDir);
    if (state.status !== "waiting_for_user" || state.waiting_for !== "workplan_approval") {
      sendJson(res, 409, { error: "session is not waiting for workplan approval" });
      return true;
    }
    if (state.workplan?.approved_commit) {
      sendJson(res, 409, { error: "workplan already approved" });
      return true;
    }
    const eventsList = sessionStore.readEvents(sessionDir);
    const nextSeq = eventsList.reduce((max, event) => Math.max(max, Number(event.seq)), -1) + 1;
    sessionStore.appendEvent(sessionDir, {
      schema_version: 1,
      seq: nextSeq,
      type: EVENTS.WORKPLAN_APPROVED,
      phase: "finalized",
      session_id: sessionId,
      artifact_path: state.workplan.artifact_path,
      approved_commit: state.workplan.latest_commit,
      approved_at: new Date().toISOString(),
      approved_by: "host",
    });
    sessionStore.deriveState(sessionDir);
    sessionStore.generateTranscript(sessionDir);
    sendJson(res, 202, { session_id: sessionId, status: "approved" });
    return true;
  }

  // POST /api/sessions/:id/workplan/reject
  const rejectMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/workplan\/reject$/);
  if (rejectMatch && req.method === "POST") {
    const sessionId = decodeURIComponent(rejectMatch[1]);
    const sessionDir = safeJoin(realSessionRoot, sessionId);
    if (!sessionDir || !fs.existsSync(path.join(sessionDir, "transcript.jsonl"))) {
      sendJson(res, 404, { error: "session not found" });
      return true;
    }
    const body = await readJsonBody(req);
    const sessionStore = new SessionStore(realSessionRoot);
    const state = sessionStore.deriveState(sessionDir);
    if (state.status !== "waiting_for_user" || state.waiting_for !== "workplan_approval") {
      sendJson(res, 409, { error: "session is not waiting for workplan approval" });
      return true;
    }
    const eventsList = sessionStore.readEvents(sessionDir);
    const nextSeq = eventsList.reduce((max, event) => Math.max(max, Number(event.seq)), -1) + 1;
    sessionStore.appendEvent(sessionDir, {
      schema_version: 1,
      seq: nextSeq,
      type: EVENTS.WORKPLAN_APPROVAL_REJECTED,
      phase: "finalized",
      session_id: sessionId,
      artifact_path: state.workplan.artifact_path,
      workplan_commit: state.workplan.latest_commit,
      rejected_at: new Date().toISOString(),
      reason: String(body.reason || "user rejected workplan"),
    });
    sessionStore.deriveState(sessionDir);
    sessionStore.generateTranscript(sessionDir);
    sendJson(res, 202, { session_id: sessionId, status: "rejected" });
    return true;
  }

  // GET /api/sessions/:id/events
  const eventsMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/events$/);
  if (eventsMatch && req.method === "GET") {
    const sessionId = decodeURIComponent(eventsMatch[1]);
    const sinceSeq = query.since ? parseInt(query.since, 10) : -1;
    const events = readSessionEvents(sessionId, sinceSeq);
    if (!events) {
      sendJson(res, 404, { error: "session not found" });
      return true;
    }
    sendJson(res, 200, { events });
    return true;
  }

  return false;
}

function serveStatic(req, res, pathname) {
  const requestPath = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = safeJoin(publicDir, requestPath);
  if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    send(res, 404, "Not found", { "content-type": "text/plain; charset=utf-8" });
    return;
  }
  const ext = path.extname(filePath);
  send(res, 200, fs.readFileSync(filePath), {
    "content-type": mimeByExt[ext] || "application/octet-stream",
    "cache-control": "no-store",
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url || "/", true);
  const pathname = decodeURIComponent(parsed.pathname || "/");

  try {
    if (await handleApi(req, res, parsed)) {
      return;
    }
    serveStatic(req, res, pathname);
  } catch (error) {
    sendJson(res, 500, { error: error.message || "internal error" });
  }
});

server.listen(port, host, () => {
  const sources = [];
  if (realSessionRoot) sources.push(realSessionRoot);
  sources.push(mockSessionRoot);
  console.log(`[patchcouncil-ui] http://${host}:${port}`);
  console.log(`[patchcouncil-ui] session sources: ${sources.join(", ")}`);
});
