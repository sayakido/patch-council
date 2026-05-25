from __future__ import annotations

import shutil
from pathlib import Path
import typer
from rich.console import Console
from rich.table import Table

from . import __version__
from .agents.registry import AgentRegistry
from .config import ProjectPaths, ensure_project, find_project_root, load_config
from .task_store import TaskStore
from .workflows.auto import run_auto
from .workflows.common import append_memory
from .workflows.council import run_council
from .workflows.implement import run_implement
from .workflows.plan import run_plan
from .workflows.review import run_review


app = typer.Typer(help="Local AI CLI orchestrator.")
console = Console()


def bootstrap() -> tuple[ProjectPaths, dict, TaskStore, AgentRegistry]:
    root = find_project_root()
    paths = ProjectPaths(root=root)
    ensure_project(paths)
    config = load_config(paths)
    store = TaskStore(paths)
    registry = AgentRegistry(config)
    return paths, config, store, registry


def version_callback(value: bool) -> None:
    if value:
        console.print(f"aictl {__version__}")
        raise typer.Exit()


@app.callback()
def main(
    version: bool = typer.Option(
        False,
        "--version",
        help="Show version and exit.",
        callback=version_callback,
        is_eager=True,
    ),
) -> None:
    _ = version


@app.command()
def init() -> None:
    """Initialize .project-ai in the current project."""
    root = find_project_root(Path.cwd())
    paths = ProjectPaths(root=root)
    ensure_project(paths)
    console.print(f"Initialized [bold]{paths.ai_dir}[/bold]")


@app.command()
def doctor() -> None:
    """Check local dependencies and project configuration."""
    paths, _config, _store, registry = bootstrap()
    table = Table(title="aictl doctor")
    table.add_column("Check")
    table.add_column("Status")
    table.add_column("Detail")
    table.add_row("Project", "OK", str(paths.root))
    table.add_row("Config", "OK" if paths.config_file.exists() else "Missing", str(paths.config_file))
    table.add_row("Git", "OK" if shutil.which("git") else "Missing", "git")
    table.add_row("ripgrep", "OK" if shutil.which("rg") else "Optional missing", "rg")
    for info in registry.infos():
        table.add_row(f"Agent: {info.name}", "OK" if info.available else "Missing", info.command)
    console.print(table)


@app.command("agents")
def list_agents() -> None:
    """List configured agents and capabilities."""
    _paths, _config, _store, registry = bootstrap()
    table = Table(title="Agents")
    table.add_column("Name")
    table.add_column("Available")
    table.add_column("Write")
    table.add_column("Capabilities")
    for info in registry.infos():
        table.add_row(
            info.name,
            "yes" if info.available else "no",
            "yes" if info.write_access else "no",
            ", ".join(info.capabilities),
        )
    console.print(table)


@app.command()
def council(topic: str) -> None:
    """Run a read-only multi-agent council discussion."""
    paths, config, _store, registry = bootstrap()
    session = run_council(paths, config, registry, topic)
    console.print(f"Council transcript written to [bold]{session.transcript_md}[/bold]")


@app.command()
def plan(request: str) -> None:
    """Create a challenged final plan without implementing it."""
    paths, config, store, registry = bootstrap()
    task = store.create(request)
    run_plan(paths, config, store, registry, task)
    console.print(f"Plan written to [bold]{task.file('final-plan.md')}[/bold]")


@app.command("do")
def do_task() -> None:
    """Implement the latest planned task."""
    paths, _config, store, registry = bootstrap()
    task = require_latest(store)
    run_implement(paths, store, registry, task)
    console.print(f"Implementation log written to [bold]{task.file('implementation.md')}[/bold]")


@app.command()
def review() -> None:
    """Review the current git diff for the latest task."""
    paths, _config, store, registry = bootstrap()
    task = require_latest(store)
    run_review(paths, store, registry, task)
    console.print(f"Review written to [bold]{task.file('review.md')}[/bold]")


@app.command()
def auto(request: str) -> None:
    """Run the full plan, implement, review, optional fix, and memory workflow."""
    paths, config, store, registry = bootstrap()
    task = store.create(request)
    run_auto(paths, config, store, registry, task)
    console.print(f"Task completed at [bold]{task.path}[/bold]")


@app.command("continue")
def continue_task() -> None:
    """Continue the latest task from its current stage."""
    paths, config, store, registry = bootstrap()
    task = require_latest(store)
    state = store.read_state(task)
    stage = state.get("stage", "created")
    if stage in {"created", "context_collected", "draft_planned", "challenged"}:
        run_plan(paths, config, store, registry, task)
    elif stage == "final_planned":
        run_implement(paths, store, registry, task)
    elif stage == "implemented":
        run_review(paths, store, registry, task)
    elif stage in {"reviewed", "fixed"}:
        append_memory(paths, task, state["request"])
        store.set_stage(task, "done", "done")
    else:
        console.print(f"Nothing to continue for stage [bold]{stage}[/bold].")
        return
    console.print(f"Continued task [bold]{task.id}[/bold]")


def require_latest(store: TaskStore):
    task = store.latest()
    if task is None:
        console.print("No task found. Run `aictl plan \"...\"` or `aictl auto \"...\"` first.")
        raise typer.Exit(code=1)
    return task
