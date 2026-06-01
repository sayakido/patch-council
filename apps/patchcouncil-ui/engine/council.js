"use strict";

const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");
const events = require("./events");

function clipText(text, limit) {
  if (!text || text.length <= limit) return text || "";
  const head = Math.max(Math.floor(limit / 2), 1);
  const tail = Math.max(limit - head, 1);
  return text.slice(0, head) + "\n\n[... clipped ...]\n\n" + text.slice(-tail);
}

function availableAgents(agents) {
  return Object.fromEntries(
    Object.entries(agents || {}).filter(([, cfg]) => cfg && cfg.enabled !== false)
  );
}

function formatAgentProfiles(config) {
  const agents = availableAgents(config.agents);
  const lines = [];
  for (const [name, cfg] of Object.entries(agents)) {
    const caps = (cfg.capabilities || []).join(", ");
    const write = cfg.write_access ? "can write" : "read-only";
    lines.push(`- ${name}: capabilities=${caps}; ${write}`);
  }
  return lines.join("\n");
}

function parseJsonDecision(raw, fallbackDecision) {
  let text = (raw || "").trim();
  if (!text) return null;

  // try direct parse
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj.decision === "string") return obj;
  } catch (_) { /* continue */ }

  // try to extract from ```json ... ``` fence
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    try {
      const obj = JSON.parse(fenceMatch[1].trim());
      if (obj && typeof obj.decision === "string") return obj;
    } catch (_) { /* continue */ }
  }

  // try to find { ... } range
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const obj = JSON.parse(text.slice(start, end + 1));
      if (obj && typeof obj.decision === "string") return obj;
    } catch (_) { /* continue */ }
  }

  // for finalize prompt (no "decision" field)
  if (fallbackDecision === "finalize") {
    const start2 = text.indexOf("{");
    const end2 = text.lastIndexOf("}");
    if (start2 !== -1 && end2 > start2) {
      try {
        const obj = JSON.parse(text.slice(start2, end2 + 1));
        if (obj && typeof obj.consensus === "string") return obj;
      } catch (_) { /* continue */ }
    }
  }

  return null;
}

const STANCES = new Set(["agree", "disagree", "mixed"]);
const CONFIDENCES = new Set(["low", "medium", "high"]);
const READINESS = new Set(["ready", "not_ready"]);
const BLOCKER_TYPES = new Set(["issue", "question"]);

function normalizeStringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function fallbackAgentSignal() {
  return {
    stance: "mixed",
    confidence: "low",
    finalize_readiness: "not_ready",
    blockers: [{
      type: "issue",
      text: "Agent response did not provide a parseable deliberation signal.",
    }],
    agreements: [],
    disagreements: [],
    recommended_next_step: "Continue discussion with a parseable structured response.",
  };
}

function parseAgentTurnSignal(raw) {
  const text = String(raw || "").trim();
  if (!text) return { ok: false, error: "empty agent signal response" };

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenceMatch) {
      try { parsed = JSON.parse(fenceMatch[1].trim()); } catch (_) { parsed = null; }
    }
    if (!parsed) {
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start !== -1 && end > start) {
        try { parsed = JSON.parse(text.slice(start, end + 1)); } catch (_) { parsed = null; }
      }
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "failed to parse agent turn signal JSON" };
  }

  if (!STANCES.has(parsed.stance)) return { ok: false, error: "invalid signal.stance" };
  if (!CONFIDENCES.has(parsed.confidence)) return { ok: false, error: "invalid signal.confidence" };
  if (!READINESS.has(parsed.finalize_readiness)) return { ok: false, error: "invalid signal.finalize_readiness" };
  if (typeof parsed.analysis !== "string" || !parsed.analysis.trim()) {
    return { ok: false, error: "signal.analysis is required" };
  }

  const blockers = Array.isArray(parsed.blockers) ? parsed.blockers.map((item) => ({
    type: BLOCKER_TYPES.has(item?.type) ? item.type : "issue",
    text: typeof item?.text === "string" ? item.text : "",
  })).filter((item) => item.text.trim()) : [];

  const signal = {
    stance: parsed.stance,
    confidence: parsed.confidence,
    finalize_readiness: parsed.finalize_readiness,
    blockers,
    agreements: normalizeStringArray(parsed.agreements),
    disagreements: normalizeStringArray(parsed.disagreements),
    recommended_next_step: typeof parsed.recommended_next_step === "string" ? parsed.recommended_next_step : "",
  };

  return { ok: true, content: parsed.analysis, signal };
}

function latestSignalsByAgent(eventLog) {
  const byAgent = new Map();
  for (const event of eventLog) {
    if (event.type === events.EVENTS.AGENT_TURN_COMPLETED && event.agent && event.signal) {
      byAgent.set(event.agent, { agent: event.agent, turn: event.turn, signal: event.signal });
    }
  }
  return [...byAgent.values()];
}

function firstBlockerText(signal) {
  const blocker = Array.isArray(signal?.blockers) ? signal.blockers.find((item) => item && item.text) : null;
  return blocker ? blocker.text : "";
}

function shouldAllowFinalize(eventLog, options) {
  const minDistinctAgents = options.minDistinctAgents || 1;
  const latest = latestSignalsByAgent(eventLog);
  if (latest.length < minDistinctAgents) {
    return { allowed: false, reason: `min_distinct_agents=${minDistinctAgents} not satisfied` };
  }

  for (const item of latest) {
    const blocker = firstBlockerText(item.signal);
    if (blocker) return { allowed: false, reason: `blocker remains: ${blocker}` };
  }

  if (latest.length > 0 && latest.every((item) => item.signal.finalize_readiness === "not_ready")) {
    return { allowed: false, reason: "all latest signals are finalize_readiness=not_ready" };
  }

  const notReadyDisagree = latest.find((item) =>
    item.signal.stance === "disagree" && item.signal.finalize_readiness === "not_ready"
  );
  if (notReadyDisagree) {
    return { allowed: false, reason: `${notReadyDisagree.agent} disagrees and is not ready to finalize` };
  }

  return { allowed: true, reason: "finalize gate passed" };
}

function formatSignalForBrief(signal) {
  if (!signal) return "";
  const parts = [
    `Stance: ${signal.stance || "unknown"}`,
    `Confidence: ${signal.confidence || "unknown"}`,
    `Readiness: ${signal.finalize_readiness || "unknown"}`,
  ];
  if (Array.isArray(signal.blockers) && signal.blockers.length > 0) {
    const texts = signal.blockers.filter((b) => b && b.text).map((b) => b.text);
    if (texts.length > 0) parts.push(`Blockers: ${texts.join("; ")}`);
  }
  if (Array.isArray(signal.agreements) && signal.agreements.length > 0) {
    parts.push(`Agreements: ${signal.agreements.join("; ")}`);
  }
  if (Array.isArray(signal.disagreements) && signal.disagreements.length > 0) {
    parts.push(`Disagreements: ${signal.disagreements.join("; ")}`);
  }
  if (signal.recommended_next_step) {
    parts.push(`Next: ${signal.recommended_next_step}`);
  }
  return `**Signal:** ${parts.join(" · ")}`;
}

function resolveAgentName(agents, requested) {
  const names = Object.keys(agents);
  if (names.length === 0) return null;

  if (!requested) return names[0];

  for (const name of names) {
    if (name.toLowerCase() === requested.toLowerCase()) return name;
  }

  return null;
}

function selectCoordinator(config) {
  const agents = availableAgents(config.agents);
  // prefer an agent with synthesize or plan capability
  for (const [name, cfg] of Object.entries(agents)) {
    const caps = cfg.capabilities || [];
    if ((caps.includes("synthesize") || caps.includes("plan")) && !cfg.write_access) {
      return { name, config: cfg };
    }
  }
  // fallback: first read-only agent
  for (const [name, cfg] of Object.entries(agents)) {
    if (!cfg.write_access) return { name, config: cfg };
  }
  // last resort: first agent
  const first = Object.entries(agents)[0];
  return first ? { name: first[0], config: first[1] } : null;
}

function resolveDesignCouncilConfig(config, requested = {}) {
  const defaults = Object.assign({ lead_agent: "codex", max_questions: 8 }, config.design_council || {});
  const merged = Object.assign({}, defaults, requested || {});
  return {
    lead_agent: merged.lead_agent,
    max_questions: Math.max(1, Number(merged.max_questions || 8)),
  };
}

function validateRequiredAgents(config, options = {}) {
  const agents = availableAgents(config.agents);
  const coordinator = selectCoordinator(config);
  if (!coordinator) throw new Error("coordinator agent is not available");
  if (options.mode === "design_council") {
    const dc = resolveDesignCouncilConfig(config, options.brainstorming);
    if (!agents[dc.lead_agent]) throw new Error(`design council lead agent is not available: ${dc.lead_agent}`);
  }
  return true;
}

function collectContext(projectRoot, config) {
  const ctxCfg = config.context || {};
  const parts = [];

  // include specific files
  const includeFiles = ctxCfg.include || ctxCfg.include_files || ["README.md", "package.json", "pyproject.toml"];
  for (const rel of includeFiles) {
    const p = path.join(projectRoot, rel);
    if (fs.existsSync(p)) {
      try {
        const content = fs.readFileSync(p, "utf8");
        parts.push(`### ${rel}\n\n${content}`);
      } catch (_) { /* skip unreadable */ }
    }
  }

  // list top-level files
  try {
    const entries = fs.readdirSync(projectRoot, { withFileTypes: true });
    const exclude = new Set(ctxCfg.exclude || ctxCfg.exclude_patterns || [".git", "node_modules", "dist", "build", "target", ".venv"]);
    const files = entries
      .filter((e) => !exclude.has(e.name) && !e.name.startsWith("."))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .slice(0, 50);
    parts.push(`### Project files\n\n${files.join("\n")}`);
  } catch (_) { /* skip */ }

  return parts.join("\n\n");
}

class CouncilEngine extends EventEmitter {
  constructor(options) {
    super();
    this.config = options.config;
    this.sessionStore = options.sessionStore;
    this.runAgent = options.runAgent;
    this.projectRoot = options.projectRoot;
    this.prompts = options.prompts;
    this.sessionDir = options.sessionDir;
    this.sessionId = options.sessionId;
    this.sourceMetadata = options.sourceMetadata || null;

    // mode and brainstorming config
    this.mode = options.mode || "council";
    this.brainstormingConfig = Object.assign(
      {},
      options.config?.design_council || {},
      options.brainstorming || {}
    );
    this.runGit = options.runGit;

    // per-run state
    this.seq = -1;
    this.turnCount = 0;
    this.spokenAgents = new Set();
    this.eventLog = [];
    this.phase = this.mode === "design_council" ? "brainstorming" : "discussion";
    this.errorCount = 0;
    this.startedAt = null;

    // host controls
    this.cancelRequested = false;
    this.cancelReason = null;
    this.interjections = [];
    this.waitingForUser = false;

    // finalize gate state
    this.finalizeGateOverrideCount = 0;
  }

  emitEvent(type, fields) {
    this.seq++;
    const e = Object.assign(
      { schema_version: 1, seq: this.seq, type, phase: this.phase, session_id: this.sessionId },
      fields
    );
    this.eventLog.push(e);
    this.emit("event", e);
    return e;
  }

  addInterjection(content) {
    const text = String(content || "").trim();
    if (!text) return null;
    const event = this.emitEvent(events.EVENTS.USER_INTERJECTION, {
      turn: this.turnCount,
      content: text,
      created_at: new Date().toISOString(),
    });
    this.interjections.push(event);
    return event;
  }

  requestCancel(reason = "user") {
    if (this.cancelRequested) return null;
    this.cancelRequested = true;
    this.cancelReason = reason;
    return this.emitEvent(events.EVENTS.SESSION_CANCEL_REQUESTED, {
      requested_at: new Date().toISOString(),
      reason,
    });
  }

  resolveCouncilLimits() {
    const council = this.config.council || {};
    return {
      maxContextChars: council.max_context_chars || 2500,
      maxTranscriptChars: council.max_transcript_chars || 2500,
      maxMessageChars: council.max_message_chars || 800,
    };
  }

  async run(topic) {
    this.startedAt = new Date().toISOString();
    const councilCfg = this.config.council || {};
    const maxTurns = councilCfg.max_turns ?? 3;
    const minDistinctAgents = councilCfg.min_distinct_agents ?? 2;
    const limits = this.resolveCouncilLimits();
    const { maxContextChars, maxTranscriptChars, maxMessageChars } = limits;
    const agents = availableAgents(this.config.agents);
    const coordinator = selectCoordinator(this.config);

    const designCouncilConfig = this.mode === "design_council"
      ? resolveDesignCouncilConfig(this.config, this.brainstormingConfig)
      : null;

    const sanitizeAgentConfig = (agentMap) => {
      return Object.fromEntries(
        Object.entries(agentMap).map(([id, cfg]) => [
          id,
          {
            command: cfg.command,
            args: cfg.args || [],
            input_mode: cfg.input_mode,
            capabilities: cfg.capabilities || [],
            write_access: Boolean(cfg.write_access),
            timeout_sec: cfg.timeout_sec,
            enabled: true,
            roles: id === coordinator?.name ? ["coordinator", "agent"] : ["agent"],
          },
        ])
      );
    };

    const context = collectContext(this.projectRoot, this.config);

    // emit session_started
    this.emitEvent(events.EVENTS.SESSION_STARTED, {
      started_at: this.startedAt,
      topic,
      mode: this.mode,
      ...(this.sourceMetadata ? {
        source_session_id: this.sourceMetadata.source_session_id,
        source_summary: this.sourceMetadata.source_summary,
        source_transcript_path: this.sourceMetadata.source_transcript_path,
      } : {}),
      config: {
        council: councilCfg,
        agents: sanitizeAgentConfig(agents),
        brainstorming: designCouncilConfig,
      },
      capabilities: { can_execute: false, requires_user_confirmation_before_write: true },
      agents: Object.entries(agents).map(([id, cfg]) => ({ id, command: cfg.command, roles: id === coordinator?.name ? ["coordinator", "agent"] : ["agent"] })),
    });

    if (this.mode === "design_council") {
      const preludeResult = await this.runBrainstormingPrelude(topic, context, limits, designCouncilConfig);
      if (preludeResult.waiting) {
        this.waitingForUser = true;
        return { outcome: "waiting_for_user", turnCount: this.turnCount, errorCount: this.errorCount };
      }
    }

    return await this.runDiscussionLoop(topic);
  }

  async runDiscussionLoop(topic) {
    const limits = this.resolveCouncilLimits();
    const councilCfg = this.config.council || {};
    const maxTurns = councilCfg.max_turns ?? 3;
    const minDistinctAgents = councilCfg.min_distinct_agents ?? 2;
    const agents = availableAgents(this.config.agents);
    const context = collectContext(this.projectRoot, this.config);
    const agentProfiles = formatAgentProfiles(this.config);
    const sourceContext = this.sourceMetadata
      ? "### Source session\n\n" + this.sourceMetadata.source_summary + "\n\nTranscript: " + this.sourceMetadata.source_transcript_path
      : "";
    const contextWithSource = [sourceContext, context].filter(Boolean).join("\n\n");

    let decision = null;

    try {
      // --- route ---
      const routeResult = await this.routeCoordinator(topic, contextWithSource, agentProfiles, limits);
      decision = routeResult;

      // --- avoid coordinator as first agent ---
      decision = this.avoidCoordinatorAsFirstAgent(decision, agents);

      // --- cancellation checkpoint after route ---
      if (this.cancelRequested) {
        // route returned but we were cancelled; skip all agent turns
      } else {

        // --- agent turn loop ---
        while (decision && decision.decision === "continue" && this.turnCount < maxTurns) {
          const agentName = resolveAgentName(agents, decision.next_agent);
          if (!agentName) {
            this.emitEvent(events.EVENTS.COORDINATOR_ERROR, {
              turn: this.turnCount + 1,
              message: `Unknown agent: ${decision.next_agent}`,
              recoverable: true,
              action: "fallback_finalize",
              details: { requested: decision.next_agent, available: Object.keys(agents) },
            });
            this.errorCount++;
            break;
          }

          const agentConfig = agents[agentName];
          const turnNum = this.turnCount + 1;

          const turnResult = await this.runAgentTurn(turnNum, agentName, agentConfig, decision.role, topic, contextWithSource, limits);
          this.turnCount++;
          this.spokenAgents.add(agentName);

          // --- design revision trigger ---
          if (this.mode === "design_council" && turnResult && turnResult.event) {
            const reviewEvent = turnResult.event;
            const signal = reviewEvent.signal;
            const hasBlocker = signal && Array.isArray(signal.blockers) && signal.blockers.length > 0;
            const recommendRevise = signal && typeof signal.recommended_next_step === "string" && /revise/i.test(signal.recommended_next_step);
            if (hasBlocker || recommendRevise) {
              await this.reviseDesignFromLatestReview(topic, reviewEvent);
            }
          }

          if (this.turnCount >= maxTurns) break;

          // --- cancellation checkpoint ---
          if (this.cancelRequested) break;

          // --- decide ---
          const decideResult = await this.decideCoordinator(topic, contextWithSource, agentProfiles, limits, maxTurns);
          if (!decideResult) {
            break;
          }
          decision = decideResult;

          // --- policy check ---
          const enforced = this.enforceMinDistinctAgents(
            decision, agents, minDistinctAgents, maxTurns
          );
          if (enforced !== decision) {
            this.emitEvent(events.EVENTS.POLICY_OVERRIDE, {
              turn: this.turnCount,
              policy: "min_distinct_agents",
              original_decision: decision.decision,
              new_decision: enforced.decision,
              selected_agent: enforced.next_agent,
              reason: `min_distinct_agents=${minDistinctAgents} 未满足，且尚未达到 max_turns=${maxTurns}`,
            });
            decision = enforced;
          }

          // --- finalize gate ---
          decision = this.applyFinalizeGate(decision, agents, minDistinctAgents, maxTurns);
          if (decision && decision.decision === "finalize") break;
        }
      }
    } catch (err) {
      this.emitEvent(events.EVENTS.SESSION_ERROR, {
        message: err.message || String(err),
        recoverable: false,
        action: "abort",
        details: {},
      });
      this.errorCount++;
    }

    // --- finalize ---
    if (this.cancelRequested) {
      this.emitEvent(events.EVENTS.FINALIZED, {
        summary: "Session cancelled by host.",
        next_steps: [],
      });
    } else {
      await this.finalizeCouncil(topic, contextWithSource, limits);
    }

    // --- session_finished ---
    const finishedAt = new Date().toISOString();
    const durationMs = new Date(finishedAt) - new Date(this.startedAt);
    this.phase = "finalized";

    const distinctAgents = [...this.spokenAgents];
    const outcome = this.cancelRequested ? "cancelled" : (this.errorCount > 0 ? "error" : "discussion_only");

    this.emitEvent(events.EVENTS.SESSION_FINISHED, {
      finished_at: finishedAt,
      outcome,
      duration_ms: durationMs,
      turn_count: this.turnCount,
      distinct_agents: distinctAgents,
      error_count: this.errorCount,
    });

    // generate derived files
    this.sessionStore.deriveState(this.sessionDir);
    this.sessionStore.generateTranscript(this.sessionDir);

    return {
      sessionId: this.sessionId,
      sessionDir: this.sessionDir,
      turnCount: this.turnCount,
      distinctAgents,
      outcome,
      errorCount: this.errorCount,
    };
  }

  buildBrainstormingBrief(topic) {
    const parts = [`Topic: ${topic}`];
    const questions = new Map(
      this.eventLog
        .filter((e) => e.type === events.EVENTS.BRAINSTORMING_QUESTION_CREATED)
        .map((e) => [e.question_seq, e])
    );
    const answers = this.eventLog.filter((e) => e.type === events.EVENTS.BRAINSTORMING_ANSWER_RECEIVED);
    for (const answer of answers) {
      const question = questions.get(answer.question_seq);
      parts.push(`Q${answer.question_seq}: ${question?.question || "(question unavailable)"}\nAnswer: ${answer.content}`);
    }
    return clipText(parts.join("\n\n"), 3000);
  }

  nextQuestionSeq() {
    const seen = this.eventLog.filter((e) => e.type === events.EVENTS.BRAINSTORMING_QUESTION_CREATED);
    return seen.length + 1;
  }

  nextDesignRevision() {
    return this.eventLog.filter((e) => e.type === events.EVENTS.DESIGN_REVISION_WRITTEN).length + 1;
  }

  async runBrainstormingPrelude(topic, context, limits, designCouncilConfig) {
    this.emitEvent(events.EVENTS.BRAINSTORMING_STARTED, {
      lead_agent: designCouncilConfig.lead_agent,
      skill_id: "brainstorming_prelude",
      max_questions: designCouncilConfig.max_questions,
    });

    const agents = availableAgents(this.config.agents);
    const lead = agents[designCouncilConfig.lead_agent];
    const brief = this.buildBrainstormingBrief(topic);
    const prompt = this.prompts.renderPrompt("brainstorming_ask_or_draft.md", { topic, brief });
    const result = await this.runAgent(designCouncilConfig.lead_agent, lead, prompt);
    if (!result.ok) {
      this.errorCount++;
      this.emitEvent(events.EVENTS.COORDINATOR_ERROR, {
        turn: null,
        message: result.error || "brainstorming ask_or_draft failed",
        recoverable: true,
        action: "retry",
        details: {},
      });
      return { waiting: false, error: true };
    }

    const parsed = require("./design-council").parseAskOrDraft(result.text);
    if (!parsed.ok) {
      this.errorCount++;
      this.emitEvent(events.EVENTS.COORDINATOR_ERROR, {
        turn: null,
        message: parsed.error,
        recoverable: true,
        action: "retry",
        details: { raw: String(result.text || "").slice(0, 500) },
      });
      return { waiting: false, error: true };
    }

    if (parsed.value.decision === "ask_user") {
      const questionSeq = this.nextQuestionSeq();
      this.emitEvent(events.EVENTS.BRAINSTORMING_QUESTION_CREATED, {
        question_seq: questionSeq,
        agent: designCouncilConfig.lead_agent,
        question: parsed.value.question,
        reason: parsed.value.reason,
        known_context: parsed.value.known_context,
        missing_context: parsed.value.missing_context,
      });
      return { waiting: true };
    }

    // draft_design — create design draft and commit
    await this.createDesignDraft(topic, designCouncilConfig, parsed.value);
    this.emitEvent(events.EVENTS.PHASE_TRANSITION, {
      from: "brainstorming",
      to: "discussion",
      trigger: "design_commit_created",
      reason: "Design draft committed; entering council review.",
    });
    this.phase = "discussion";
    return { waiting: false, draft: true };
  }

  addBrainstormingAnswer(content) {
    const text = String(content || "").trim();
    if (!text) return null;
    const latestQuestion = [...this.eventLog].reverse().find((e) => e.type === events.EVENTS.BRAINSTORMING_QUESTION_CREATED);
    if (!latestQuestion) return null;
    return this.emitEvent(events.EVENTS.BRAINSTORMING_ANSWER_RECEIVED, {
      question_seq: latestQuestion.question_seq,
      content: text,
    });
  }

  async resumeDesignCouncil(topic) {
    this.waitingForUser = false;
    const limits = this.resolveCouncilLimits();
    const designCouncilConfig = resolveDesignCouncilConfig(this.config, this.brainstormingConfig);
    const preludeResult = await this.runBrainstormingPrelude(topic, {}, limits, designCouncilConfig);
    if (preludeResult.waiting) {
      this.waitingForUser = true;
      return { outcome: "waiting_for_user", turnCount: this.turnCount, errorCount: this.errorCount };
    }
    return await this.runDiscussionLoop(topic);
  }

  async createDesignDraft(topic, designCouncilConfig, draftDecision) {
    const design = require("./design-council");
    const artifactPath = design.buildDesignArtifactPath(this.projectRoot, topic);
    const brief = this.buildBrainstormingBrief(topic);
    const draftContext = [
      `Reason: ${draftDecision?.reason || ""}`,
      `Known context: ${(draftDecision?.known_context || []).join("; ")}`,
      `Missing context: ${(draftDecision?.missing_context || []).join("; ")}`,
    ].join("\n");
    const prompt = this.prompts.renderPrompt("design_draft.md", { topic, brief, draft_context: draftContext });
    const agents = availableAgents(this.config.agents);
    const result = await this.runAgent(designCouncilConfig.lead_agent, agents[designCouncilConfig.lead_agent], prompt);
    if (!result.ok) throw new Error(result.error || "design draft failed");

    design.ensureDesignDirectory(artifactPath);
    fs.writeFileSync(artifactPath, String(result.text || "").trim() + "\n", "utf8");
    this.emitEvent(events.EVENTS.DESIGN_FILE_WRITTEN, {
      artifact_path: artifactPath,
      generator: designCouncilConfig.lead_agent,
      title: topic,
      revision: 0,
    });

    const message = `docs: draft ${design.slugifyDesignTopic(topic)} design`;
    const committed = await design.commitDesignArtifact({
      artifactPath,
      projectRoot: this.projectRoot,
      message,
      runGit: this.runGit,
    });
    if (!committed.ok) {
      this.emitEvent(events.EVENTS.DESIGN_COMMIT_FAILED, {
        artifact_path: artifactPath,
        revision: 0,
        stage: committed.stage,
        error: committed.error,
      });
      return { ok: false };
    }
    this.emitEvent(events.EVENTS.DESIGN_COMMIT_CREATED, {
      artifact_path: artifactPath,
      commit: committed.commit,
      commit_message: message,
    });
    return { ok: true, artifactPath, commit: committed.commit };
  }

  async reviseDesignFromLatestReview(topic, reviewEvent) {
    const design = require("./design-council");
    const latestFile = [...this.eventLog].reverse().find((e) => e.type === events.EVENTS.DESIGN_FILE_WRITTEN || e.type === events.EVENTS.DESIGN_REVISION_WRITTEN);
    const latestCommit = [...this.eventLog].reverse().find((e) => e.type === events.EVENTS.DESIGN_REVISION_COMMITTED || e.type === events.EVENTS.DESIGN_COMMIT_CREATED);
    if (!latestFile || !latestCommit) return null;

    const dc = resolveDesignCouncilConfig(this.config, this.brainstormingConfig);
    const agents = availableAgents(this.config.agents);
    const currentDesign = fs.readFileSync(latestFile.artifact_path, "utf8");
    const findings = [
      reviewEvent.content || "",
      reviewEvent.signal ? JSON.stringify(reviewEvent.signal, null, 2) : "",
    ].filter(Boolean).join("\n\n");
    const prompt = this.prompts.renderPrompt("design_revision.md", { design: currentDesign, findings });
    const result = await this.runAgent(dc.lead_agent, agents[dc.lead_agent], prompt);
    if (!result.ok) return null;

    fs.writeFileSync(latestFile.artifact_path, String(result.text || "").trim() + "\n", "utf8");
    this.emitEvent(events.EVENTS.DESIGN_REVISION_WRITTEN, {
      artifact_path: latestFile.artifact_path,
      source_commit: latestCommit.commit,
      source_review_seq: reviewEvent.seq,
      generator: dc.lead_agent,
      revision: this.nextDesignRevision(),
    });

    const message = `docs: revise ${design.slugifyDesignTopic(topic)} design`;
    const committed = await design.commitDesignArtifact({ artifactPath: latestFile.artifact_path, projectRoot: this.projectRoot, message, runGit: this.runGit });
    if (!committed.ok) {
      this.emitEvent(events.EVENTS.DESIGN_COMMIT_FAILED, {
        artifact_path: latestFile.artifact_path,
        revision: this.nextDesignRevision(),
        stage: committed.stage,
        error: committed.error,
      });
      return null;
    }
    this.emitEvent(events.EVENTS.DESIGN_REVISION_COMMITTED, {
      artifact_path: latestFile.artifact_path,
      source_commit: latestCommit.commit,
      commit: committed.commit,
      commit_message: message,
    });
    return committed.commit;
  }

  async routeCoordinator(topic, context, agentProfiles, limits) {
    const coordinator = selectCoordinator(this.config);
    if (!coordinator) {
      this.emitEvent(events.EVENTS.SESSION_ERROR, {
        message: "no available coordinator agent",
        recoverable: false,
        action: "abort",
        details: {},
      });
      this.errorCount++;
      return { decision: "finalize", next_agent: null };
    }

    this.emitEvent(events.EVENTS.COORDINATOR_TURN_STARTED, {
      turn: 0,
      coordinator: coordinator.name,
      purpose: "route",
    });

    const brief = this.buildBrief(topic, context, limits, this.eventLog);
    const prompt = this.prompts.renderPrompt("council_route.md", {
      agent_profiles: agentProfiles,
      topic,
      context: clipText(context, limits.maxContextChars),
      transcript: brief.transcript,
    });

    const started = Date.now();
    const result = await this.runAgent(coordinator.name, coordinator.config, prompt);
    const durationMs = Date.now() - started;

    if (!result.ok) {
      this.emitEvent(events.EVENTS.COORDINATOR_ERROR, {
        turn: 0,
        message: result.error || "coordinator route failed",
        recoverable: true,
        action: "fallback_finalize",
        details: {},
      });
      this.emitEvent(events.EVENTS.COORDINATOR_TURN_COMPLETED, {
        turn: 0, coordinator: coordinator.name, purpose: "route", status: "error", duration_ms: durationMs,
      });
      this.errorCount++;
      return { decision: "finalize", next_agent: null };
    }

    const parsed = parseJsonDecision(result.text, "continue");
    if (!parsed) {
      this.emitEvent(events.EVENTS.COORDINATOR_ERROR, {
        turn: 0,
        message: "failed to parse coordinator route decision JSON",
        recoverable: true,
        action: "fallback_finalize",
        details: { raw: result.text.slice(0, 500) },
      });
      this.emitEvent(events.EVENTS.COORDINATOR_TURN_COMPLETED, {
        turn: 0, coordinator: coordinator.name, purpose: "route", status: "error", duration_ms: durationMs,
      });
      this.errorCount++;
      return { decision: "finalize", next_agent: null };
    }

    this.emitEvent(events.EVENTS.COORDINATOR_DECIDED, {
      turn: 0,
      coordinator: coordinator.name,
      decision: "continue",
      next_agent: parsed.next_agent,
      role: parsed.role,
      reason: parsed.reason,
    });

    this.emitEvent(events.EVENTS.COORDINATOR_TURN_COMPLETED, {
      turn: 0, coordinator: coordinator.name, purpose: "route", status: "ok", duration_ms: durationMs,
    });

    return { decision: "continue", next_agent: parsed.next_agent, role: parsed.role };
  }

  async runAgentTurn(turnNum, agentName, agentConfig, role, topic, context, limits) {
    this.emitEvent(events.EVENTS.AGENT_TURN_STARTED, {
      turn: turnNum,
      agent: agentName,
      role: role || "参与讨论",
      selected_by: "coordinator",
      selection_reason: "coordinator 根据讨论状态选择",
    });

    const brief = this.buildBrief(topic, context, limits, this.eventLog);
    const prompt = this.prompts.renderPrompt("council_agent_turn.md", {
      agent_name: agentName,
      turn_role: role || "参与讨论",
      topic,
      context: clipText(context, limits.maxContextChars),
      transcript: brief.transcript,
    });

    const started = Date.now();
    const result = await this.runAgent(agentName, agentConfig, prompt);
    const durationMs = Date.now() - started;

    if (!result.ok) {
      this.emitEvent(events.EVENTS.AGENT_ERROR, {
        turn: turnNum,
        agent: agentName,
        message: result.error || "agent turn failed",
        recoverable: true,
        action: "skip_turn",
        details: {},
      });
      this.errorCount++;
      return;
    }

    const parsedSignal = parseAgentTurnSignal(result.text || "");
    let content = result.text || "";
    let signal = null;
    let signalParseError = null;

    if (parsedSignal.ok) {
      content = parsedSignal.content;
      signal = parsedSignal.signal;
    } else {
      signal = fallbackAgentSignal();
      signalParseError = parsedSignal.error;
    }

    const completedEvent = this.emitEvent(events.EVENTS.AGENT_TURN_COMPLETED, {
      turn: turnNum,
      agent: agentName,
      content,
      content_length: content.length,
      duration_ms: durationMs,
      signal,
      ...(signalParseError ? { signal_parse_error: signalParseError } : {}),
    });
    return { ok: true, event: completedEvent };
  }

  async decideCoordinator(topic, context, agentProfiles, limits, maxTurns) {
    const coordinator = selectCoordinator(this.config);
    if (!coordinator) {
      this.errorCount++;
      return { decision: "finalize", next_agent: null };
    }

    this.emitEvent(events.EVENTS.COORDINATOR_TURN_STARTED, {
      turn: this.turnCount,
      coordinator: coordinator.name,
      purpose: "decide",
    });

    const brief = this.buildBrief(topic, context, limits, this.eventLog);
    const prompt = this.prompts.renderPrompt("council_decide.md", {
      agent_profiles: agentProfiles,
      max_turns: String(maxTurns),
      turn_count: String(this.turnCount),
      topic,
      context: clipText(context, limits.maxContextChars),
      transcript: brief.transcript,
    });

    const started = Date.now();
    const result = await this.runAgent(coordinator.name, coordinator.config, prompt);
    const durationMs = Date.now() - started;

    if (!result.ok) {
      this.emitEvent(events.EVENTS.COORDINATOR_ERROR, {
        turn: this.turnCount,
        message: result.error || "coordinator decide failed",
        recoverable: true,
        action: "fallback_finalize",
        details: {},
      });
      this.emitEvent(events.EVENTS.COORDINATOR_TURN_COMPLETED, {
        turn: this.turnCount, coordinator: coordinator.name, purpose: "decide", status: "error", duration_ms: durationMs,
      });
      this.errorCount++;
      return null;
    }

    const parsed = parseJsonDecision(result.text, "finalize");
    if (!parsed) {
      this.emitEvent(events.EVENTS.COORDINATOR_ERROR, {
        turn: this.turnCount,
        message: "failed to parse coordinator decide JSON",
        recoverable: true,
        action: "fallback_finalize",
        details: { raw: result.text.slice(0, 500) },
      });
      this.emitEvent(events.EVENTS.COORDINATOR_TURN_COMPLETED, {
        turn: this.turnCount, coordinator: coordinator.name, purpose: "decide", status: "error", duration_ms: durationMs,
      });
      this.errorCount++;
      return null;
    }

    const decision = parsed.decision || "finalize";
    this.emitEvent(events.EVENTS.COORDINATOR_DECIDED, {
      turn: this.turnCount,
      coordinator: coordinator.name,
      decision,
      next_agent: parsed.next_agent || null,
      role: parsed.role || null,
      reason: parsed.reason || "",
    });

    this.emitEvent(events.EVENTS.COORDINATOR_TURN_COMPLETED, {
      turn: this.turnCount, coordinator: coordinator.name, purpose: "decide", status: "ok", duration_ms: durationMs,
    });

    return { decision, next_agent: parsed.next_agent || null, role: parsed.role || null };
  }

  async finalizeCouncil(topic, context, limits) {
    const coordinator = selectCoordinator(this.config);
    if (!coordinator) return;

    this.emitEvent(events.EVENTS.FINALIZATION_STARTED, { turn_count: this.turnCount });

    const brief = this.buildBrief(topic, context, limits, this.eventLog);
    const prompt = this.prompts.renderPrompt("council_finalize.md", {
      topic,
      context: clipText(context, limits.maxContextChars),
      transcript: brief.transcript,
    });

    const result = await this.runAgent(coordinator.name, coordinator.config, prompt);

    if (!result.ok) {
      this.emitEvent(events.EVENTS.FINALIZED, {
        summary: "Finalization failed: " + (result.error || "unknown error"),
        next_steps: [],
      });
      return;
    }

    const parsed = parseJsonDecision(result.text, "finalize");
    if (parsed && parsed.consensus) {
      this.emitEvent(events.EVENTS.FINALIZED, {
        summary: parsed.consensus,
        next_steps: parsed.next_steps || [],
      });
    } else {
      this.emitEvent(events.EVENTS.FINALIZED, {
        summary: result.text || "",
        next_steps: [],
      });
    }
  }

  buildBrief(topic, context, limits, log) {
    // Latest signal block — never clipped, must survive transcript budget.
    let signalBlock = "";
    const latest = latestSignalsByAgent(log);
    if (latest.length > 0) {
      const entries = latest.map((item) =>
        `- **${item.agent}** (turn ${item.turn}): ${formatSignalForBrief(item.signal)}`
      );
      signalBlock = `### Latest Agent Signals\n\n${entries.join("\n")}`;
    }

    const recentMessages = [];

    // Inject design block for design_council mode
    const latestDesign = [...log].reverse().find((e) => e.type === events.EVENTS.DESIGN_REVISION_COMMITTED || e.type === events.EVENTS.DESIGN_COMMIT_CREATED);
    const latestFile = [...log].reverse().find((e) => e.type === events.EVENTS.DESIGN_REVISION_WRITTEN || e.type === events.EVENTS.DESIGN_FILE_WRITTEN);
    if (this.mode === "design_council" && latestFile) {
      let designSummary = "";
      try {
        const designText = fs.readFileSync(latestFile.artifact_path, "utf8");
        designSummary = require("./design-council").summarizeDesignForBrief(designText, this.config.council?.max_design_brief_chars || 1800);
      } catch (_) {
        designSummary = "Design file could not be read; use artifact path.";
      }
      recentMessages.unshift([
        "### Design artifact",
        `Path: ${latestFile.artifact_path}`,
        `Commit: ${latestDesign?.commit || "none"}`,
        "",
        designSummary,
        "",
        "Council task: review, challenge, and constructively improve the design document. Do not generate an implementation plan.",
      ].join("\n"));
    }

    const recent = log.slice(-6);
    for (const event of recent) {
      if (event.type === "agent_turn_completed") {
        recentMessages.push(`### ${event.agent} (turn ${event.turn})\n\n${clipText(event.content, limits.maxMessageChars)}`);
      } else if (event.type === "coordinator_decided") {
        recentMessages.push(`### Coordinator decided: ${event.decision}\nNext: ${event.next_agent || "none"}\nRole: ${event.role || "none"}\nReason: ${event.reason || ""}`);
      } else if (event.type === "policy_override") {
        recentMessages.push(`### Policy override: ${event.policy}\n${event.original_decision} → ${event.new_decision}\nReason: ${event.reason}`);
      } else if (event.type === "user_interjection") {
        recentMessages.push(`### Host interjection (turn ${event.turn})\n\n${clipText(event.content, limits.maxMessageChars)}`);
      }
    }

    const clippedTranscript = clipText(recentMessages.join("\n\n"), limits.maxTranscriptChars);
    const transcript = signalBlock ? `${signalBlock}\n\n${clippedTranscript}` : clippedTranscript;

    return {
      context: clipText(context, limits.maxContextChars),
      transcript,
      topic,
    };
  }

  enforceMinDistinctAgents(decision, agents, minDistinctAgents, maxTurns) {
    if (decision.decision !== "finalize") return decision;
    if (this.turnCount >= maxTurns) return decision;
    if (this.spokenAgents.size >= minDistinctAgents) return decision;

    const agentNames = Object.keys(agents);
    let nextAgent = null;
    for (const name of agentNames) {
      if (!this.spokenAgents.has(name)) {
        nextAgent = name;
        break;
      }
    }
    if (!nextAgent) return decision;

    return {
      decision: "continue",
      next_agent: nextAgent,
      role: "Provide an independent second perspective before the council finalizes.",
      reason: `Coordinator requested finalize, but council.min_distinct_agents=${minDistinctAgents} requires at least ${minDistinctAgents} distinct agents to have spoken.`,
    };
  }

  avoidCoordinatorAsFirstAgent(decision, agents) {
    if (!decision || decision.decision !== "continue") return decision;
    if (this.turnCount !== 0) return decision;
    const coordinator = selectCoordinator(this.config);
    if (!coordinator || decision.next_agent !== coordinator.name) return decision;

    const alternative = Object.keys(agents).find((name) => name !== coordinator.name);
    if (!alternative) return decision;

    this.emitEvent(events.EVENTS.POLICY_OVERRIDE, {
      turn: 0,
      policy: "avoid_coordinator_first_agent",
      original_decision: "continue",
      new_decision: "continue",
      selected_agent: alternative,
      reason: "enabled agent count > 1; first agent should not be the coordinator",
    });

    return {
      decision: "continue",
      next_agent: alternative,
      role: decision.role || "Provide the first independent perspective.",
      reason: "Policy selected a non-coordinator agent for the first turn.",
    };
  }

  selectPolicyContinuationAgent(agents) {
    for (const name of Object.keys(agents)) {
      if (!this.spokenAgents.has(name)) return name;
    }
    const coordinator = selectCoordinator(this.config);
    for (const name of Object.keys(agents)) {
      if (name !== coordinator?.name) return name;
    }
    return Object.keys(agents)[0] || null;
  }

  applyFinalizeGate(decision, agents, minDistinctAgents, maxTurns) {
    if (!decision || decision.decision !== "finalize") return decision;
    if (this.turnCount >= maxTurns) return decision;

    const gate = shouldAllowFinalize(this.eventLog, { minDistinctAgents });
    if (gate.allowed) return decision;

    const maxOverrides = this.config.council?.finalize_gate_max_overrides ?? 2;
    const hasUnspokenAgent = Object.keys(agents).some((name) => !this.spokenAgents.has(name));
    if (this.finalizeGateOverrideCount >= maxOverrides && !hasUnspokenAgent) {
      this.emitEvent(events.EVENTS.POLICY_OVERRIDE, {
        turn: this.turnCount,
        policy: "finalize_gate_fallback",
        original_decision: "finalize",
        new_decision: "finalize",
        selected_agent: null,
        reason: `fallback finalize after ${maxOverrides} finalize_gate overrides; unresolved: ${gate.reason}`,
      });
      return decision;
    }

    const nextAgent = this.selectPolicyContinuationAgent(agents);
    if (!nextAgent) return decision;

    this.finalizeGateOverrideCount++;
    this.emitEvent(events.EVENTS.POLICY_OVERRIDE, {
      turn: this.turnCount,
      policy: "finalize_gate",
      original_decision: "finalize",
      new_decision: "continue",
      selected_agent: nextAgent,
      reason: gate.reason,
    });

    return {
      decision: "continue",
      next_agent: nextAgent,
      role: "Respond to unresolved blockers and assess whether the council can finalize.",
      reason: gate.reason,
    };
  }
}

module.exports = { CouncilEngine, parseJsonDecision, parseAgentTurnSignal, fallbackAgentSignal, latestSignalsByAgent, shouldAllowFinalize, resolveAgentName, clipText, formatAgentProfiles, selectCoordinator, collectContext, availableAgents, resolveDesignCouncilConfig, validateRequiredAgents };
CouncilEngine.validateRequiredAgents = validateRequiredAgents;
