from __future__ import annotations

from aictl.agents.registry import AgentRegistry
from aictl.config import ProjectPaths
from aictl.task_store import Task, TaskStore
from aictl.workflows.common import invoke_agent


def run_implement(paths: ProjectPaths, store: TaskStore, registry: AgentRegistry, task: Task) -> None:
    state = store.read_state(task)
    request = state["request"]
    final_plan_file = task.file("final-plan.md")
    if not final_plan_file.exists():
        raise RuntimeError("No final-plan.md found. Run `aictl plan` first.")
    final_plan = final_plan_file.read_text(encoding="utf-8")
    context = task.file("context.md").read_text(encoding="utf-8") if task.file("context.md").exists() else ""

    invoke_agent(
        registry=registry,
        store=store,
        task=task,
        capability="implement",
        role="implementer",
        prompt_template="implementer.md",
        output_name="implementation.md",
        cwd=paths.root,
        allow_write=True,
        values={"request": request, "context": context, "final_plan": final_plan},
    )
    store.set_stage(task, "implemented", "implemented")
