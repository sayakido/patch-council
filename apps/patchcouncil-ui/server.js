const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const url = require("node:url");

const root = __dirname;
const publicDir = path.join(root, "public");
const sessionRoot = path.join(root, "mock-sessions");
const port = Number(process.env.PATCHCOUNCIL_UI_PORT || 8765);
const host = process.env.PATCHCOUNCIL_UI_HOST || "127.0.0.1";

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

function listSessions() {
  if (!fs.existsSync(sessionRoot)) {
    return [];
  }
  return fs.readdirSync(sessionRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const statePath = path.join(sessionRoot, entry.name, "state.json");
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
    })
    .sort((a, b) => String(b.started_at || "").localeCompare(String(a.started_at || "")));
}

function readSessionEvents(sessionId) {
  const dir = safeJoin(sessionRoot, sessionId);
  if (!dir) {
    return null;
  }
  const jsonlPath = path.join(dir, "transcript.jsonl");
  if (!fs.existsSync(jsonlPath)) {
    return null;
  }
  const lines = fs.readFileSync(jsonlPath, "utf8").split(/\r?\n/).filter(Boolean);
  return lines.map((line) => JSON.parse(line)).sort((a, b) => Number(a.seq) - Number(b.seq));
}

function handleApi(req, res, pathname) {
  if (pathname === "/api/sessions") {
    sendJson(res, 200, { sessions: listSessions() });
    return true;
  }

  const match = pathname.match(/^\/api\/sessions\/([^/]+)\/events$/);
  if (match) {
    const events = readSessionEvents(decodeURIComponent(match[1]));
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
  const parsed = url.parse(req.url || "/");
  const pathname = decodeURIComponent(parsed.pathname || "/");

  try {
    if (handleApi(req, res, pathname)) {
      return;
    }
    serveStatic(req, res, pathname);
  } catch (error) {
    sendJson(res, 500, { error: error.message || "internal error" });
  }
});

server.listen(port, host, () => {
  console.log(`[patchcouncil-ui] http://${host}:${port}`);
  console.log("[patchcouncil-ui] serving mock sessions only");
});
