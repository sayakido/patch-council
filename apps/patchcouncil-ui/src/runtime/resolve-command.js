const fs = require("node:fs");
const path = require("node:path");

const WINDOWS_EXTENSIONS = [".cmd", ".exe", ".bat", ".ps1", ""];

function resolveCommand(command, options = {}) {
  const cwd = options.cwd || process.cwd();
  const env = options.env || process.env;
  const raw = normalizeString(command);
  if (!raw) {
    return null;
  }

  if (hasPathSeparator(raw)) {
    const direct = path.resolve(cwd, raw);
    return fileExists(direct) ? direct : null;
  }

  const pathValue = env.PATH || env.Path || env.path || "";
  const dirs = pathValue.split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32" ? WINDOWS_EXTENSIONS : [""];

  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, raw.endsWith(ext) ? raw : raw + ext);
      if (fileExists(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function hasPathSeparator(value) {
  return value.includes("/") || value.includes("\\");
}

function fileExists(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { resolveCommand };
