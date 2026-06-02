"use strict";

const fs = require("fs");
const path = require("path");
const events = require("./events");
const {
  availableAgents,
  selectCoordinator,
  parseAgentTurnSignal,
  fallbackAgentSignal,
  shouldAllowFinalize,
  clipText,
  formatAgentProfiles,
} = require("./council");
const artifact = require("./workplan-artifact");

function latestDesignCommit(allEvents) {
  return [...allEvents].reverse().find((e) => e.type === "design_revision_committed" || e.type === "design_commit_created");
}

function latestDesignFile(allEvents) {
  return [...allEvents].reverse().find((e) => e.type === "design_revision_written" || e.type === "design_file_written");
}

function nextSeq(allEvents) {
  return allEvents.reduce((max, event) => Math.max(max, Number(event.seq)), -1) + 1;
}

function parseAuthorResponse(text) {
  const parsed = JSON.parse(String(text || "").trim());
  const decision = ["accept", "partially_accept", "reject"].includes(parsed.decision)
    ? parsed.decision
    : "reject";
  return {
    decision,
    reason: String(parsed.reason || parsed.analysis || "Author did not accept the review as written."),
    revision_required: Boolean(parsed.revision_required),
    stance: parsed.stance || (decision === "reject" ? "disagree" : "mixed"),
    confidence: parsed.confidence || "medium",
    finalize_readiness: parsed.finalize_readiness || "not_ready",
    blockers: Array.isArray(parsed.blockers) ? parsed.blockers : [],
    agreements: Array.isArray(parsed.agreements) ? parsed.agreements : [],
    disagreements: Array.isArray(parsed.disagreements) ? parsed.disagreements : [],
    recommended_next_step: parsed.recommended_next_step || (decision === "reject" ? "continue review" : "revise workplan"),
    analysis: String(parsed.analysis || parsed.reason || ""),
  };
}

function validateWorkplanPreflight(sessionStore, sessionDir, allEvents) {
  const state = sessionStore.deriveState(sessionDir);
  if (state.mode !== "design_council") {
    return { ok: false, status: 409, error: "workplan requires a design_council session" };
  }
  if (state.status === "waiting_for_user" && state.waiting_for === "brainstorming_answer") {
    return { ok: false, status: 409, error: "design council is still waiting for brainstorming answer" };
  }
  if (state.status === "running" || state.status === "cancelling") {
    return { ok: false, status: 409, error: "design council must finish before generating a workplan" };
  }
  if (state.status !== "done" && state.workplan?.status !== "rejected" && state.workplan?.status !== "failed") {
    return { ok: false, status: 409, error: "workplan can only be generated for done, failed, or rejected sessions" };
  }
  if (!state.design?.latest_commit) {
    return { ok: false, status: 409, error: "workplan requires a design commit" };
  }
  if (state.workplan?.status && !["none", "failed", "rejected"].includes(state.workplan.status)) {
    return { ok: false, status: 409, error: "workplan already exists or is awaiting approval" };
  }
  if (allEvents.some((event) => event.type === "workplan_draft_started") && state.workplan?.status !== "failed" && state.workplan?.status !== "rejected") {
    return { ok: false, status: 409, error: "workplan generation already started" };
  }
  return { ok: true };
}

function readDesignContext(designFileEvent) {
  try {
    return fs.readFileSync(designFileEvent.artifact_path, "utf8");
  } catch (_) {
    return "Design document could not be read from artifact path.";
  }
}

function buildReviewTranscript(allEvents, maxChars) {
  const latestSignals = allEvents
    .filter((event) => event.type === "agent_turn_completed" && event.signal)
    .map((event) => `${event.agent}: ${JSON.stringify(event.signal)}`)
    .join("\n");
  return clipText(latestSignals || "No reviewer signals yet.", maxChars || 2500);
}

function firstMarkdownTitle(markdown) {
  const match = String(markdown || "").match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : "Untitled Workplan";
}

async function routeWorkplanReviewer(options) {
  const {
    config,
    agents,
    coordinator,
    authorName,
    prompts,
    runAgent,
    artifactPath,
    currentCommit,
    sourceDesignPath,
    sourceDesignCommit,
    eventLog,
    spokenReviewers,
  } = options;
  const reviewerNames = Object.keys(agents).filter((name) => name !== authorName);
  const fallbackReviewer = reviewerNames.find((name) => !spokenReviewers.has(name)) || reviewerNames[0] || authorName;
  const prompt = prompts.renderPrompt("council_route.md", {
    agent_profiles: formatAgentProfiles(config),
    topic: "Review a Markdown workplan artifact and choose the next reviewer.",
    context: [
      "This is Workplan Council review routing.",
      "Do not choose the author as reviewer unless no other reviewer is available.",
      "Source design path: " + sourceDesignPath,
      "Source design commit: " + sourceDesignCommit,
      "Workplan path: " + artifactPath,
      "Workplan commit: " + currentCommit,
      "Available reviewers: " + reviewerNames.join(", "),
    ].join("\n"),
    transcript: buildReviewTranscript(eventLog, config.council?.max_transcript_chars || 2500),
  });
  const result = await runAgent(coordinator.name, coordinator.config, prompt);
  if (!result.ok) return fallbackReviewer;
  try {
    const parsed = JSON.parse(String(result.text || "").trim());
    if (parsed.next_agent && agents[parsed.next_agent] && parsed.next_agent !== authorName) {
      return parsed.next_agent;
    }
  } catch (_) {
    return fallbackReviewer;
  }
  return fallbackReviewer;
}

async function runWorkplanReviewLoop(options) {
  const {
    config, agents, coordinator, author, prompts, runAgent, runGit, emit,
    projectRoot, artifactPath, sourceDesignPath, sourceDesignCommit, designText,
    initialWorkplanCommit,
  } = options;
  const maxTurns = config.council?.max_turns ?? 3;
  const minDistinctReviewers = config.workplan_council?.min_distinct_reviewers ?? 1;
  let turnCount = 0;
  let currentCommit = initialWorkplanCommit;
  let eventLog = [];
  let spokenReviewers = new Set();

  while (turnCount < maxTurns) {
    const reviewerName = await routeWorkplanReviewer({
      config, agents, coordinator, authorName: author.name, prompts, runAgent,
      artifactPath, currentCommit, sourceDesignPath, sourceDesignCommit,
      eventLog, spokenReviewers,
    });
    const reviewer = { name: reviewerName, config: agents[reviewerName] };
    emit(events.EVENTS.WORKPLAN_REVIEW_STARTED, { artifact_path: artifactPath, workplan_commit: currentCommit, reviewer: reviewer.name });

    const workplanText = fs.readFileSync(artifactPath, "utf8");
    const reviewPrompt = prompts.renderPrompt("workplan_review.md", {
      artifact_path: artifactPath,
      workplan_commit: currentCommit,
      workplan: workplanText,
      source_design_path: sourceDesignPath,
      source_design_commit: sourceDesignCommit,
    });
    const reviewed = await runAgent(reviewer.name, reviewer.config, reviewPrompt);
    if (!reviewed.ok) throw new Error(reviewed.error || "workplan review failed");
    const parsed = parseAgentTurnSignal(reviewed.text || "");
    const content = parsed.ok ? parsed.content : reviewed.text || "";
    const signal = parsed.ok ? parsed.signal : fallbackAgentSignal();
    const agentTurn = emit(events.EVENTS.AGENT_TURN_COMPLETED, {
      turn: ++turnCount,
      agent: reviewer.name,
      content,
      content_length: content.length,
      duration_ms: 0,
      signal,
      ...(parsed.ok ? {} : { signal_parse_error: parsed.error }),
    });
    eventLog.push(agentTurn);
    spokenReviewers.add(reviewer.name);
    const requiresAuthorResponse = Boolean(signal.blockers && signal.blockers.length > 0) || /revise/i.test(signal.recommended_next_step || "");
    emit(events.EVENTS.WORKPLAN_REVIEW_COMPLETED, {
      artifact_path: artifactPath,
      workplan_commit: currentCommit,
      reviewer: reviewer.name,
      source_agent_turn_seq: agentTurn.seq,
      requires_revision: requiresAuthorResponse,
    });

    let authorResponse = null;
    let authorSignal = null;
    if (requiresAuthorResponse) {
      emit(events.EVENTS.WORKPLAN_AUTHOR_RESPONSE_STARTED, {
        artifact_path: artifactPath,
        workplan_commit: currentCommit,
        author: author.name,
        source_review_seq: agentTurn.seq,
      });
      const responsePrompt = prompts.renderPrompt("workplan_author_response.md", {
        source_design_path: sourceDesignPath,
        source_design_commit: sourceDesignCommit,
        design: designText,
        artifact_path: artifactPath,
        workplan_commit: currentCommit,
        workplan: fs.readFileSync(artifactPath, "utf8"),
        review: content,
        signal: JSON.stringify(signal, null, 2),
      });
      const response = await runAgent(author.name, author.config, responsePrompt);
      if (!response.ok) throw new Error(response.error || "workplan author response failed");
      authorResponse = parseAuthorResponse(response.text || "");
      authorSignal = {
        stance: authorResponse.stance,
        confidence: authorResponse.confidence,
        finalize_readiness: authorResponse.finalize_readiness,
        blockers: authorResponse.blockers || [],
        agreements: authorResponse.agreements || [],
        disagreements: authorResponse.disagreements || [],
        recommended_next_step: authorResponse.recommended_next_step,
        analysis: authorResponse.analysis,
      };
      const authorTurn = emit(events.EVENTS.AGENT_TURN_COMPLETED, {
        turn: ++turnCount,
        agent: author.name,
        content: authorResponse.reason,
        content_length: authorResponse.reason.length,
        duration_ms: 0,
        signal: authorSignal,
      });
      eventLog.push(authorTurn);
      emit(events.EVENTS.WORKPLAN_AUTHOR_RESPONSE_COMPLETED, {
        artifact_path: artifactPath,
        workplan_commit: currentCommit,
        author: author.name,
        source_review_seq: agentTurn.seq,
        source_agent_turn_seq: authorTurn.seq,
        decision: authorResponse.decision,
        revision_required: authorResponse.revision_required,
      });

      if (authorResponse.decision === "reject" || !authorResponse.revision_required) {
        continue;
      }
    }

    const gate = shouldAllowFinalize(eventLog, { minDistinctAgents: Math.min(minDistinctReviewers, Object.keys(agents).length) });
    if (gate.allowed && signal.finalize_readiness === "ready") {
      const finalizePrompt = prompts.renderPrompt("workplan_finalize.md", {
        source_design_path: sourceDesignPath,
        source_design_commit: sourceDesignCommit,
        artifact_path: artifactPath,
        workplan_commit: currentCommit,
        transcript: buildReviewTranscript(eventLog, config.council?.max_transcript_chars || 2500),
      });
      const finalized = await runAgent(coordinator.name, coordinator.config, finalizePrompt);
      if (!finalized.ok) throw new Error(finalized.error || "workplan finalize failed");
      emit(events.EVENTS.WORKPLAN_APPROVAL_REQUESTED, {
        artifact_path: artifactPath,
        workplan_commit: currentCommit,
        requested_at: new Date().toISOString(),
      });
      return { ok: true, status: 200, artifact_path: artifactPath, commit: currentCommit };
    }

    if (!authorResponse || (authorResponse.decision !== "accept" && authorResponse.decision !== "partially_accept")) {
      continue;
    }

    const revisionPrompt = prompts.renderPrompt("workplan_revision.md", {
      source_design_path: sourceDesignPath,
      source_design_commit: sourceDesignCommit,
      design: designText,
      artifact_path: artifactPath,
      workplan_commit: currentCommit,
      workplan: fs.readFileSync(artifactPath, "utf8"),
      review: content,
      signal: JSON.stringify(signal, null, 2),
      author_response: JSON.stringify(authorResponse, null, 2),
      author_signal: JSON.stringify(authorSignal, null, 2),
    });
    const revision = await runAgent(author.name, author.config, revisionPrompt);
    if (!revision.ok) throw new Error(revision.error || "workplan revision failed");
    const revisionText = String(revision.text || "").trim() + "\n";
    const contract = artifact.scanWorkplanContract(revisionText);
    if (!contract.ok) throw new Error(contract.error);
    fs.writeFileSync(artifactPath, revisionText, "utf8");
    emit(events.EVENTS.WORKPLAN_REVISION_WRITTEN, {
      artifact_path: artifactPath,
      source_design_commit: sourceDesignCommit,
      source_workplan_commit: currentCommit,
      source_review_seq: agentTurn.seq,
      generator: author.name,
      revision: turnCount,
    });
    const message = `docs: revise ${path.basename(artifactPath, ".md").replace(/^\d{4}-\d{2}-\d{2}-/, "")} workplan`;
    const committed = await artifact.commitWorkplanArtifact({ artifactPath, projectRoot, message, runGit });
    if (!committed.ok) {
      emit(events.EVENTS.WORKPLAN_REVISION_COMMIT_FAILED, {
        artifact_path: artifactPath,
        source_design_commit: sourceDesignCommit,
        source_workplan_commit: currentCommit,
        stage: committed.stage,
        error: committed.error,
      });
      return { ok: false, status: 200, error: committed.error };
    }
    emit(events.EVENTS.WORKPLAN_REVISION_COMMITTED, {
      artifact_path: artifactPath,
      source_design_commit: sourceDesignCommit,
      source_workplan_commit: currentCommit,
      commit: committed.commit,
      commit_message: message,
    });
    currentCommit = committed.commit;
  }

  // Only request approval if the finalize gate actually passed.
  // If the loop exhausted maxTurns with unresolved blockers or
  // author rejecting every review, do not ask the user to approve.
  const finalGate = shouldAllowFinalize(eventLog, { minDistinctAgents: Math.min(minDistinctReviewers, Object.keys(agents).length) });
  if (!finalGate.allowed) {
    emit(events.EVENTS.WORKPLAN_GENERATION_FAILED, {
      failed_at: new Date().toISOString(),
      generator: author.name,
      message: finalGate.reason,
      recoverable: false,
      action: "review_loop_exhausted",
      details: { artifact_path: artifactPath, workplan_commit: currentCommit },
    });
    return { ok: false, status: 200, error: finalGate.reason };
  }

  emit(events.EVENTS.WORKPLAN_APPROVAL_REQUESTED, {
    artifact_path: artifactPath,
    workplan_commit: currentCommit,
    requested_at: new Date().toISOString(),
  });
  return { ok: true, status: 200, artifact_path: artifactPath, commit: currentCommit };
}

async function generateWorkplanForSession(options) {
  const { config, sessionStore, sessionDir, sessionId, projectRoot, topic, prompts, runAgent, runGit, onEvent } = options;
  const allEvents = sessionStore.readEvents(sessionDir);
  const preflight = validateWorkplanPreflight(sessionStore, sessionDir, allEvents);
  if (!preflight.ok) return preflight;

  const agents = availableAgents(config.agents);
  const author = selectCoordinator(config);
  const coordinator = selectCoordinator(config);
  if (!author || !coordinator) return { ok: false, status: 409, error: "no available workplan author" };

  let seq = nextSeq(allEvents);
  const designCommit = latestDesignCommit(allEvents);
  const designFile = latestDesignFile(allEvents);
  const sourceDesignPath = designFile.artifact_path;
  const sourceDesignCommit = designCommit.commit;
  const designText = readDesignContext(designFile);
  const artifactPath = artifact.buildWorkplanArtifactPath(projectRoot, topic || allEvents.find((e) => e.type === "session_started")?.topic || "workplan");
  const phase = "finalized";

  function emit(type, fields) {
    const event = Object.assign({ schema_version: 1, seq: seq++, type, phase, session_id: sessionId }, fields);
    onEvent(event);
    return event;
  }

  emit(events.EVENTS.WORKPLAN_DRAFT_STARTED, {
    generator: author.name,
    source_design_path: sourceDesignPath,
    source_design_commit: sourceDesignCommit,
  });

  try {
    artifact.ensureWorkplanDirectory(artifactPath);
    // Allow retry after failed/rejected — clean up the previous artifact file.
    if (fs.existsSync(artifactPath)) {
      const state = sessionStore.deriveState(sessionDir);
      if (state.workplan && (state.workplan.status === "failed" || state.workplan.status === "rejected")) {
        fs.unlinkSync(artifactPath);
      }
    }
    const writable = artifact.assertWorkplanWritable(artifactPath, { allowExisting: false });
    if (!writable.ok) {
      emit(events.EVENTS.WORKPLAN_GENERATION_FAILED, {
        failed_at: new Date().toISOString(),
        generator: author.name,
        message: writable.error,
        recoverable: true,
        action: "ask_user_to_resolve_dirty_workplan",
        details: { artifact_path: artifactPath },
      });
      sessionStore.deriveState(sessionDir);
      sessionStore.generateTranscript(sessionDir);
      return { ok: false, status: 200, error: writable.error };
    }

    const draftPrompt = prompts.renderPrompt("workplan_draft.md", {
      topic: topic || "",
      source_design_path: sourceDesignPath,
      source_design_commit: sourceDesignCommit,
      design: designText,
      context: "Supported commands: npm run check, npm run smoke, npm run runtime:fake",
    });
    const draft = await runAgent(author.name, author.config, draftPrompt);
    if (!draft.ok) throw new Error(draft.error || "workplan draft failed");
    const draftText = String(draft.text || "").trim() + "\n";
    const contract = artifact.scanWorkplanContract(draftText);
    if (!contract.ok) throw new Error(contract.error);

    fs.writeFileSync(artifactPath, draftText, "utf8");
    emit(events.EVENTS.WORKPLAN_DRAFT_WRITTEN, {
      artifact_path: artifactPath,
      generator: author.name,
      source_design_commit: sourceDesignCommit,
      title: firstMarkdownTitle(draftText),
      revision: 0,
    });
    const draftMessage = `docs: draft ${path.basename(artifactPath, ".md").replace(/^\d{4}-\d{2}-\d{2}-/, "")} workplan`;
    const draftCommit = await artifact.commitWorkplanArtifact({ artifactPath, projectRoot, message: draftMessage, runGit });
    if (!draftCommit.ok) {
      emit(events.EVENTS.WORKPLAN_DRAFT_COMMIT_FAILED, {
        artifact_path: artifactPath,
        source_design_commit: sourceDesignCommit,
        stage: draftCommit.stage,
        error: draftCommit.error,
      });
      sessionStore.deriveState(sessionDir);
      sessionStore.generateTranscript(sessionDir);
      return { ok: false, status: 200, error: draftCommit.error };
    }
    emit(events.EVENTS.WORKPLAN_DRAFT_COMMITTED, {
      artifact_path: artifactPath,
      source_design_commit: sourceDesignCommit,
      commit: draftCommit.commit,
      commit_message: draftMessage,
    });

    const reviewResult = await runWorkplanReviewLoop({
      config, agents, coordinator, author, prompts, runAgent, runGit, emit,
      projectRoot, artifactPath, sourceDesignPath, sourceDesignCommit, designText,
      initialWorkplanCommit: draftCommit.commit,
    });

    sessionStore.deriveState(sessionDir);
    sessionStore.generateTranscript(sessionDir);
    return reviewResult;
  } catch (error) {
    emit(events.EVENTS.WORKPLAN_GENERATION_FAILED, {
      failed_at: new Date().toISOString(),
      generator: author.name,
      message: error.message,
      recoverable: true,
      action: "show_error",
      details: { artifact_path: artifactPath },
    });
    sessionStore.deriveState(sessionDir);
    sessionStore.generateTranscript(sessionDir);
    return { ok: false, status: 200, error: error.message };
  }
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
  const designCommit = latestDesignCommit(allEvents);
  const designFile = latestDesignFile(allEvents);

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

module.exports = {
  buildWorkplanBrief,
  generateWorkplanForSession,
  latestDesignCommit,
  latestDesignFile,
};
