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

function formatAgentProfiles(config) {
  const agents = config.agents || {};
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
  const agents = config.agents || {};
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

    // per-run state
    this.seq = -1;
    this.turnCount = 0;
    this.spokenAgents = new Set();
    this.eventLog = [];
    this.phase = "discussion";
    this.errorCount = 0;
    this.startedAt = null;

    // host controls
    this.cancelRequested = false;
    this.cancelReason = null;
    this.interjections = [];
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

  async run(topic) {
    this.startedAt = new Date().toISOString();
    const councilCfg = this.config.council || {};
    const maxTurns = councilCfg.max_turns ?? 3;
    const minDistinctAgents = councilCfg.min_distinct_agents ?? 2;
    const maxContextChars = councilCfg.max_context_chars ?? 2500;
    const maxTranscriptChars = councilCfg.max_transcript_chars ?? 2500;
    const maxMessageChars = councilCfg.max_message_chars ?? 800;
    const agents = this.config.agents || {};

    const context = collectContext(this.projectRoot, this.config);
    const agentProfiles = formatAgentProfiles(this.config);

    const sourceContext = this.sourceMetadata
      ? "### Source session\n\n" + this.sourceMetadata.source_summary + "\n\nTranscript: " + this.sourceMetadata.source_transcript_path
      : "";
    const contextWithSource = [sourceContext, context].filter(Boolean).join("\n\n");

    // emit session_started
    const sessionConfigSnapshot = {
      council: councilCfg,
      agents: Object.fromEntries(
        Object.entries(agents).map(([id, cfg]) => [
          id,
          {
            command: cfg.command,
            args: cfg.args || [],
            input_mode: cfg.input_mode,
            capabilities: cfg.capabilities || [],
            write_access: Boolean(cfg.write_access),
            timeout_sec: cfg.timeout_sec,
            enabled: cfg.enabled !== false,
            roles: id === selectCoordinator(this.config)?.name ? ["coordinator", "agent"] : ["agent"],
          },
        ])
      ),
    };

    this.emitEvent(events.EVENTS.SESSION_STARTED, {
      started_at: this.startedAt,
      topic,
      mode: "council",
      ...(this.sourceMetadata ? {
        source_session_id: this.sourceMetadata.source_session_id,
        source_summary: this.sourceMetadata.source_summary,
        source_transcript_path: this.sourceMetadata.source_transcript_path,
      } : {}),
      config: sessionConfigSnapshot,
      capabilities: { can_execute: false, requires_user_confirmation_before_write: true },
      agents: Object.entries(agents).map(([id, cfg]) => ({ id, command: cfg.command, roles: id === selectCoordinator(this.config)?.name ? ["coordinator", "agent"] : ["agent"] })),
    });

    const limits = { maxContextChars, maxTranscriptChars, maxMessageChars };
    let decision = null;

    try {
      // --- route ---
      const routeResult = await this.routeCoordinator(topic, contextWithSource, agentProfiles, limits);
      decision = routeResult;

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

        await this.runAgentTurn(turnNum, agentName, agentConfig, decision.role, topic, context, limits);
        this.turnCount++;
        this.spokenAgents.add(agentName);

        if (this.turnCount >= maxTurns) break;

        // --- cancellation checkpoint ---
        if (this.cancelRequested) break;

        // --- decide ---
        const decideResult = await this.decideCoordinator(topic, context, agentProfiles, limits, maxTurns);
        if (!decideResult) {
          // JSON parse failure, already emitted coordinator_error, break to finalize
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
      await this.finalizeCouncil(topic, context, limits);
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

    const brief = this.buildBrief(topic, context, limits, []);
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

    const content = result.text || "";
    this.emitEvent(events.EVENTS.AGENT_TURN_COMPLETED, {
      turn: turnNum,
      agent: agentName,
      content,
      content_length: content.length,
      duration_ms: durationMs,
    });
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
    const recent = log.slice(-6);
    const messages = [];

    for (const event of recent) {
      if (event.type === "agent_turn_completed") {
        messages.push(`### ${event.agent} (turn ${event.turn})\n\n${clipText(event.content, limits.maxMessageChars)}`);
      } else if (event.type === "coordinator_decided") {
        messages.push(`### Coordinator decided: ${event.decision}\nNext: ${event.next_agent || "none"}\nRole: ${event.role || "none"}\nReason: ${event.reason || ""}`);
      } else if (event.type === "policy_override") {
        messages.push(`### Policy override: ${event.policy}\n${event.original_decision} → ${event.new_decision}\nReason: ${event.reason}`);
      } else if (event.type === "user_interjection") {
        messages.push(`### Host interjection (turn ${event.turn})\n\n${clipText(event.content, limits.maxMessageChars)}`);
      }
    }

    const transcript = clipText(messages.join("\n\n"), limits.maxTranscriptChars);

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
}

module.exports = { CouncilEngine, parseJsonDecision, resolveAgentName, clipText, formatAgentProfiles, selectCoordinator, collectContext };
