"use strict";

class JsonlSink {
  constructor({ sessionStore, sessionDir }) {
    this.sessionStore = sessionStore;
    this.sessionDir = sessionDir;
  }

  consume(event) {
    // skip runtime-level streaming events
    if (event.type && event.type.startsWith("runtime.")) return;
    this.sessionStore.appendEvent(this.sessionDir, event);
  }
}

class StateSnapshotSink {
  constructor({ sessionStore, sessionDir }) {
    this.sessionStore = sessionStore;
    this.sessionDir = sessionDir;
  }

  consume(_event) {
    this.sessionStore.deriveState(this.sessionDir);
  }
}

class CliRendererSink {
  constructor({ stream = process.stderr } = {}) {
    this.stream = stream;
  }

  consume(event) {
    const line = this.format(event);
    if (line) this.stream.write(line + "\n");
  }

  format(event) {
    switch (event.type) {
      case "session_started":
        return `[council] Session started: ${event.topic}`;
      case "coordinator_turn_started":
        return `[${event.coordinator}] Thinking (${event.purpose})...`;
      case "coordinator_decided":
        return `[${event.coordinator}] Decision: ${event.decision}${event.next_agent ? " -> " + event.next_agent : ""} (${event.reason})`;
      case "coordinator_turn_completed":
        if (event.status === "error") return `[${event.coordinator}] Failed (${event.purpose})`;
        return `[${event.coordinator}] Done (${event.purpose}, ${event.duration_ms}ms)`;
      case "agent_turn_started":
        return `[${event.agent}] Speaking as "${event.role}"...`;
      case "agent_turn_completed":
        return `[${event.agent}] Done (${event.content_length} chars, ${event.duration_ms}ms)`;
      case "policy_override":
        return `[policy] Override: ${event.original_decision} -> ${event.new_decision} (${event.reason})`;
      case "finalization_started":
        return `[council] Finalizing (${event.turn_count} turns)...`;
      case "finalized":
        return `[council] Final: ${(event.summary || "").slice(0, 120)}...`;
      case "session_finished":
        return `[council] Session done: ${event.outcome} (${event.turn_count} turns, ${event.distinct_agents?.join(", ")})`;
      case "user_interjection":
        return `[host] Interjection queued: ${(event.content || "").slice(0, 120)}`;
      case "session_cancel_requested":
        return `[council] Cancellation requested (${event.reason || "user"})`;
      case "workplan_generation_started":
        return `[workplan] Generating with ${event.generator}`;
      case "workplan_created":
        return `[workplan] Created: ${event.workplan?.title || "Untitled workplan"}`;
      case "workplan_generation_failed":
        return `[workplan] Failed: ${event.message}`;
      case "agent_error":
      case "coordinator_error":
      case "session_error":
        return `[error] ${event.type}: ${event.message} (action: ${event.action})`;
      default:
        return null;
    }
  }
}

module.exports = { JsonlSink, StateSnapshotSink, CliRendererSink };
