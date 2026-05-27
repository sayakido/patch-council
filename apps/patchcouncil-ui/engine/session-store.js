"use strict";

const fs = require("fs");
const path = require("path");

function nowLocal() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}${mm}${dd}-${hh}${min}`;
}

function slugify(text) {
  let s = text.toLowerCase();
  s = s.replace(/\s+/g, "-");
  s = s.replace(/[^a-z0-9一-鿿\-]/g, "");
  s = s.replace(/-+/g, "-");
  s = s.replace(/^-|-$/g, "");
  return s.slice(0, 60);
}

class SessionStore {
  constructor(sessionsRoot) {
    this.root = sessionsRoot;
  }

  createSession(topic) {
    const stamp = nowLocal();
    const slug = slugify(topic) || "council";
    let id = `${stamp}-${slug}`;
    let dir = path.join(this.root, id);

    let suffix = 2;
    while (fs.existsSync(dir)) {
      id = `${stamp}-${slug}-${suffix}`;
      dir = path.join(this.root, id);
      suffix++;
    }

    fs.mkdirSync(dir, { recursive: true });
    return { id, dir };
  }

  appendEvent(sessionDir, event) {
    const line = JSON.stringify(event) + "\n";
    fs.appendFileSync(path.join(sessionDir, "transcript.jsonl"), line, "utf8");
  }

  readEvents(sessionDir, sinceSeq = -1) {
    const jsonlPath = path.join(sessionDir, "transcript.jsonl");
    if (!fs.existsSync(jsonlPath)) return [];

    const raw = fs.readFileSync(jsonlPath, "utf8");
    const events = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed);
        if (event.seq > sinceSeq) {
          events.push(event);
        }
      } catch (_) {
        // skip corrupt lines
      }
    }
    events.sort((a, b) => a.seq - b.seq);
    return events;
  }

  deriveState(sessionDir) {
    const allEvents = this.readEvents(sessionDir);

    const sessionStarted = allEvents.find((e) => e.type === "session_started");
    const sessionFinished = allEvents.find((e) => e.type === "session_finished");

    const sessionId = sessionStarted ? sessionStarted.session_id : path.basename(sessionDir);
    const topic = sessionStarted ? sessionStarted.topic : "";
    const startedAt = sessionStarted ? sessionStarted.started_at : null;
    const finishedAt = sessionFinished ? sessionFinished.finished_at : null;

    const lastEvent = allEvents.length > 0 ? allEvents[allEvents.length - 1] : null;
    const phase = lastEvent ? lastEvent.phase : "discussion";

    let status = "running";
    if (sessionFinished) {
      const outcome = sessionFinished.outcome;
      status = outcome === "error" || outcome === "cancelled" ? outcome : "done";
    } else if (allEvents.some((e) => e.type === "session_error")) {
      status = "error";
    }

    const agentTurnCompletedEvents = allEvents.filter((e) => e.type === "agent_turn_completed");
    const turnCount = agentTurnCompletedEvents.length;

    const distinctAgents = [...new Set(agentTurnCompletedEvents.map((e) => e.agent))];

    const lastSeq = lastEvent ? lastEvent.seq : -1;

    const outcome = sessionFinished ? sessionFinished.outcome : null;

    const errorCount = allEvents.filter(
      (e) => e.type === "agent_error" || e.type === "coordinator_error" || e.type === "session_error"
    ).length;

    const state = {
      session_id: sessionId,
      status,
      phase,
      topic,
      started_at: startedAt,
      finished_at: finishedAt,
      turn_count: turnCount,
      distinct_agents: distinctAgents,
      last_seq: lastSeq,
      outcome,
      error_count: errorCount,
    };

    fs.writeFileSync(path.join(sessionDir, "state.json"), JSON.stringify(state, null, 2), "utf8");
    return state;
  }

  generateTranscript(sessionDir) {
    const allEvents = this.readEvents(sessionDir);
    const lines = [];

    for (const event of allEvents) {
      switch (event.type) {
        case "session_started":
          lines.push(`# Council Session: ${event.topic}`);
          lines.push("");
          lines.push(`**Session ID:** ${event.session_id}`);
          lines.push(`**Started:** ${event.started_at}`);
          lines.push(`**Mode:** ${event.mode}`);
          lines.push("");
          break;

        case "coordinator_decided":
          lines.push(`## Coordinator (${event.coordinator}) — ${event.decision}`);
          lines.push("");
          if (event.next_agent) {
            lines.push(`**Next agent:** ${event.next_agent}`);
          }
          if (event.role) {
            lines.push(`**Role:** ${event.role}`);
          }
          lines.push(`**Reason:** ${event.reason}`);
          lines.push("");
          break;

        case "agent_turn_completed":
          lines.push(`## ${event.agent} (turn ${event.turn})`);
          lines.push("");
          lines.push(event.content);
          lines.push("");
          break;

        case "policy_override":
          lines.push(`## Policy Override: ${event.policy}`);
          lines.push("");
          lines.push(`**Decision:** ${event.original_decision} → ${event.new_decision}`);
          if (event.selected_agent) {
            lines.push(`**Selected agent:** ${event.selected_agent}`);
          }
          lines.push(`**Reason:** ${event.reason}`);
          lines.push("");
          break;

        case "finalized":
          lines.push("## Final Summary");
          lines.push("");
          lines.push(event.summary);
          if (event.next_steps && event.next_steps.length > 0) {
            lines.push("");
            lines.push("### Next Steps");
            for (const step of event.next_steps) {
              lines.push(`- ${step}`);
            }
          }
          lines.push("");
          break;

        case "session_finished":
          lines.push("---");
          lines.push("");
          lines.push(`**Outcome:** ${event.outcome}`);
          lines.push(`**Turns:** ${event.turn_count} | **Agents:** ${event.distinct_agents.join(", ")} | **Errors:** ${event.error_count}`);
          lines.push(`**Finished:** ${event.finished_at}`);
          break;

        case "agent_error":
        case "coordinator_error":
        case "session_error":
          lines.push(`## Error: ${event.type}`);
          lines.push("");
          lines.push(`**Message:** ${event.message}`);
          lines.push(`**Action:** ${event.action}`);
          lines.push(`**Recoverable:** ${event.recoverable}`);
          lines.push("");
          break;
      }
    }

    const md = lines.join("\n");
    fs.writeFileSync(path.join(sessionDir, "transcript.md"), md, "utf8");
    return md;
  }
}

module.exports = { SessionStore, nowLocal, slugify };
