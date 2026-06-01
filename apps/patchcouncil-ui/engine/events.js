"use strict";

const EVENTS = {
  SESSION_STARTED: "session_started",
  PHASE_TRANSITION: "phase_transition",
  COORDINATOR_TURN_STARTED: "coordinator_turn_started",
  COORDINATOR_DECIDED: "coordinator_decided",
  COORDINATOR_TURN_COMPLETED: "coordinator_turn_completed",
  POLICY_OVERRIDE: "policy_override",
  AGENT_TURN_STARTED: "agent_turn_started",
  AGENT_TURN_COMPLETED: "agent_turn_completed",
  FINALIZATION_STARTED: "finalization_started",
  FINALIZED: "finalized",
  SESSION_FINISHED: "session_finished",
  AGENT_ERROR: "agent_error",
  COORDINATOR_ERROR: "coordinator_error",
  SESSION_ERROR: "session_error",
  USER_INTERJECTION: "user_interjection",
  SESSION_CANCEL_REQUESTED: "session_cancel_requested",
  WORKPLAN_GENERATION_STARTED: "workplan_generation_started",
  WORKPLAN_CREATED: "workplan_created",
  WORKPLAN_GENERATION_FAILED: "workplan_generation_failed",
};

function baseEvent(sessionId, seq, type, phase) {
  return { schema_version: 1, seq, type, phase, session_id: sessionId };
}

function sessionStarted(sessionId, seq, phase, topic, mode, config, capabilities, agents, startedAt) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.SESSION_STARTED, phase), {
    started_at: startedAt,
    topic,
    mode,
    config,
    capabilities,
    agents,
  });
}

function phaseTransition(sessionId, seq, phase, from, to, trigger, reason) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.PHASE_TRANSITION, phase), {
    from, to, trigger, reason,
  });
}

function coordinatorTurnStarted(sessionId, seq, phase, turn, coordinator, purpose) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.COORDINATOR_TURN_STARTED, phase), {
    turn, coordinator, purpose,
  });
}

function coordinatorDecided(sessionId, seq, phase, turn, coordinator, decision, nextAgent, role, reason) {
  const event = Object.assign(baseEvent(sessionId, seq, EVENTS.COORDINATOR_DECIDED, phase), {
    turn, coordinator, decision, reason,
  });
  if (nextAgent != null) event.next_agent = nextAgent;
  if (role != null) event.role = role;
  return event;
}

function coordinatorTurnCompleted(sessionId, seq, phase, turn, coordinator, purpose, status, durationMs) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.COORDINATOR_TURN_COMPLETED, phase), {
    turn, coordinator, purpose, status, duration_ms: durationMs,
  });
}

function policyOverride(sessionId, seq, phase, turn, policy, originalDecision, newDecision, selectedAgent, reason) {
  const event = Object.assign(baseEvent(sessionId, seq, EVENTS.POLICY_OVERRIDE, phase), {
    turn, policy, original_decision: originalDecision, new_decision: newDecision, reason,
  });
  if (selectedAgent != null) event.selected_agent = selectedAgent;
  return event;
}

function agentTurnStarted(sessionId, seq, phase, turn, agent, role, selectedBy, selectionReason) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.AGENT_TURN_STARTED, phase), {
    turn, agent, role, selected_by: selectedBy, selection_reason: selectionReason,
  });
}

function agentTurnCompleted(sessionId, seq, phase, turn, agent, content, contentLength, durationMs, signal, signalParseError) {
  const event = Object.assign(baseEvent(sessionId, seq, EVENTS.AGENT_TURN_COMPLETED, phase), {
    turn, agent, content, content_length: contentLength, duration_ms: durationMs,
  });
  if (signal) event.signal = signal;
  if (signalParseError) event.signal_parse_error = signalParseError;
  return event;
}

function finalizationStarted(sessionId, seq, phase, turnCount) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.FINALIZATION_STARTED, phase), {
    turn_count: turnCount,
  });
}

function finalized(sessionId, seq, phase, summary, nextSteps) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.FINALIZED, phase), {
    summary, next_steps: nextSteps,
  });
}

function sessionFinished(sessionId, seq, phase, finishedAt, outcome, durationMs, turnCount, distinctAgents, errorCount) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.SESSION_FINISHED, phase), {
    finished_at: finishedAt,
    outcome,
    duration_ms: durationMs,
    turn_count: turnCount,
    distinct_agents: distinctAgents,
    error_count: errorCount,
  });
}

function agentError(sessionId, seq, phase, turn, agent, message, recoverable, action, details) {
  const event = Object.assign(baseEvent(sessionId, seq, EVENTS.AGENT_ERROR, phase), {
    agent, message, recoverable, action, details: details || {},
  });
  if (turn != null) event.turn = turn;
  return event;
}

function coordinatorError(sessionId, seq, phase, turn, message, recoverable, action, details) {
  const event = Object.assign(baseEvent(sessionId, seq, EVENTS.COORDINATOR_ERROR, phase), {
    message, recoverable, action, details: details || {},
  });
  if (turn != null) event.turn = turn;
  return event;
}

function sessionError(sessionId, seq, phase, message, recoverable, action, details) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.SESSION_ERROR, phase), {
    message, recoverable, action, details: details || {},
  });
}

function userInterjection(sessionId, seq, phase, turn, content, createdAt) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.USER_INTERJECTION, phase), {
    turn,
    content,
    created_at: createdAt,
  });
}

function sessionCancelRequested(sessionId, seq, phase, requestedAt, reason) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.SESSION_CANCEL_REQUESTED, phase), {
    requested_at: requestedAt,
    reason: reason || "user",
  });
}

function workplanGenerationStarted(sessionId, seq, phase, requestedAt, generator) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.WORKPLAN_GENERATION_STARTED, phase), {
    requested_at: requestedAt,
    generator,
  });
}

function workplanCreated(sessionId, seq, phase, createdAt, generator, source, workplan) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.WORKPLAN_CREATED, phase), {
    created_at: createdAt,
    generator,
    source: source || {},
    workplan,
  });
}

function workplanGenerationFailed(sessionId, seq, phase, failedAt, generator, message, recoverable, action, details) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.WORKPLAN_GENERATION_FAILED, phase), {
    failed_at: failedAt,
    generator,
    message,
    recoverable,
    action,
    details: details || {},
  });
}

module.exports = {
  EVENTS,
  baseEvent,
  sessionStarted,
  phaseTransition,
  coordinatorTurnStarted,
  coordinatorDecided,
  coordinatorTurnCompleted,
  policyOverride,
  agentTurnStarted,
  agentTurnCompleted,
  finalizationStarted,
  finalized,
  sessionFinished,
  agentError,
  coordinatorError,
  sessionError,
  userInterjection,
  sessionCancelRequested,
  workplanGenerationStarted,
  workplanCreated,
  workplanGenerationFailed,
};
