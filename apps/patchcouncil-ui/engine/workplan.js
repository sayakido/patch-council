"use strict";

const path = require("path");
const { clipText, selectCoordinator } = require("./council");

function parseWorkplanJson(raw) {
  const text = String(raw || "").trim();
  if (!text) return { ok: false, error: "empty workplan response" };
  try {
    return { ok: true, workplan: JSON.parse(text) };
  } catch (_) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return { ok: true, workplan: JSON.parse(text.slice(start, end + 1)) };
      } catch (error) {
        return { ok: false, error: "failed to parse workplan JSON: " + error.message };
      }
    }
    return { ok: false, error: "failed to parse workplan JSON" };
  }
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validateWorkplan(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return { ok: false, error: "workplan must be an object" };
  }
  for (const field of ["title", "rationale", "goal"]) {
    if (typeof plan[field] !== "string" || !plan[field].trim()) {
      return { ok: false, error: `workplan.${field} is required` };
    }
  }
  for (const field of ["scope", "non_goals"]) {
    if (!isStringArray(plan[field])) {
      return { ok: false, error: `workplan.${field} must be an array of strings` };
    }
  }
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    return { ok: false, error: "workplan.tasks must contain at least one task" };
  }
  for (const task of plan.tasks) {
    for (const field of ["id", "title", "description"]) {
      if (typeof task[field] !== "string" || !task[field].trim()) {
        return { ok: false, error: `task.${field} is required` };
      }
    }
    if (!isStringArray(task.files)) return { ok: false, error: `task ${task.id} files must be an array of strings` };
    if (!isStringArray(task.depends_on)) return { ok: false, error: `task ${task.id} depends_on must be an array of strings` };
    if (!isStringArray(task.verification) || task.verification.length === 0) {
      return { ok: false, error: `task ${task.id} verification must contain at least one item` };
    }
  }
  if (!Array.isArray(plan.risks)) {
    return { ok: false, error: "workplan.risks must be an array" };
  }
  for (const risk of plan.risks) {
    if (typeof risk.risk !== "string" || typeof risk.mitigation !== "string") {
      return { ok: false, error: "each risk must include risk and mitigation strings" };
    }
  }
  return { ok: true };
}

function buildWorkplanBrief(allEvents, options = {}) {
  const limits = {
    maxTranscriptChars: options.maxTranscriptChars || 8000,
    maxMessageChars: options.maxMessageChars || 1200,
    recentMessageChars: options.recentMessageChars || 2000,
  };
  const started = allEvents.find((event) => event.type === "session_started");
  const finalized = [...allEvents].reverse().find((event) => event.type === "finalized");
  const agentTurns = allEvents.filter((event) => event.type === "agent_turn_completed");
  const priorWorkplan = [...allEvents].reverse().find((event) => event.type === "workplan_created");

  const sections = [];
  sections.push("# Workplan Brief");
  sections.push(`## Topic\n\n${started?.topic || ""}`);
  if (finalized) {
    sections.push(`## Final Summary\n\n${finalized.summary || ""}`);
    if (Array.isArray(finalized.next_steps) && finalized.next_steps.length > 0) {
      sections.push(`## Final Next Steps\n\n${finalized.next_steps.map((step) => `- ${step}`).join("\n")}`);
    }
  }
  if (priorWorkplan?.workplan) {
    sections.push(`## Source Workplan\n\n${priorWorkplan.workplan.title || ""}\n\n${priorWorkplan.workplan.goal || ""}`);
  }

  const turnSections = agentTurns.map((event, index) => {
    const isRecent = index >= agentTurns.length - 2;
    const limit = isRecent ? limits.recentMessageChars : limits.maxMessageChars;
    return `### ${event.agent} turn ${event.turn}\n\n${clipText(event.content || "", limit)}`;
  });
  if (turnSections.length > 0) {
    sections.push(`## Agent Contributions\n\n${turnSections.join("\n\n")}`);
  }
  if (options.transcriptPath) {
    sections.push(`## Transcript Path\n\n${options.transcriptPath}`);
  }

  return clipText(sections.join("\n\n"), limits.maxTranscriptChars);
}

function selectWorkplanGenerator(config) {
  return selectCoordinator(config);
}

module.exports = {
  parseWorkplanJson,
  validateWorkplan,
  buildWorkplanBrief,
  selectWorkplanGenerator,
};
