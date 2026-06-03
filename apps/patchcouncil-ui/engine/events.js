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
  WORKPLAN_DRAFT_STARTED: "workplan_draft_started",
  WORKPLAN_DRAFT_WRITTEN: "workplan_draft_written",
  WORKPLAN_DRAFT_COMMITTED: "workplan_draft_committed",
  WORKPLAN_DRAFT_COMMIT_FAILED: "workplan_draft_commit_failed",
  WORKPLAN_REVIEW_STARTED: "workplan_review_started",
  WORKPLAN_REVIEW_COMPLETED: "workplan_review_completed",
  WORKPLAN_AUTHOR_RESPONSE_STARTED: "workplan_author_response_started",
  WORKPLAN_AUTHOR_RESPONSE_COMPLETED: "workplan_author_response_completed",
  WORKPLAN_REVISION_WRITTEN: "workplan_revision_written",
  WORKPLAN_REVISION_COMMITTED: "workplan_revision_committed",
  WORKPLAN_REVISION_COMMIT_FAILED: "workplan_revision_commit_failed",
  WORKPLAN_APPROVAL_REQUESTED: "workplan_approval_requested",
  WORKPLAN_APPROVED: "workplan_approved",
  WORKPLAN_APPROVAL_REJECTED: "workplan_approval_rejected",
  BRAINSTORMING_STARTED: "brainstorming_started",
  BRAINSTORMING_QUESTION_CREATED: "brainstorming_question_created",
  BRAINSTORMING_ANSWER_RECEIVED: "brainstorming_answer_received",
  DESIGN_FILE_WRITTEN: "design_file_written",
  DESIGN_COMMIT_CREATED: "design_commit_created",
  DESIGN_COMMIT_FAILED: "design_commit_failed",
  DESIGN_REVISION_WRITTEN: "design_revision_written",
  DESIGN_REVISION_COMMITTED: "design_revision_committed",
  DESIGN_AUTHOR_RESPONSE_STARTED: "design_author_response_started",
  DESIGN_AUTHOR_RESPONSE_COMPLETED: "design_author_response_completed",
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

function brainstormingStarted(sessionId, seq, phase, leadAgent, skillId, maxQuestions) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.BRAINSTORMING_STARTED, phase), {
    lead_agent: leadAgent,
    skill_id: skillId,
    max_questions: maxQuestions,
  });
}

function brainstormingQuestionCreated(sessionId, seq, phase, questionSeq, agent, question, reason, knownContext, missingContext) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.BRAINSTORMING_QUESTION_CREATED, phase), {
    question_seq: questionSeq,
    agent,
    question,
    reason,
    known_context: knownContext || [],
    missing_context: missingContext || [],
  });
}

function brainstormingAnswerReceived(sessionId, seq, phase, questionSeq, content) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.BRAINSTORMING_ANSWER_RECEIVED, phase), {
    question_seq: questionSeq,
    content,
  });
}

function designFileWritten(sessionId, seq, phase, artifactPath, generator, title, revision) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.DESIGN_FILE_WRITTEN, phase), {
    artifact_path: artifactPath,
    generator,
    title,
    revision,
  });
}

function designCommitCreated(sessionId, seq, phase, artifactPath, commit, commitMessage) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.DESIGN_COMMIT_CREATED, phase), {
    artifact_path: artifactPath,
    commit,
    commit_message: commitMessage,
  });
}

function designCommitFailed(sessionId, seq, phase, artifactPath, revision, stage, error) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.DESIGN_COMMIT_FAILED, phase), {
    artifact_path: artifactPath,
    revision,
    stage,
    error,
  });
}

function designRevisionWritten(sessionId, seq, phase, artifactPath, sourceCommit, sourceReviewSeq, generator, revision) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.DESIGN_REVISION_WRITTEN, phase), {
    artifact_path: artifactPath,
    source_commit: sourceCommit,
    source_review_seq: sourceReviewSeq,
    generator,
    revision,
  });
}

function designRevisionCommitted(sessionId, seq, phase, artifactPath, sourceCommit, commit, commitMessage) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.DESIGN_REVISION_COMMITTED, phase), {
    artifact_path: artifactPath,
    source_commit: sourceCommit,
    commit,
    commit_message: commitMessage,
  });
}

function designAuthorResponseStarted(sessionId, seq, phase, artifactPath, designCommit, author, sourceReviewSeq) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.DESIGN_AUTHOR_RESPONSE_STARTED, phase), {
    artifact_path: artifactPath,
    design_commit: designCommit,
    author,
    source_review_seq: sourceReviewSeq,
  });
}

function designAuthorResponseCompleted(sessionId, seq, phase, artifactPath, designCommit, author, sourceReviewSeq, sourceAgentTurnSeq, decision, revisionRequired) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.DESIGN_AUTHOR_RESPONSE_COMPLETED, phase), {
    artifact_path: artifactPath,
    design_commit: designCommit,
    author,
    source_review_seq: sourceReviewSeq,
    source_agent_turn_seq: sourceAgentTurnSeq,
    decision,
    revision_required: Boolean(revisionRequired),
  });
}

function workplanDraftStarted(sessionId, seq, phase, generator, sourceDesignPath, sourceDesignCommit) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.WORKPLAN_DRAFT_STARTED, phase), {
    generator,
    source_design_path: sourceDesignPath,
    source_design_commit: sourceDesignCommit,
  });
}

function workplanDraftWritten(sessionId, seq, phase, artifactPath, generator, sourceDesignCommit, title, revision) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.WORKPLAN_DRAFT_WRITTEN, phase), {
    artifact_path: artifactPath,
    generator,
    source_design_commit: sourceDesignCommit,
    title,
    revision,
  });
}

function workplanDraftCommitted(sessionId, seq, phase, artifactPath, sourceDesignCommit, commit, commitMessage) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.WORKPLAN_DRAFT_COMMITTED, phase), {
    artifact_path: artifactPath,
    source_design_commit: sourceDesignCommit,
    commit,
    commit_message: commitMessage,
  });
}

function workplanDraftCommitFailed(sessionId, seq, phase, artifactPath, sourceDesignCommit, stage, error) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.WORKPLAN_DRAFT_COMMIT_FAILED, phase), {
    artifact_path: artifactPath,
    source_design_commit: sourceDesignCommit,
    stage,
    error,
  });
}

function workplanReviewStarted(sessionId, seq, phase, artifactPath, workplanCommit, reviewer) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.WORKPLAN_REVIEW_STARTED, phase), {
    artifact_path: artifactPath,
    workplan_commit: workplanCommit,
    reviewer,
  });
}

function workplanReviewCompleted(sessionId, seq, phase, artifactPath, workplanCommit, reviewer, sourceAgentTurnSeq, requiresRevision) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.WORKPLAN_REVIEW_COMPLETED, phase), {
    artifact_path: artifactPath,
    workplan_commit: workplanCommit,
    reviewer,
    source_agent_turn_seq: sourceAgentTurnSeq,
    requires_revision: Boolean(requiresRevision),
  });
}

function workplanAuthorResponseStarted(sessionId, seq, phase, artifactPath, workplanCommit, author, sourceReviewSeq) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.WORKPLAN_AUTHOR_RESPONSE_STARTED, phase), {
    artifact_path: artifactPath,
    workplan_commit: workplanCommit,
    author,
    source_review_seq: sourceReviewSeq,
  });
}

function workplanAuthorResponseCompleted(sessionId, seq, phase, artifactPath, workplanCommit, author, sourceReviewSeq, sourceAgentTurnSeq, decision, revisionRequired) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.WORKPLAN_AUTHOR_RESPONSE_COMPLETED, phase), {
    artifact_path: artifactPath,
    workplan_commit: workplanCommit,
    author,
    source_review_seq: sourceReviewSeq,
    source_agent_turn_seq: sourceAgentTurnSeq,
    decision,
    revision_required: Boolean(revisionRequired),
  });
}

function workplanRevisionWritten(sessionId, seq, phase, artifactPath, sourceDesignCommit, sourceWorkplanCommit, sourceReviewSeq, generator, revision) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.WORKPLAN_REVISION_WRITTEN, phase), {
    artifact_path: artifactPath,
    source_design_commit: sourceDesignCommit,
    source_workplan_commit: sourceWorkplanCommit,
    source_review_seq: sourceReviewSeq,
    generator,
    revision,
  });
}

function workplanRevisionCommitted(sessionId, seq, phase, artifactPath, sourceDesignCommit, sourceWorkplanCommit, commit, commitMessage) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.WORKPLAN_REVISION_COMMITTED, phase), {
    artifact_path: artifactPath,
    source_design_commit: sourceDesignCommit,
    source_workplan_commit: sourceWorkplanCommit,
    commit,
    commit_message: commitMessage,
  });
}

function workplanRevisionCommitFailed(sessionId, seq, phase, artifactPath, sourceDesignCommit, sourceWorkplanCommit, stage, error) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.WORKPLAN_REVISION_COMMIT_FAILED, phase), {
    artifact_path: artifactPath,
    source_design_commit: sourceDesignCommit,
    source_workplan_commit: sourceWorkplanCommit,
    stage,
    error,
  });
}

function workplanApprovalRequested(sessionId, seq, phase, artifactPath, workplanCommit, requestedAt) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.WORKPLAN_APPROVAL_REQUESTED, phase), {
    artifact_path: artifactPath,
    workplan_commit: workplanCommit,
    requested_at: requestedAt,
  });
}

function workplanApproved(sessionId, seq, phase, artifactPath, approvedCommit, approvedAt, approvedBy) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.WORKPLAN_APPROVED, phase), {
    artifact_path: artifactPath,
    approved_commit: approvedCommit,
    approved_at: approvedAt,
    approved_by: approvedBy,
  });
}

function workplanApprovalRejected(sessionId, seq, phase, artifactPath, workplanCommit, rejectedAt, reason) {
  return Object.assign(baseEvent(sessionId, seq, EVENTS.WORKPLAN_APPROVAL_REJECTED, phase), {
    artifact_path: artifactPath,
    workplan_commit: workplanCommit,
    rejected_at: rejectedAt,
    reason,
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
  brainstormingStarted,
  brainstormingQuestionCreated,
  brainstormingAnswerReceived,
  designFileWritten,
  designCommitCreated,
  designCommitFailed,
  designRevisionWritten,
  designRevisionCommitted,
  designAuthorResponseStarted,
  designAuthorResponseCompleted,
  workplanDraftStarted,
  workplanDraftWritten,
  workplanDraftCommitted,
  workplanDraftCommitFailed,
  workplanReviewStarted,
  workplanReviewCompleted,
  workplanAuthorResponseStarted,
  workplanAuthorResponseCompleted,
  workplanRevisionWritten,
  workplanRevisionCommitted,
  workplanRevisionCommitFailed,
  workplanApprovalRequested,
  workplanApproved,
  workplanApprovalRejected,
};
