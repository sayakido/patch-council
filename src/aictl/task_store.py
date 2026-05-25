from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from .config import ProjectPaths


def now_local() -> datetime:
    return datetime.now().astimezone()


def slugify(value: str, max_len: int = 48) -> str:
    slug = re.sub(r"[^a-zA-Z0-9\u4e00-\u9fff]+", "-", value.strip()).strip("-").lower()
    return (slug or "task")[:max_len].strip("-")


@dataclass
class Task:
    id: str
    path: Path
    state_file: Path

    def file(self, name: str) -> Path:
        return self.path / name


class TaskStore:
    def __init__(self, paths: ProjectPaths):
        self.paths = paths
        self.paths.tasks_dir.mkdir(parents=True, exist_ok=True)

    def create(self, request: str) -> Task:
        stamp = now_local().strftime("%Y-%m-%d-%H%M")
        task_id = f"{stamp}-{slugify(request)}"
        task_path = self.paths.tasks_dir / task_id
        suffix = 2
        while task_path.exists():
            task_path = self.paths.tasks_dir / f"{task_id}-{suffix}"
            suffix += 1
        task_path.mkdir(parents=True)
        task = Task(id=task_path.name, path=task_path, state_file=task_path / "state.json")
        task.file("task.md").write_text(f"# Task\n\n{request}\n", encoding="utf-8")
        self.write_state(
            task,
            {
                "id": task.id,
                "request": request,
                "status": "created",
                "stage": "created",
                "fix_round": 0,
                "created_at": now_local().isoformat(),
                "updated_at": now_local().isoformat(),
            },
        )
        task.file("turns.jsonl").write_text("", encoding="utf-8")
        return task

    def latest(self) -> Task | None:
        candidates = [p for p in self.paths.tasks_dir.iterdir() if p.is_dir()]
        if not candidates:
            return None
        path = sorted(candidates, key=lambda item: item.stat().st_mtime, reverse=True)[0]
        return Task(id=path.name, path=path, state_file=path / "state.json")

    def read_state(self, task: Task) -> dict:
        if not task.state_file.exists():
            return {}
        return json.loads(task.state_file.read_text(encoding="utf-8"))

    def write_state(self, task: Task, state: dict) -> None:
        state["updated_at"] = now_local().isoformat()
        task.state_file.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")

    def set_stage(self, task: Task, stage: str, status: str | None = None) -> None:
        state = self.read_state(task)
        state["stage"] = stage
        if status is not None:
            state["status"] = status
        self.write_state(task, state)

    def append_turn(self, task: Task, record: dict) -> None:
        turns_file = task.file("turns.jsonl")
        turn_no = sum(1 for _ in turns_file.open("r", encoding="utf-8")) + 1 if turns_file.exists() else 1
        record = {"turn": turn_no, **record}
        with turns_file.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
