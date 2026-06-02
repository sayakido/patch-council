"use strict";

const fs = require("fs");
const path = require("path");
const { slugifyDesignTopic } = require("./design-council");

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function buildWorkplanArtifactPath(projectRoot, topic) {
  const slug = slugifyDesignTopic(topic) || "workplan";
  return path.join(projectRoot, "docs", "workplans", `${todayIso()}-${slug}.md`);
}

function ensureWorkplanDirectory(artifactPath) {
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
}

function assertWorkplanWritable(artifactPath, options = {}) {
  if (!fs.existsSync(artifactPath)) return { ok: true };
  if (options.allowExisting) return { ok: true };
  return { ok: false, error: "workplan artifact already exists with local content" };
}

function scanWorkplanContract(markdown) {
  const text = String(markdown || "");
  const lower = text.toLowerCase();
  const forbidden = ["t" + "bd", "to" + "do", "implement " + "later", "add appropriate " + "error handling", "write tests " + "for this"];
  if (!/^# .+ Implementation Plan/m.test(text)) return { ok: false, error: "missing implementation plan title" };
  if (!text.includes("Source Design")) return { ok: false, error: "missing Source Design" };
  if (!text.includes("Source Design Commit")) return { ok: false, error: "missing Source Design Commit" };
  if (!text.includes("## File Structure")) return { ok: false, error: "missing File Structure" };
  if (!/\n- \[ \]/.test(text)) return { ok: false, error: "missing checkbox steps" };
  if (!/Run: `[^`]+`/.test(text) && !/Manual verification:/i.test(text)) return { ok: false, error: "missing concrete verification" };
  if (!text.includes("## Self-Review")) return { ok: false, error: "missing Self-Review" };
  if (forbidden.some((item) => lower.includes(item))) return { ok: false, error: "contains placeholder wording" };
  if (lower.includes("execute code now")) return { ok: false, error: "plan attempts to execute code" };
  return { ok: true };
}

async function runGitCommand(projectRoot, args, runGit) {
  if (runGit) return await runGit(args);
  const { spawn } = require("child_process");
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd: projectRoot, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => resolve({ ok: false, text: "", error: err.message }));
    child.on("close", (code) => resolve({ ok: code === 0, text: stdout, error: stderr || `git exited ${code}` }));
  });
}

async function commitWorkplanArtifact(options) {
  const { artifactPath, projectRoot, message, runGit } = options;
  const add = await runGitCommand(projectRoot, ["add", artifactPath], runGit);
  if (!add.ok) return { ok: false, stage: "git_add", error: add.error };
  const commit = await runGitCommand(projectRoot, ["commit", "-m", message, "--", artifactPath], runGit);
  if (!commit.ok) {
    // Allow empty commits — the file may already be committed with the same content
    const combined = (commit.error || "") + " " + (commit.text || "");
    if (!/nothing\s+to\s+commit|no\s+changes\s+added\s+to\s+commit/i.test(combined)) {
      return { ok: false, stage: "git_commit", error: commit.error || commit.text };
    }
  }
  const rev = await runGitCommand(projectRoot, ["rev-parse", "--short", "HEAD"], runGit);
  if (!rev.ok) return { ok: false, stage: "rev_parse", error: rev.error };
  return { ok: true, commit: rev.text.trim() };
}

module.exports = {
  buildWorkplanArtifactPath,
  ensureWorkplanDirectory,
  assertWorkplanWritable,
  scanWorkplanContract,
  commitWorkplanArtifact,
};
