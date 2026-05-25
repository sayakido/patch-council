from __future__ import annotations

import os
import queue
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

from rich.console import Console

from .base import AgentAdapter, AgentRequest, AgentResult
from .command import resolve_command


console = Console()


class GenericCliAdapter(AgentAdapter):
    def __init__(self, name: str, config: dict[str, Any]):
        self.name = name
        self.config = config
        self.command = str(config["command"])
        self.args = [str(arg) for arg in config.get("args", [])]
        self.input_mode = str(config.get("input_mode", "stdin"))
        self.message = str(config.get("message", "Follow the attached prompt file exactly."))
        self.env = {str(key): str(value) for key, value in config.get("env", {}).items()}
        self.progress_interval_sec = int(config.get("progress_interval_sec", 10))

    def run(self, request: AgentRequest) -> AgentResult:
        resolved = resolve_command(self.command) or self.command
        prompt_file = str(request.input_files[0]) if request.input_files else ""
        format_values = {"cwd": str(request.cwd), "prompt_file": prompt_file, "message": self.message}
        command = [resolved, *(arg.format(**format_values) for arg in self.args)]
        stdin = request.prompt
        if self.input_mode == "argument":
            command.append(request.prompt)
            stdin = None
        elif self.input_mode == "file":
            stdin = None
        elif self.input_mode != "stdin":
            return AgentResult(
                agent=self.name,
                role=request.role,
                exit_code=2,
                stdout="",
                stderr=f"Unsupported input_mode for {self.name}: {self.input_mode}",
                changed_files=[],
            )
        env = os.environ.copy()
        for key, value in self.env.items():
            env[key] = value.format(cwd=str(request.cwd))
        try:
            stdout, stderr, exit_code = self._run_with_progress(command, stdin, request, env)
        except FileNotFoundError as exc:
            stdout = ""
            stderr = f"{type(exc).__name__}: {exc}"
            exit_code = 127

        if request.output_file is not None:
            request.output_file.write_text(stdout, encoding="utf-8")

        return AgentResult(
            agent=self.name,
            role=request.role,
            exit_code=exit_code,
            stdout=stdout,
            stderr=stderr,
            changed_files=[],
        )

    def _run_with_progress(
        self,
        command: list[str],
        stdin: str | None,
        request: AgentRequest,
        env: dict[str, str],
    ) -> tuple[str, str, int]:
        process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE if stdin is not None else None,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=request.cwd,
            env=env,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        if stdin is not None and process.stdin is not None:
            process.stdin.write(stdin)
            process.stdin.close()

        events: queue.Queue[tuple[str, str | None]] = queue.Queue()
        stdout_parts: list[str] = []
        stderr_parts: list[str] = []
        last_stderr = ""

        stdout_thread = threading.Thread(target=_read_stream, args=("stdout", process.stdout, events), daemon=True)
        stderr_thread = threading.Thread(target=_read_stream, args=("stderr", process.stderr, events), daemon=True)
        stdout_thread.start()
        stderr_thread.start()

        start = time.monotonic()
        next_progress = start + self.progress_interval_sec
        timed_out = False

        while process.poll() is None:
            try:
                stream_name, line = events.get(timeout=0.2)
            except queue.Empty:
                stream_name, line = "", None

            if line is not None:
                if stream_name == "stdout":
                    stdout_parts.append(line)
                else:
                    stderr_parts.append(line)
                    stripped = line.strip()
                    if stripped:
                        last_stderr = stripped

            now = time.monotonic()
            elapsed = int(now - start)
            if elapsed >= request.timeout_sec:
                timed_out = True
                process.kill()
                break
            if now >= next_progress:
                detail = f" last stderr: {last_stderr}" if last_stderr else ""
                console.print(f"[dim]{self.name} still running as {request.role} ({elapsed}s elapsed).{detail}[/dim]")
                next_progress = now + self.progress_interval_sec

        stdout_thread.join(timeout=1)
        stderr_thread.join(timeout=1)
        while True:
            try:
                stream_name, line = events.get_nowait()
            except queue.Empty:
                break
            if line is None:
                continue
            if stream_name == "stdout":
                stdout_parts.append(line)
            else:
                stderr_parts.append(line)

        stdout = "".join(stdout_parts)
        stderr = "".join(stderr_parts)
        if timed_out:
            stderr = stderr + f"\nTimeoutExpired after {request.timeout_sec}s"
            return stdout, stderr, 124
        return stdout, stderr, process.returncode or 0


def _read_stream(stream_name: str, stream, events: queue.Queue[tuple[str, str | None]]) -> None:
    if stream is None:
        return
    for line in stream:
        events.put((stream_name, line))
