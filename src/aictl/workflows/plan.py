from __future__ import annotations

from aictl.agents.registry import AgentRegistry
from aictl.config import ProjectPaths
from aictl.task_store import Task, TaskStore
from aictl.workflows.common import invoke_agent, write_context


def run_plan(paths: ProjectPaths, config: dict, store: TaskStore, registry: AgentRegistry, task: Task) -> None:
    state = store.read_state(task)
    request = state["request"]
    context_file = write_context(task, paths, config, request)
    store.set_stage(task, "context_collected", "running")
    context = context_file.read_text(encoding="utf-8")

    invoke_agent(
        registry=registry,
        store=store,
        task=task,
        capability="plan",
        role="planner",
        prompt_template="planner.md",
        output_name="draft-plan.md",
        cwd=paths.root,
        allow_write=False,
        values={"request": request, "context": context},
    )
    store.set_stage(task, "draft_planned")

    draft_plan = task.file("draft-plan.md").read_text(encoding="utf-8")
    invoke_agent(
        registry=registry,
        store=store,
        task=task,
        capability="challenge",
        role="challenger",
        prompt_template="challenger.md",
        output_name="challenge.md",
        cwd=paths.root,
        allow_write=True,
        values={"request": request, "context": context, "draft_plan": draft_plan},
    )
    store.set_stage(task, "challenged")

    challenge = task.file("challenge.md").read_text(encoding="utf-8")
    invoke_agent(
        registry=registry,
        store=store,
        task=task,
        capability="synthesize",
        role="synthesizer",
        prompt_template="synthesizer.md",
        output_name="final-plan.md",
        cwd=paths.root,
        allow_write=False,
        values={"request": request, "context": context, "draft_plan": draft_plan, "challenge": challenge},
    )
    store.set_stage(task, "final_planned", "planned")
