const els = {
  refreshButton: document.getElementById("refreshButton"),
  sessionList: document.getElementById("sessionList"),
  sessionTitle: document.getElementById("sessionTitle"),
  phaseBadge: document.getElementById("phaseBadge"),
  eventCount: document.getElementById("eventCount"),
  timeline: document.getElementById("timeline"),
  statusGrid: document.getElementById("statusGrid"),
  agentList: document.getElementById("agentList"),
  latestSignal: document.getElementById("latestSignal"),
};

let activeSessionId = "";
let sessions = [];

async function fetchJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function loadSessions() {
  const data = await fetchJson("/api/sessions");
  sessions = Array.isArray(data.sessions) ? data.sessions : [];
  renderSessions();
  if (!activeSessionId && sessions[0]) {
    await selectSession(sessions[0].session_id);
  } else if (activeSessionId) {
    await selectSession(activeSessionId);
  }
}

function renderSessions() {
  els.sessionList.replaceChildren();
  for (const session of sessions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "session-card";
    button.classList.toggle("active", session.session_id === activeSessionId);
    button.innerHTML = `
      <span class="session-title">${escapeHtml(session.topic || session.session_id)}</span>
      <span class="session-meta">
        <span>${escapeHtml(session.status || "unknown")}</span>
        <span>${escapeHtml(session.phase || "unknown")}</span>
        <span>${Number(session.turn_count || 0)} turns</span>
      </span>
    `;
    button.addEventListener("click", () => selectSession(session.session_id));
    els.sessionList.append(button);
  }
}

async function selectSession(sessionId) {
  activeSessionId = sessionId;
  renderSessions();
  const session = sessions.find((item) => item.session_id === sessionId);
  if (!session) return;

  const data = await fetchJson(`/api/sessions/${encodeURIComponent(sessionId)}/events`);
  const events = Array.isArray(data.events) ? data.events : [];

  renderHeader(session);
  renderStatus(session, events);
  renderTimeline(events);
}

function renderHeader(session) {
  els.sessionTitle.textContent = session.topic || session.session_id;
  els.phaseBadge.textContent = session.phase || "unknown";
}

function renderStatus(session, events) {
  const latest = events[events.length - 1];
  const active = findActiveWork(events);
  const rows = [
    ["Status", session.status],
    ["Phase", session.phase],
    ["Outcome", session.outcome || "pending"],
    ["Turns", String(session.turn_count || 0)],
    ["Last seq", String(session.last_seq ?? "")],
    ["Active", active || "none"],
  ];

  els.statusGrid.replaceChildren(...rows.flatMap(([key, value]) => {
    const dt = document.createElement("dt");
    dt.textContent = key;
    const dd = document.createElement("dd");
    dd.textContent = value || "";
    return [dt, dd];
  }));

  els.agentList.replaceChildren();
  for (const agent of session.distinct_agents || []) {
    const tag = document.createElement("span");
    tag.className = "tag agent";
    tag.textContent = agent;
    els.agentList.append(tag);
  }
  if (!els.agentList.childElementCount) {
    els.agentList.textContent = "No agents yet.";
  }

  els.latestSignal.textContent = latest ? summarizeEvent(latest).title : "No events loaded.";
}

function findActiveWork(events) {
  const reversed = [...events].reverse();
  const started = reversed.find((event) => event.type === "agent_turn_started" || event.type === "coordinator_turn_started");
  if (!started) return "";
  if (started.type === "agent_turn_started") {
    return `${started.agent} turn ${started.turn}`;
  }
  return `${started.coordinator} ${started.purpose}`;
}

function renderTimeline(events) {
  els.eventCount.textContent = `${events.length} events`;
  els.timeline.replaceChildren(...events.map(renderEvent));
}

function renderEvent(event) {
  const li = document.createElement("li");
  li.className = "event";

  const meta = document.createElement("div");
  meta.className = "event-meta";
  meta.innerHTML = `
    <span class="event-type">#${event.seq} ${escapeHtml(event.type)}</span>
    <span>${escapeHtml(event.phase || "")}</span>
  `;

  const body = document.createElement("div");
  body.className = "event-body";
  const summary = summarizeEvent(event);

  const title = document.createElement("div");
  title.className = "event-title";
  title.textContent = summary.title;

  const text = document.createElement("p");
  text.className = "event-text";
  const pre = document.createElement("pre");
  pre.textContent = summary.text;
  text.append(pre);

  const tags = document.createElement("div");
  tags.className = "agent-list";
  for (const tag of summary.tags) {
    const item = document.createElement("span");
    item.className = `tag ${tag.kind || ""}`;
    item.textContent = tag.label;
    tags.append(item);
  }

  body.append(title, text);
  if (summary.tags.length) body.append(tags);
  li.append(meta, body);
  return li;
}

function summarizeEvent(event) {
  switch (event.type) {
    case "session_started":
      return {
        title: "Session started",
        text: event.topic,
        tags: [{ label: event.mode }, { label: `${event.agents?.length || 0} agents` }],
      };
    case "coordinator_turn_started":
      return {
        title: `${event.coordinator} starts ${event.purpose}`,
        text: `turn ${event.turn}`,
        tags: [{ label: "coordinator" }],
      };
    case "coordinator_decided":
      return {
        title: `${event.coordinator} decided ${event.decision}`,
        text: [event.reason, event.next_agent ? `next: ${event.next_agent}` : "", event.role ? `role: ${event.role}` : ""].filter(Boolean).join("\n"),
        tags: [{ label: event.decision }],
      };
    case "coordinator_turn_completed":
      return {
        title: `${event.coordinator} completed ${event.purpose}`,
        text: `${event.status} · ${event.duration_ms}ms`,
        tags: [{ label: event.status, kind: event.status === "error" ? "error" : "" }],
      };
    case "policy_override":
      return {
        title: `${event.policy} policy override`,
        text: `${event.original_decision} -> ${event.new_decision}\n${event.reason}`,
        tags: [{ label: "policy", kind: "policy" }, event.selected_agent ? { label: event.selected_agent, kind: "agent" } : null].filter(Boolean),
      };
    case "agent_turn_started":
      return {
        title: `${event.agent} starts turn ${event.turn}`,
        text: `${event.role}\nselected by ${event.selected_by}: ${event.selection_reason}`,
        tags: [{ label: event.agent, kind: "agent" }, { label: event.selected_by }],
      };
    case "agent_turn_completed":
      return {
        title: `${event.agent} completed turn ${event.turn}`,
        text: event.content,
        tags: [{ label: event.agent, kind: "agent" }, { label: `${event.duration_ms}ms` }],
      };
    case "finalization_started":
      return {
        title: "Finalization started",
        text: `${event.turn_count} turns discussed`,
        tags: [{ label: "final" }],
      };
    case "finalized":
      return {
        title: "Discussion finalized",
        text: `${event.summary}\n\nNext:\n${(event.next_steps || []).map((step) => `- ${step}`).join("\n")}`,
        tags: [{ label: "summary" }],
      };
    case "session_finished":
      return {
        title: "Session finished",
        text: `${event.outcome}\n${event.turn_count} turns · ${event.distinct_agents?.join(", ") || "no agents"}`,
        tags: [{ label: event.outcome }],
      };
    case "agent_error":
    case "coordinator_error":
    case "session_error":
      return {
        title: event.type,
        text: `${event.message}\naction: ${event.action}`,
        tags: [{ label: "error", kind: "error" }, { label: event.recoverable ? "recoverable" : "fatal" }],
      };
    default:
      return {
        title: event.type || "Unknown event",
        text: JSON.stringify(event, null, 2),
        tags: [],
      };
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

els.refreshButton.addEventListener("click", () => {
  loadSessions().catch((error) => {
    els.latestSignal.textContent = error.message;
  });
});

loadSessions().catch((error) => {
  els.latestSignal.textContent = error.message;
});
