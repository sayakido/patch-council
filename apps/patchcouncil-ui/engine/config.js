const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");

const PROJECT_DIR = ".project-ai";
const CONFIG_FILE = "config.yaml";

const DEFAULT_CONFIG = {
  agents: {
    codex: {
      type: "cli",
      command: "codex",
      args: ["exec", "--json", "--sandbox", "read-only", "--ephemeral", "-"],
      input_mode: "stdin",
      capabilities: ["plan", "synthesize", "review", "judge"],
      write_access: false,
      timeout_sec: 1800,
    },
    claude: {
      type: "cli",
      command: "claude",
      args: ["-p"],
      input_mode: "argument",
      capabilities: ["challenge", "implement", "fix"],
      write_access: false,
      timeout_sec: 1800,
    },
  },
  council: {
    max_turns: 3,
    min_distinct_agents: 2,
    max_context_chars: 2500,
    max_transcript_chars: 2500,
    max_message_chars: 800,
  },
  context: {
    max_diff_chars: 40000,
    include: [
      "README.md",
      "package.json",
      "pyproject.toml",
      ".project-ai/memory.md",
      ".project-ai/decisions.md",
    ],
    exclude: [".git", "node_modules", "dist", "build", "target", ".venv"],
  },
};

function findProjectRoot(start = null) {
  let current = (start ? path.resolve(start) : process.cwd());
  for (;;) {
    try {
      if (fs.statSync(path.join(current, ".git")).isDirectory()) return current;
    } catch {}
    try {
      if (fs.statSync(path.join(current, PROJECT_DIR)).isDirectory()) return current;
    } catch {}
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}

function deepMerge(base, override) {
  const merged = { ...base };
  for (const key of Object.keys(override)) {
    if (typeof override[key] === "object" && override[key] !== null && !Array.isArray(override[key])
        && typeof merged[key] === "object" && merged[key] !== null && !Array.isArray(merged[key])) {
      merged[key] = deepMerge(merged[key], override[key]);
    } else {
      merged[key] = override[key];
    }
  }
  return merged;
}

function loadConfig(projectRoot = null) {
  const root = projectRoot || findProjectRoot();
  const aiDir = path.join(root, PROJECT_DIR);
  const configFile = path.join(aiDir, CONFIG_FILE);

  let fileConfig = {};
  try {
    const raw = fs.readFileSync(configFile, "utf8");
    fileConfig = yaml.load(raw) || {};
  } catch {
    // missing or unreadable config — use defaults
  }

  return deepMerge(DEFAULT_CONFIG, fileConfig);
}

function ensureProject(root) {
  const aiDir = path.join(root, PROJECT_DIR);
  fs.mkdirSync(aiDir, { recursive: true });
  fs.mkdirSync(path.join(aiDir, "tasks"), { recursive: true });
  fs.mkdirSync(path.join(aiDir, "sessions"), { recursive: true });

  const configFile = path.join(aiDir, CONFIG_FILE);
  if (!fs.existsSync(configFile)) {
    fs.writeFileSync(configFile, yaml.dump(DEFAULT_CONFIG, { sortKeys: false }), "utf8");
  }

  const memoryFile = path.join(aiDir, "memory.md");
  if (!fs.existsSync(memoryFile)) {
    fs.writeFileSync(memoryFile, "# Memory\n\n", "utf8");
  }

  const decisionsFile = path.join(aiDir, "decisions.md");
  if (!fs.existsSync(decisionsFile)) {
    fs.writeFileSync(decisionsFile, "# Decisions\n\n", "utf8");
  }
}

module.exports = {
  loadConfig,
  findProjectRoot,
  deepMerge,
  DEFAULT_CONFIG,
  ensureProject,
  PROJECT_DIR,
  CONFIG_FILE,
};
