// --- State ---
let activeSessionId = "";
let activeEvents = [];
let sessions = [];
let pollInterval = null;
let lastPollSeq = -1;
let rawEventsVisible = false;
let discussionExpanded = false;
let globalConfig = null;

// --- Element refs ---
const els = {
  refreshButton: document.getElementById("refreshButton"),
  newCouncilButton: document.getElementById("newCouncilButton"),
  sessionList: document.getElementById("sessionList"),
  sessionTitle: document.getElementById("sessionTitle"),
  phaseBadge: document.getElementById("phaseBadge"),
  threadBody: document.getElementById("threadBody"),
  composerForm: document.getElementById("composerForm"),
  composerInput: document.getElementById("composerInput"),
  composerButton: document.getElementById("composerButton"),
  statusGrid: document.getElementById("statusGrid"),
  agentList: document.getElementById("agentList"),
  latestSignal: document.getElementById("latestSignal"),
  cancelButton: document.getElementById("cancelButton"),
  rawEventsButton: document.getElementById("rawEventsButton"),
  rawEvents: document.getElementById("rawEvents"),
  workspace: document.getElementById("workspace"),
};

// --- API helpers ---
async function fetchJson(path, options = {}) {
  const response = await fetch(path, {
    cache: "no-store",
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `${response.status} ${response.statusText}`);
  return data;
}

async function postJson(path, body) {
  return fetchJson(path, { method: "POST", body: JSON.stringify(body || {}) });
}

// --- Event projection ---
function projectEvent(event) {
  switch (event.type) {
    case "session_started":
      return { kind: "topic", speaker: "Topic", text: event.topic, agent: null };
    case "user_interjection":
      return { kind: "host", speaker: "Host", text: event.content, agent: null };
    case "agent_turn_completed":
      return { kind: "agent", speaker: event.agent, text: event.content, agent: event.agent, signal: event.signal || null, signalParseError: event.signal_parse_error || "" };
    case "finalized":
      return {
        kind: "summary",
        speaker: "Summary",
        text: event.summary + "\n\n" + (event.next_steps || []).map(function (s) { return "- " + s; }).join("\n"),
        agent: null,
      };
    case "coordinator_decided":
      return {
        kind: "system",
        speaker: "Coordinator",
        text: (event.coordinator || "") + ": " + (event.decision || "") + (event.next_agent ? " → " + event.next_agent : "") + " — " + (event.reason || ""),
        agent: null,
      };
    case "policy_override":
      return {
        kind: "system",
        speaker: "Policy",
        text: (event.original_decision || "") + " → " + (event.new_decision || "") + ": " + (event.reason || ""),
        agent: null,
      };
    case "agent_error":
    case "coordinator_error":
    case "session_error":
      return { kind: "error", speaker: "Error", text: (event.message || "") + " (" + (event.action || "") + ")", agent: null };
    default:
      return null;
  }
}

// --- Helpers ---
function currentSession() {
  return sessions.find(function (s) { return s.session_id === activeSessionId; }) || null;
}

function isTerminal(session) {
  return session && ["done", "error", "cancelled"].indexOf(session.status) !== -1;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// --- Workplan helpers ---
function latestEvent(type) {
  return [...activeEvents].reverse().find(function (event) { return event.type === type; }) || null;
}

function workplanState() {
  var created = latestEvent("workplan_created");
  if (created) return { status: "created", event: created };
  var failed = latestEvent("workplan_generation_failed");
  var started = latestEvent("workplan_generation_started");
  if (started && (!failed || started.seq > failed.seq)) return { status: "generating", event: started };
  if (failed) return { status: "failed", event: failed };
  return { status: "none", event: null };
}

function renderWorkplanCard(session) {
  var state = workplanState();
  var section = document.createElement("section");
  section.className = "workplan-panel";

  var title = document.createElement("h3");
  title.textContent = "Workplan";
  section.append(title);

  if (!session || session.status !== "done") {
    var muted = document.createElement("p");
    muted.className = "muted";
    muted.textContent = "Workplan is available after a session finishes successfully.";
    section.append(muted);
    return section;
  }

  if (state.status === "none") {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "secondary";
    button.textContent = "Generate Workplan";
    button.addEventListener("click", generateWorkplan);
    section.append(button);
    return section;
  }

  if (state.status === "generating") {
    var muted2 = document.createElement("p");
    muted2.className = "muted";
    muted2.textContent = "Generating workplan...";
    section.append(muted2);
    return section;
  }

  if (state.status === "failed") {
    var error = document.createElement("p");
    error.className = "error-text";
    error.textContent = state.event.message || "Workplan generation failed.";
    var retryBtn = document.createElement("button");
    retryBtn.type = "button";
    retryBtn.className = "secondary";
    retryBtn.textContent = "Generate Workplan";
    retryBtn.addEventListener("click", generateWorkplan);
    section.append(error, retryBtn);
    return section;
  }

  var plan = state.event.workplan || {};
  var heading = document.createElement("h4");
  heading.textContent = plan.title || "Untitled workplan";
  var goal = document.createElement("p");
  goal.textContent = plan.goal || "";
  section.append(heading, goal);

  var tasks = document.createElement("ol");
  tasks.className = "workplan-tasks";
  for (var i = 0; i < (plan.tasks || []).length; i++) {
    var task = plan.tasks[i];
    var item = document.createElement("li");
    var strong = document.createElement("strong");
    strong.textContent = (task.id || "") + " " + (task.title || "Task").trim();
    var desc = document.createElement("p");
    desc.textContent = task.description || "";
    var verify = document.createElement("p");
    verify.className = "muted";
    verify.textContent = "Verify: " + (task.verification || []).join("; ");
    item.append(strong, desc, verify);
    tasks.append(item);
  }
  section.append(tasks);

  var note = document.createElement("p");
  note.className = "muted";
  note.textContent = "Use Continue to discuss revisions in a new session.";
  section.append(note);
  return section;
}

async function generateWorkplan() {
  if (!activeSessionId) return;
  await postJson("/api/sessions/" + encodeURIComponent(activeSessionId) + "/workplan", {});
  await selectSession(activeSessionId);
  pollForWorkplanResult(activeSessionId);
}

function pollForWorkplanResult(sessionId) {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  pollInterval = setInterval(function () {
    if (activeSessionId !== sessionId) {
      clearInterval(pollInterval);
      pollInterval = null;
      return;
    }
    (async function () {
      try {
        var data = await fetchJson("/api/sessions/" + encodeURIComponent(sessionId) + "/events?since=" + lastPollSeq);
        var newEvents = Array.isArray(data.events) ? data.events : [];
        for (var i = 0; i < newEvents.length; i++) {
          activeEvents.push(newEvents[i]);
          lastPollSeq = newEvents[i].seq;
        }
        var state = workplanState();
        if (state.status === "created" || state.status === "failed") {
          clearInterval(pollInterval);
          pollInterval = null;
          await loadSessions();
          renderAll();
        } else {
          renderThread(currentSession(), activeEvents);
          renderRawEvents(activeEvents);
        }
      } catch (_) { /* ignore */ }
    })();
  }, 2000);
}

// --- Markdown rendering ---
function renderMarkdown(text) {
  if (typeof marked !== "undefined") {
    return marked.parse(text);
  }
  // Fallback: escape and wrap in pre if marked is not loaded
  return "<pre>" + escapeHtml(text) + "</pre>";
}

// --- Render a single message ---
function renderMessage(msg) {
  var wrapper = document.createElement("div");

  if (msg.kind === "system") {
    wrapper.className = "message system";
    wrapper.innerHTML = '<span class="system-text">' + escapeHtml(msg.text) + '</span>';
    return wrapper;
  }

  wrapper.className = "message " + msg.kind;

  if (msg.agent) {
    wrapper.setAttribute("data-agent", msg.agent);
  }

  var avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = msg.speaker.slice(0, 2);

  var bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.innerHTML = '<div class="bubble-speaker">' + escapeHtml(msg.speaker) + '</div><div class="bubble-text">' + renderMarkdown(msg.text) + '</div>';

  if (msg.signal) {
    var meta = document.createElement("div");
    meta.className = "signal-meta";
    meta.textContent = [msg.signal.stance, msg.signal.confidence + " confidence", msg.signal.finalize_readiness].filter(Boolean).join(" · ");
    bubble.append(meta);
  }
  if (msg.signalParseError) {
    var parseError = document.createElement("div");
    parseError.className = "signal-error";
    parseError.textContent = "Agent signal parse failed; continuing discussion.";
    bubble.append(parseError);
  }

  if (msg.kind === "host") {
    wrapper.append(bubble, avatar);
  } else {
    wrapper.append(avatar, bubble);
  }

  return wrapper;
}

// --- Render thread (chat area) ---
function renderThread(session, events) {
  els.threadBody.replaceChildren();

  var projected = events.map(projectEvent).filter(Boolean);

  if (!session && events.length === 0) {
    // Idle empty state
    var emptyDiv = document.createElement("div");
    emptyDiv.className = "thread-empty";
    emptyDiv.innerHTML = '<p>输入讨论主题开始新 Council</p>';
    els.threadBody.append(emptyDiv);
    return;
  }

  var isFinished = isTerminal(session);
  var summaries = projected.filter(function (m) { return m.kind === "summary"; });
  var nonSummaries = projected.filter(function (m) { return m.kind !== "summary"; });

  if (isFinished) {
    // Summary cards on top
    for (var i = 0; i < summaries.length; i++) {
      els.threadBody.append(renderMessage(summaries[i]));
    }

    if (session && session.status === "done") {
      els.threadBody.append(renderWorkplanCard(session));
    }

    // Collapsible toggle
    var toggle = document.createElement("button");
    toggle.className = "discussion-toggle";
    toggle.textContent = discussionExpanded ? "收起完整讨论过程" : "展开完整讨论过程";
    toggle.addEventListener("click", function () {
      discussionExpanded = !discussionExpanded;
      renderThread(session, events);
    });
    els.threadBody.append(toggle);

    if (discussionExpanded) {
      for (var j = 0; j < nonSummaries.length; j++) {
        els.threadBody.append(renderMessage(nonSummaries[j]));
      }
    }
  } else {
    // Running: show everything
    for (var k = 0; k < projected.length; k++) {
      els.threadBody.append(renderMessage(projected[k]));
    }
  }

  els.threadBody.scrollTop = els.threadBody.scrollHeight;
}

// --- Update composer for current state ---
function updateComposer() {
  var session = currentSession();
  var workspace = els.workspace;

  if (!activeSessionId) {
    workspace.className = "workspace idle";
    els.composerInput.placeholder = "输入讨论主题...";
    els.composerButton.textContent = "Start Council";
    els.cancelButton.classList.add("hidden");
    els.threadBody.replaceChildren();
    var emptyDiv = document.createElement("div");
    emptyDiv.className = "thread-empty";
    emptyDiv.innerHTML = '<p>输入讨论主题开始新 Council</p>';
    els.threadBody.append(emptyDiv);
    els.sessionTitle.textContent = "New Council";
    els.phaseBadge.textContent = "idle";
  } else if (session && (session.status === "running" || session.status === "cancelling")) {
    workspace.className = "workspace running";
    els.composerInput.placeholder = "输入插话，下一轮生效...";
    els.composerButton.textContent = "Add note";
    els.cancelButton.classList.remove("hidden");
    els.sessionTitle.textContent = session.topic || session.session_id;
    els.phaseBadge.textContent = session.phase || session.status;
  } else {
    workspace.className = "workspace finished";
    els.composerInput.placeholder = "继续讨论...";
    els.composerButton.textContent = "Continue";
    els.cancelButton.classList.add("hidden");
    if (session) {
      els.sessionTitle.textContent = session.topic || session.session_id;
      els.phaseBadge.textContent = session.status || "finished";
    }
  }
}

// --- Render status panel ---
function renderStatus(session, events) {
  var rows = [
    ["Status", session ? session.status : "none"],
    ["Phase", session ? session.phase : ""],
    ["Outcome", session ? (session.outcome || "pending") : ""],
    ["Turns", String(session ? (session.turn_count || 0) : 0)],
    ["Last seq", String(session ? (session.last_seq ?? "") : "")],
  ];

  els.statusGrid.replaceChildren.apply(els.statusGrid, rows.flatMap(function (pair) {
    var dt = document.createElement("dt");
    dt.textContent = pair[0];
    var dd = document.createElement("dd");
    dd.textContent = pair[1] || "";
    return [dt, dd];
  }));

  els.agentList.replaceChildren();
  if (session && session.distinct_agents && session.distinct_agents.length) {
    for (var i = 0; i < session.distinct_agents.length; i++) {
      var tag = document.createElement("span");
      tag.className = "tag agent";
      tag.textContent = session.distinct_agents[i];
      els.agentList.append(tag);
    }
  } else if (globalConfig && globalConfig.agents) {
    // Idle state: show configured agents from config
    var agentNames = Object.keys(globalConfig.agents);
    for (var j = 0; j < agentNames.length; j++) {
      var cfg = globalConfig.agents[agentNames[j]];
      if (cfg.enabled !== false) {
        var tag2 = document.createElement("span");
        tag2.className = "tag agent";
        tag2.textContent = agentNames[j];
        els.agentList.append(tag2);
      }
    }
    if (!els.agentList.childElementCount) {
      els.agentList.textContent = "No agents enabled.";
    }
  } else {
    els.agentList.textContent = "No agents yet.";
  }

  // Show latest coordinator decision
  var lastDecision = null;
  for (var k = events.length - 1; k >= 0; k--) {
    if (events[k].type === "coordinator_decided") {
      lastDecision = events[k];
      break;
    }
  }
  if (lastDecision) {
    els.latestSignal.textContent = (lastDecision.coordinator || "") + ": " + (lastDecision.decision || "") + (lastDecision.next_agent ? " → " + lastDecision.next_agent : "") + " — " + (lastDecision.reason || "");
  } else if (session) {
    els.latestSignal.textContent = "No coordinator decision yet.";
  } else {
    els.latestSignal.textContent = "No events loaded.";
  }
}

// --- Render raw events ---
function renderRawEvents(events) {
  els.rawEvents.classList.toggle("hidden", !rawEventsVisible);
  els.rawEventsButton.textContent = rawEventsVisible ? "Hide raw events" : "Raw events";
  els.rawEvents.replaceChildren.apply(els.rawEvents, events.map(function (event) {
    var li = document.createElement("li");
    var pre = document.createElement("pre");
    pre.textContent = JSON.stringify(event, null, 2);
    li.append(pre);
    return li;
  }));
}

// --- Render all ---
function renderAll() {
  renderSessions();
  updateComposer();
  var session = currentSession();
  renderThread(session, activeEvents);
  renderStatus(session, activeEvents);
  renderRawEvents(activeEvents);
}

// --- Session list rendering ---
function renderSessions() {
  els.sessionList.replaceChildren();
  for (var i = 0; i < sessions.length; i++) {
    var session = sessions[i];
    var button = document.createElement("button");
    button.type = "button";
    button.className = "session-card";
    if (session.session_id === activeSessionId) {
      button.classList.add("active");
    }
    button.innerHTML =
      '<span class="session-title">' + escapeHtml(session.topic || session.session_id) + '</span>' +
      '<span class="session-meta">' +
        '<span>' + escapeHtml(session.status || "unknown") + '</span>' +
        '<span>' + escapeHtml(session.phase || "unknown") + '</span>' +
        '<span>' + Number(session.turn_count || 0) + ' turns</span>' +
      '</span>';
    button.addEventListener("click", (function (id) {
      return function () { selectSession(id); };
    })(session.session_id));
    els.sessionList.append(button);
  }
}

// --- Load config ---
async function loadConfig() {
  try {
    globalConfig = await fetchJson("/api/config");
    if (!activeSessionId) {
      renderStatus(null, []);
    }
  } catch (err) {
    // config load is best-effort
  }
}

// --- Load sessions ---
async function loadSessions() {
  var data = await fetchJson("/api/sessions");
  sessions = Array.isArray(data.sessions) ? data.sessions : [];
  renderSessions();
  if (!activeSessionId && sessions[0]) {
    await selectSession(sessions[0].session_id);
  } else if (activeSessionId) {
    await selectSession(activeSessionId);
  } else {
    renderAll();
  }
}

// --- Select session + start polling ---
async function selectSession(sessionId) {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }

  activeSessionId = sessionId;
  discussionExpanded = false;
  renderSessions();

  var session = sessions.find(function (item) { return item.session_id === sessionId; });
  if (!session) {
    activeEvents = [];
    renderAll();
    return;
  }

  try {
    var data = await fetchJson("/api/sessions/" + encodeURIComponent(sessionId) + "/events");
  } catch (err) {
    activeEvents = [];
    renderAll();
    return;
  }

  // Guard: if the user switched away while awaiting, discard
  if (activeSessionId !== sessionId) return;

  activeEvents = Array.isArray(data.events) ? data.events : [];
  lastPollSeq = activeEvents.length > 0 ? activeEvents[activeEvents.length - 1].seq : -1;

  renderAll();

  // Start polling if session is running
  if (session.status === "running" || session.status === "cancelling") {
    pollInterval = setInterval(function () {
      pollEvents(sessionId);
    }, 3000);
  }
}

async function pollEvents(sessionId) {
  try {
    var pollData = await fetchJson(
      "/api/sessions/" + encodeURIComponent(sessionId) + "/events?since=" + lastPollSeq
    );
    var newEvents = Array.isArray(pollData.events) ? pollData.events : [];

    if (newEvents.length > 0) {
      for (var i = 0; i < newEvents.length; i++) {
        activeEvents.push(newEvents[i]);
        lastPollSeq = newEvents[i].seq;
      }
      var session = currentSession();
      renderThread(session, activeEvents);
      renderRawEvents(activeEvents);
    }

    // Re-fetch sessions to check for status change
    var sessionsData = await fetchJson("/api/sessions");
    sessions = Array.isArray(sessionsData.sessions) ? sessionsData.sessions : [];
    var updated = sessions.find(function (s) { return s.session_id === sessionId; });
    if (updated && updated.status !== "running" && updated.status !== "cancelling") {
      clearInterval(pollInterval);
      pollInterval = null;
      renderSessions();
      updateComposer();
      renderStatus(updated, activeEvents);

      // Reload full events for final state
      var fullData = await fetchJson("/api/sessions/" + encodeURIComponent(sessionId) + "/events");
      activeEvents = Array.isArray(fullData.events) ? fullData.events : [];
      renderThread(updated, activeEvents);
      renderRawEvents(activeEvents);
    }
  } catch (err) {
    // Silently ignore polling errors
  }
}

// --- Composer form submit ---
els.composerForm.addEventListener("submit", function (e) {
  e.preventDefault();
  var text = els.composerInput.value.trim();
  if (!text) return;

  var session = currentSession();

  (async function () {
    try {
      if (!activeSessionId || !session) {
        // Start new council
        var data = await postJson("/api/sessions", { topic: text, mode: "council" });
        activeSessionId = data.session_id;
        els.composerInput.value = "";
        discussionExpanded = false;
        await loadSessions();
      } else if (session.status === "running" || session.status === "cancelling") {
        // Add interjection
        await postJson("/api/sessions/" + encodeURIComponent(activeSessionId) + "/interjections", { content: text });
        els.composerInput.value = "";
        await selectSession(activeSessionId);
      } else {
        // Continue (fork)
        var created = await postJson("/api/sessions", { topic: text, mode: "council", source_session_id: activeSessionId });
        activeSessionId = created.session_id;
        els.composerInput.value = "";
        discussionExpanded = false;
        await loadSessions();
      }
    } catch (err) {
      els.latestSignal.textContent = err.message;
    }
  })();
});

// --- Cancel button ---
els.cancelButton.addEventListener("click", function () {
  if (!activeSessionId) return;
  (async function () {
    try {
      await postJson("/api/sessions/" + encodeURIComponent(activeSessionId) + "/cancel", {});
      await selectSession(activeSessionId);
    } catch (err) {
      els.latestSignal.textContent = err.message;
    }
  })();
});

// --- New Council button ---
els.newCouncilButton.addEventListener("click", function () {
  activeSessionId = "";
  activeEvents = [];
  discussionExpanded = false;
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  loadConfig().catch(function () {});
  renderAll();
});

// --- Raw events toggle ---
els.rawEventsButton.addEventListener("click", function () {
  rawEventsVisible = !rawEventsVisible;
  renderRawEvents(activeEvents);
});

// --- Refresh button ---
els.refreshButton.addEventListener("click", function () {
  loadSessions().catch(function (error) {
    els.latestSignal.textContent = error.message;
  });
});

// --- Initial load ---
loadConfig().catch(function () {});
loadSessions().catch(function (error) {
  els.latestSignal.textContent = error.message;
});
