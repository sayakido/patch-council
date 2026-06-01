"use strict";

const fs = require("fs");
const path = require("path");

function clipTextLocal(text, limit) {
  const value = String(text || "");
  if (!value || value.length <= limit) return value;
  const head = Math.max(Math.floor(limit / 2), 1);
  const tail = Math.max(limit - head, 1);
  return value.slice(0, head) + "\n\n[... clipped ...]\n\n" + value.slice(-tail);
}

function dateStamp(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function slugifyDesignTopic(topic) {
  return String(topic || "")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9一-龥-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "design";
}

function buildDesignArtifactPath(projectRoot, topic, date = new Date()) {
  return path.join(projectRoot, "docs", "designs", `${dateStamp(date)}-${slugifyDesignTopic(topic)}.md`);
}

function parseJsonObject(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) { /* continue */ }
  const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fence) {
    try { return JSON.parse(fence[1].trim()); } catch (_) { /* continue */ }
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch (_) { /* continue */ }
  }
  return null;
}

function parseAskOrDraft(raw) {
  const value = parseJsonObject(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "failed to parse ask_or_draft JSON" };
  }
  if (!["ask_user", "draft_design"].includes(value.decision)) {
    return { ok: false, error: "invalid ask_or_draft decision" };
  }
  if (typeof value.reason !== "string" || !value.reason.trim()) {
    return { ok: false, error: "ask_or_draft.reason is required" };
  }
  value.known_context = Array.isArray(value.known_context) ? value.known_context.filter((x) => typeof x === "string") : [];
  value.missing_context = Array.isArray(value.missing_context) ? value.missing_context.filter((x) => typeof x === "string") : [];
  if (value.decision === "ask_user") {
    if (typeof value.question !== "string" || !value.question.trim()) {
      return { ok: false, error: "ask_or_draft.question is required" };
    }
    value.question = value.question.trim();
  }
  return { ok: true, value };
}

function summarizeDesignForBrief(markdown, limit = 1800) {
  return clipTextLocal(String(markdown || "").trim(), limit);
}

function ensureDesignDirectory(artifactPath) {
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
}

module.exports = {
  buildDesignArtifactPath,
  ensureDesignDirectory,
  parseAskOrDraft,
  summarizeDesignForBrief,
  slugifyDesignTopic,
};
