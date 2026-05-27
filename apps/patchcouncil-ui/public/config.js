var els = {
  form: document.getElementById("configForm"),
  maxTurns: document.getElementById("maxTurnsInput"),
  minDistinctAgents: document.getElementById("minDistinctAgentsInput"),
  codexEnabled: document.getElementById("codexEnabledInput"),
  claudeEnabled: document.getElementById("claudeEnabledInput"),
  status: document.getElementById("configStatus"),
};

var currentConfig = null;

async function requestJson(path, options) {
  options = options || {};
  var response = await fetch(path, {
    cache: "no-store",
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  var data = await response.json().catch(function () { return {}; });
  if (!response.ok) throw new Error(data.error || (response.status + " " + response.statusText));
  return data;
}

function renderConfig(config) {
  currentConfig = config;
  els.maxTurns.value = String((config.council && config.council.max_turns) ? config.council.max_turns : 3);
  els.minDistinctAgents.value = String((config.council && config.council.min_distinct_agents) ? config.council.min_distinct_agents : 2);
  els.codexEnabled.checked = !config.agents || !config.agents.codex || config.agents.codex.enabled !== false;
  els.claudeEnabled.checked = !config.agents || !config.agents.claude || config.agents.claude.enabled !== false;
}

function readConfigForm() {
  var next = JSON.parse(JSON.stringify(currentConfig || {}));
  next.council = next.council || {};
  next.agents = next.agents || {};
  next.agents.codex = next.agents.codex || {};
  next.agents.claude = next.agents.claude || {};
  next.council.max_turns = Number(els.maxTurns.value || 3);
  next.council.min_distinct_agents = Number(els.minDistinctAgents.value || 2);
  next.agents.codex.enabled = els.codexEnabled.checked;
  next.agents.claude.enabled = els.claudeEnabled.checked;
  return next;
}

els.form.addEventListener("submit", async function (event) {
  event.preventDefault();
  try {
    var saved = await requestJson("/api/config", {
      method: "PUT",
      body: JSON.stringify(readConfigForm()),
    });
    renderConfig(saved);
    els.status.textContent = "Saved. Changes apply to new sessions.";
  } catch (error) {
    els.status.textContent = error.message;
  }
});

requestJson("/api/config")
  .then(renderConfig)
  .catch(function (error) { els.status.textContent = error.message; });
