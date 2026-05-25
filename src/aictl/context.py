from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Iterable


def run_capture(args: list[str], cwd: Path, timeout: int = 30) -> str:
    try:
        result = subprocess.run(args, cwd=cwd, text=True, capture_output=True, timeout=timeout)
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        return f"{type(exc).__name__}: {exc}"
    output = result.stdout.strip()
    if result.stderr.strip():
        output = f"{output}\n\n[stderr]\n{result.stderr.strip()}".strip()
    return output


def collect_context(root: Path, config: dict, request: str) -> str:
    context_cfg = config.get("context", {})
    max_diff_chars = int(context_cfg.get("max_diff_chars", 40000))
    include = [Path(item) for item in context_cfg.get("include", [])]
    exclude = set(context_cfg.get("exclude", []))

    git_status = run_capture(["git", "status", "--short"], root)
    diff_stat = run_capture(["git", "diff", "--stat"], root)
    diff = run_capture(["git", "diff"], root)
    if len(diff) > max_diff_chars:
        diff = diff[:max_diff_chars] + "\n\n[diff truncated]"

    files = list_project_files(root, exclude)
    included = read_included_files(root, include)

    return "\n\n".join(
        [
            "# Context",
            "## Request\n" + request,
            "## Git Status\n```text\n" + git_status + "\n```",
            "## Diff Stat\n```text\n" + diff_stat + "\n```",
            "## Existing Diff\n```diff\n" + diff + "\n```",
            "## Project Files\n```text\n" + "\n".join(files) + "\n```",
            "## Included Files\n" + included,
        ]
    )


def list_project_files(root: Path, exclude: set[str]) -> list[str]:
    if shutil.which("rg"):
        output = run_capture(["rg", "--files"], root)
        files = [line for line in output.splitlines() if line and not is_excluded(line, exclude)]
    else:
        files = []
        for path in root.rglob("*"):
            if path.is_file():
                rel = path.relative_to(root).as_posix()
                if not is_excluded(rel, exclude):
                    files.append(rel)
    return files[:300]


def is_excluded(relative_path: str, exclude: Iterable[str]) -> bool:
    parts = set(Path(relative_path).parts)
    return any(item in parts for item in exclude)


def read_included_files(root: Path, include: list[Path]) -> str:
    chunks: list[str] = []
    for rel in include:
        path = root / rel
        if not path.exists() or not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            text = "[binary or non-utf8 file omitted]"
        if len(text) > 12000:
            text = text[:12000] + "\n\n[file truncated]"
        chunks.append(f"### {rel.as_posix()}\n```text\n{text}\n```")
    return "\n\n".join(chunks) if chunks else "No configured include files found."
