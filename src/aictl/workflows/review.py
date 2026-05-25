from __future__ import annotations

from aictl.agents.registry import AgentRegistry
from aictl.config import ProjectPaths
from aictl.task_store import Task, TaskStore
from aictl.workflows.common import current_diff, invoke_agent


def run_review(paths: ProjectPaths, store: TaskStore, registry: AgentRegistry, task: Task) -> None:
    state = store.read_state(task)
    request = state["request"]
    final_plan = task.file("final-plan.md").read_text(encoding="utf-8") if task.file("final-plan.md").exists() else ""
    diff = current_diff(paths.root)
    invoke_agent(
        registry=registry,
        store=store,
        task=task,
        capability="review",
        role="reviewer",
        prompt_template="reviewer.md",
        output_name="review.md",
        cwd=paths.root,
        allow_write=False,
        values={"request": request, "final_plan": final_plan, "diff": diff},
    )
    store.set_stage(task, "reviewed", "reviewed")


def run_fix(paths: ProjectPaths, store: TaskStore, registry: AgentRegistry, task: Task) -> None:
    state = store.read_state(task)
    request = state["request"]
    review = task.file("review.md").read_text(encoding="utf-8") if task.file("review.md").exists() else ""
    diff = current_diff(paths.root)
    invoke_agent(
        registry=registry,
        store=store,
        task=task,
        capability="fix",
        role="fixer",
        prompt_template="fixer.md",
        output_name=f"fix-{state.get('fix_round', 0) + 1}.md",
        cwd=paths.root,
        allow_write=True,
        values={"request": request, "review": review, "diff": diff},
    )
    state["fix_round"] = int(state.get("fix_round", 0)) + 1
    store.write_state(task, state)
    store.set_stage(task, "fixed", "fixed")
