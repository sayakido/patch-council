from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class AgentRequest:
    role: str
    prompt: str
    cwd: Path
    allow_write: bool
    timeout_sec: int
    input_files: list[Path] = field(default_factory=list)
    output_file: Path | None = None


@dataclass
class AgentResult:
    agent: str
    role: str
    exit_code: int
    stdout: str
    stderr: str
    changed_files: list[Path] = field(default_factory=list)


class AgentAdapter:
    name: str

    def run(self, request: AgentRequest) -> AgentResult:
        raise NotImplementedError
