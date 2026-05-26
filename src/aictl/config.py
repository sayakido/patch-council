from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml


PROJECT_DIR = ".project-ai"
CONFIG_FILE = "config.yaml"


DEFAULT_CONFIG: dict[str, Any] = {
    "agents": {
        "codex": {
            "type": "cli",
            "command": "codex",
            "args": ["exec", "--sandbox", "read-only", "-"],
            "input_mode": "stdin",
            "capabilities": ["plan", "synthesize", "review", "judge"],
            "write_access": False,
            "timeout_sec": 1800,
        },
        "opencode": {
            "type": "cli",
            "command": "opencode",
            "args": ["run"],
            "input_mode": "argument",
            "capabilities": ["challenge", "implement", "fix"],
            "write_access": True,
            "timeout_sec": 1800,
        },
    },
    "workflow": {
        "default": "codex_plan_opencode_do",
        "max_fix_rounds": 2,
    },
    "council": {
        "max_turns": 3,
        "min_distinct_agents": 2,
        "max_context_chars": 2500,
        "max_transcript_chars": 2500,
        "max_message_chars": 800,
    },
    "context": {
        "max_files": 20,
        "max_diff_chars": 40000,
        "include": [
            "README.md",
            "package.json",
            "pyproject.toml",
            "Cargo.toml",
            "go.mod",
            ".project-ai/memory.md",
            ".project-ai/decisions.md",
        ],
        "exclude": [".git", "node_modules", "dist", "build", "target", ".venv"],
    },
}


@dataclass(frozen=True)
class ProjectPaths:
    root: Path

    @property
    def ai_dir(self) -> Path:
        return self.root / PROJECT_DIR

    @property
    def config_file(self) -> Path:
        return self.ai_dir / CONFIG_FILE

    @property
    def memory_file(self) -> Path:
        return self.ai_dir / "memory.md"

    @property
    def decisions_file(self) -> Path:
        return self.ai_dir / "decisions.md"

    @property
    def tasks_dir(self) -> Path:
        return self.ai_dir / "tasks"

    @property
    def sessions_dir(self) -> Path:
        return self.ai_dir / "sessions"


def find_project_root(start: Path | None = None) -> Path:
    current = (start or Path.cwd()).resolve()
    for path in [current, *current.parents]:
        if (path / ".git").exists() or (path / PROJECT_DIR).exists():
            return path
    return current


def ensure_project(paths: ProjectPaths) -> None:
    paths.ai_dir.mkdir(exist_ok=True)
    paths.tasks_dir.mkdir(exist_ok=True)
    paths.sessions_dir.mkdir(exist_ok=True)
    if not paths.config_file.exists():
        paths.config_file.write_text(yaml.safe_dump(DEFAULT_CONFIG, sort_keys=False), encoding="utf-8")
    if not paths.memory_file.exists():
        paths.memory_file.write_text("# Memory\n\n", encoding="utf-8")
    if not paths.decisions_file.exists():
        paths.decisions_file.write_text("# Decisions\n\n", encoding="utf-8")


def load_config(paths: ProjectPaths) -> dict[str, Any]:
    if not paths.config_file.exists():
        ensure_project(paths)
    data = yaml.safe_load(paths.config_file.read_text(encoding="utf-8")) or {}
    return _deep_merge(DEFAULT_CONFIG, data)


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    merged = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged
