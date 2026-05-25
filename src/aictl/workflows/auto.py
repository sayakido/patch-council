from __future__ import annotations

from aictl.agents.registry import AgentRegistry
from aictl.config import ProjectPaths
from aictl.task_store import Task, TaskStore
from aictl.workflows.common import append_memory
from aictl.workflows.implement import run_implement
from aictl.workflows.plan import run_plan
from aictl.workflows.review import run_fix, run_review


def run_auto(paths: ProjectPaths, config: dict, store: TaskStore, registry: AgentRegistry, task: Task) -> None:
    run_plan(paths, config, store, registry, task)
    run_implement(paths, store, registry, task)
    run_review(paths, store, registry, task)
    review = task.file("review.md").read_text(encoding="utf-8")
    max_fix_rounds = int(config.get("workflow", {}).get("max_fix_rounds", 2))
    if should_fix(review) and max_fix_rounds > 0:
        run_fix(paths, store, registry, task)
        run_review(paths, store, registry, task)
    state = store.read_state(task)
    append_memory(paths, task, state["request"])
    store.set_stage(task, "done", "done")


def should_fix(review: str) -> bool:
    lowered = review.lower()
    if "approval" in lowered and ("approved" in lowered or "no findings" in lowered):
        return False
    return any(marker in lowered for marker in ["required fix", "must fix", "blocking", "p0", "p1"])
