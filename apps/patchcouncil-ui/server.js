const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const url = require("node:url");
const { findProjectRoot } = require("./engine/config");

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

function handleApi(req, res, parsed) {
  const pathname = decodeURIComponent(parsed.pathname || "/");
  const query = parsed.query || {};

  if (pathname === "/api/sessions") {
    sendJson(res, 200, { sessions: listSessions() });
    return true;
  }

  const match = pathname.match(/^\/api\/sessions\/([^/]+)\/events$/);
  if (match) {
    const sessionId = decodeURIComponent(match[1]);
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

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url || "/", true);
  const pathname = decodeURIComponent(parsed.pathname || "/");

  try {
    if (handleApi(req, res, parsed)) {
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
