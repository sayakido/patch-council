"use strict";

const fs = require("fs");
const path = require("path");
const { clipText, selectCoordinator } = require("./council");

function latestDesignCommit(allEvents) {
  return [...allEvents].reverse().find((e) => e.type === "design_revision_committed" || e.type === "design_commit_created");
}

function latestDesignFile(allEvents) {
  return [...allEvents].reverse().find((e) => e.type === "design_revision_written" || e.type === "design_file_written");
}

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
  if (started?.source_summary) {
    sections.push(`## Source Session Summary\n\n${started.source_summary}`);
    if (started.source_transcript_path) {
      sections.push(`Source transcript: ${started.source_transcript_path}`);
    }
  }
  if (priorWorkplan?.workplan) {
    sections.push(`## Source Workplan\n\n${priorWorkplan.workplan.title || ""}\n\n${priorWorkplan.workplan.goal || ""}`);
  }

  const designCommit = latestDesignCommit(allEvents);
  const designFile = latestDesignFile(allEvents);
  if (started?.mode === "design_council" && designCommit && designFile) {
    sections.push(`## Design Source\n\nPath: ${designFile.artifact_path}\nCommit: ${designCommit.commit}`);
    try {
      sections.push(`## Design Document\n\n${clipText(fs.readFileSync(designFile.artifact_path, "utf8"), limits.maxMessageChars)}`);
    } catch (_) {
      sections.push("Design document could not be read; use path and commit above.");
    }
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

function nextSeq(allEvents) {
  return allEvents.reduce((max, event) => Math.max(max, Number(event.seq)), -1) + 1;
}

function doneSessionState(sessionStore, sessionDir) {
  const state = sessionStore.deriveState(sessionDir);
  return state.status === "done";
}

async function generateWorkplanForSession(options) {
  const { config, sessionStore, sessionDir, sessionId, prompts, runAgent, onEvent } = options;
  const allEvents = sessionStore.readEvents(sessionDir);

  if (!doneSessionState(sessionStore, sessionDir)) {
    return { ok: false, error: "workplan can only be generated for done sessions", status: 409 };
  }
  if (allEvents.some((event) => event.type === "workplan_created")) {
    return { ok: false, error: "workplan already exists", status: 409 };
  }
  const lastWorkplanEvent = [...allEvents].reverse().find((event) =>
    event.type === "workplan_generation_started" ||
    event.type === "workplan_created" ||
    event.type === "workplan_generation_failed"
  );
  if (lastWorkplanEvent?.type === "workplan_generation_started") {
    return { ok: false, error: "workplan generation already in progress", status: 409 };
  }

  const generator = selectWorkplanGenerator(config);
  if (!generator) {
    return { ok: false, error: "no available workplan generator", status: 409 };
  }

  let seq = nextSeq(allEvents);
  const generatedStartedAt = new Date().toISOString();
  onEvent({
    schema_version: 1,
    seq: seq++,
    type: "workplan_generation_started",
    phase: "finalized",
    session_id: sessionId,
    requested_at: generatedStartedAt,
    generator: generator.name,
  });

  try {
    const updatedEvents = sessionStore.readEvents(sessionDir);
    const started = updatedEvents.find((event) => event.type === "session_started");

    if (started?.mode === "design_council" && !latestDesignCommit(updatedEvents)) {
      return { ok: false, error: "design council workplan requires a design commit", status: 409 };
    }

    const brief = buildWorkplanBrief(updatedEvents, {
      transcriptPath: path.join(sessionDir, "transcript.jsonl"),
      maxTranscriptChars: config.council?.max_workplan_transcript_chars || 8000,
      maxMessageChars: config.council?.max_workplan_message_chars || 1200,
      recentMessageChars: config.council?.max_workplan_recent_message_chars || 2000,
    });
    const prompt = prompts.renderPrompt("workplan_create.md", {
      topic: started?.topic || "",
      brief,
    });

    const result = await runAgent(generator.name, generator.config, prompt);
    if (!result.ok) {
      emitFailed(seq, generator.name, result.error || "workplan generation failed");
      return { ok: false, error: result.error || "workplan generation failed", status: 200 };
    }

    const parsed = parseWorkplanJson(result.text);
    const validation = parsed.ok ? validateWorkplan(parsed.workplan) : parsed;
    if (!parsed.ok || !validation.ok) {
      emitFailed(seq, generator.name, parsed.ok ? validation.error : parsed.error, String(result.text || "").slice(0, 500));
      return { ok: false, error: parsed.ok ? validation.error : parsed.error, status: 200 };
    }

    const finalized = [...updatedEvents].reverse().find((event) => event.type === "finalized");
    onEvent({
      schema_version: 1,
      seq,
      type: "workplan_created",
      phase: "finalized",
      session_id: sessionId,
      created_at: new Date().toISOString(),
      generator: generator.name,
      source: {
        summary_event_seq: finalized ? finalized.seq : null,
        transcript_path: path.join(sessionDir, "transcript.jsonl"),
      },
      workplan: parsed.workplan,
    });
    sessionStore.deriveState(sessionDir);
    sessionStore.generateTranscript(sessionDir);
    return { ok: true, workplan: parsed.workplan, status: 200 };
  } catch (error) {
    emitFailed(seq, generator.name, "workplan generation threw: " + error.message, "");
    return { ok: false, error: error.message, status: 200 };
  }

  function emitFailed(seqVal, genName, message, raw) {
    const details = {};
    if (raw) details.raw = raw;
    onEvent({
      schema_version: 1,
      seq: seqVal,
      type: "workplan_generation_failed",
      phase: "finalized",
      session_id: sessionId,
      failed_at: new Date().toISOString(),
      generator: genName,
      message,
      recoverable: true,
      action: "show_error",
      details,
    });
    sessionStore.deriveState(sessionDir);
    sessionStore.generateTranscript(sessionDir);
  }
}

module.exports = {
  parseWorkplanJson,
  validateWorkplan,
  buildWorkplanBrief,
  selectWorkplanGenerator,
  generateWorkplanForSession,
  latestDesignCommit,
  latestDesignFile,
};
