from __future__ import annotations

from pathlib import Path

from rich.console import Console

from aictl.agents.base import AgentRequest, AgentResult
from aictl.agents.registry import AgentRegistry
from aictl.config import ProjectPaths
from aictl.context import collect_context, run_capture
from aictl.prompts import render_prompt
from aictl.task_store import Task, TaskStore


console = Console()


def write_context(task: Task, paths: ProjectPaths, config: dict, request: str) -> Path:
    context = collect_context(paths.root, config, request)
    output = task.file("context.md")
    output.write_text(context, encoding="utf-8")
    return output


def invoke_agent(
    *,
    registry: AgentRegistry,
    store: TaskStore,
    task: Task,
    capability: str,
    role: str,
    prompt_template: str,
    output_name: str,
    cwd: Path,
    allow_write: bool,
    values: dict,
) -> AgentResult:
    name, adapter, cfg = registry.select(capability, write_access=allow_write if allow_write else None)
    prompt = render_prompt(prompt_template, **values)
    prompt_file = task.file(f"{output_name}.prompt.md")
    output_file = task.file(output_name)
    prompt_file.write_text(prompt, encoding="utf-8")
    console.print(f"[bold]{name}[/bold] running as {role}...")
    result = adapter.run(
        AgentRequest(
            role=role,
            prompt=prompt,
            cwd=cwd,
            allow_write=allow_write,
            timeout_sec=int(cfg.get("timeout_sec", 1800)),
            input_files=[prompt_file],
            output_file=output_file,
        )
    )
    store.append_turn(
        task,
        {
            "agent": name,
            "role": role,
            "input_file": prompt_file.name,
            "output_file": output_file.name,
            "exit_code": result.exit_code,
        },
    )
    if result.exit_code != 0:
        error_file = task.file(f"{output_name}.stderr.txt")
        error_file.write_text(result.stderr, encoding="utf-8")
        raise RuntimeError(f"{name} failed as {role}; stderr written to {error_file}")
    return result


def current_diff(root: Path) -> str:
    return run_capture(["git", "diff"], root)


def append_memory(paths: ProjectPaths, task: Task, request: str) -> None:
    final_plan = _read_optional(task.file("final-plan.md"))
    review = _read_optional(task.file("review.md"))
    entry = (
        f"## {task.id}\n\n"
        f"Request: {request}\n\n"
        "### Final Plan\n"
        f"{_compact(final_plan)}\n\n"
        "### Review\n"
        f"{_compact(review)}\n\n"
    )
    with paths.memory_file.open("a", encoding="utf-8") as handle:
        handle.write(entry)


def _read_optional(path: Path) -> str:
    return path.read_text(encoding="utf-8") if path.exists() else ""


def _compact(text: str, limit: int = 3000) -> str:
    text = text.strip()
    return text if len(text) <= limit else text[:limit] + "\n\n[truncated]"
