from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from rich.console import Console

from aictl.agents.base import AgentRequest
from aictl.agents.registry import AgentRegistry
from aictl.config import ProjectPaths
from aictl.context import collect_context
from aictl.prompts import render_prompt
from aictl.task_store import now_local, slugify


console = Console()


@dataclass
class CouncilSession:
    id: str
    path: Path
    state_file: Path
    transcript_md: Path
    transcript_jsonl: Path


@dataclass
class CouncilDecision:
    action: str
    agent: str | None
    role: str
    reason: str
    raw: str


def run_council(paths: ProjectPaths, config: dict, registry: AgentRegistry, topic: str) -> CouncilSession:
    session = create_session(paths, topic)
    context = collect_context(paths.root, config, topic)
    max_turns = int(config.get("council", {}).get("max_turns", 3))
    agent_profiles = format_agent_profiles(config)

    append_message(session, "user", "topic", topic)
    write_state(session, {"id": session.id, "status": "running", "stage": "started", "topic": topic})

    try:
        decision = route_first_turn(registry, paths.root, topic, context, agent_profiles, read_transcript(session))
        append_message(session, "coordinator", "route", decision.raw)

        turn_count = 0
        while decision.action == "continue" and turn_count < max_turns:
            agent_name = resolve_agent_name(registry, decision.agent)
            response = invoke_named_agent(
                registry=registry,
                agent_name=agent_name,
                role="council-agent",
                template="council_agent_turn.md",
                cwd=paths.root,
                values={
                    "agent_name": agent_name,
                    "turn_role": decision.role,
                    "topic": topic,
                    "context": context,
                    "transcript": read_transcript(session),
                },
            )
            append_message(session, agent_name, "turn", response)
            turn_count += 1
            write_state(
                session,
                {
                    "id": session.id,
                    "status": "running",
                    "stage": "discussing",
                    "topic": topic,
                    "turn_count": turn_count,
                },
            )

            decision = decide_next_turn(
                registry,
                paths.root,
                topic,
                context,
                agent_profiles,
                read_transcript(session),
                max_turns,
                turn_count,
            )
            append_message(session, "coordinator", "decision", decision.raw)

        final = invoke_coordinator(
            registry=registry,
            role="council-finalize",
            template="council_finalize.md",
            cwd=paths.root,
            values={"topic": topic, "context": context, "transcript": read_transcript(session)},
        )
        append_message(session, "coordinator", "final", final)
        write_state(
            session,
            {
                "id": session.id,
                "status": "done",
                "stage": "finalized",
                "topic": topic,
                "turn_count": turn_count,
            },
        )
    except Exception as exc:
        append_message(session, "system", "error", f"{type(exc).__name__}: {exc}")
        write_state(
            session,
            {
                "id": session.id,
                "status": "failed",
                "stage": "failed",
                "topic": topic,
                "error": f"{type(exc).__name__}: {exc}",
            },
        )
        raise
    return session


def route_first_turn(
    registry: AgentRegistry,
    cwd: Path,
    topic: str,
    context: str,
    agent_profiles: str,
    transcript: str,
) -> CouncilDecision:
    raw = invoke_coordinator(
        registry=registry,
        role="council-route",
        template="council_route.md",
        cwd=cwd,
        values={"topic": topic, "context": context, "agent_profiles": agent_profiles, "transcript": transcript},
    )
    return parse_route_decision(raw)


def decide_next_turn(
    registry: AgentRegistry,
    cwd: Path,
    topic: str,
    context: str,
    agent_profiles: str,
    transcript: str,
    max_turns: int,
    turn_count: int,
) -> CouncilDecision:
    raw = invoke_coordinator(
        registry=registry,
        role="council-decide",
        template="council_decide.md",
        cwd=cwd,
        values={
            "topic": topic,
            "context": context,
            "agent_profiles": agent_profiles,
            "transcript": transcript,
            "max_turns": max_turns,
            "turn_count": turn_count,
        },
    )
    return parse_continue_decision(raw)


def invoke_coordinator(
    *,
    registry: AgentRegistry,
    role: str,
    template: str,
    cwd: Path,
    values: dict,
) -> str:
    name, adapter, cfg = registry.select("synthesize", write_access=False)
    prompt = render_prompt(template, **values)
    console.print(f"[bold]{name}[/bold] running as {role}...")
    result = adapter.run(
        AgentRequest(
            role=role,
            prompt=prompt,
            cwd=cwd,
            allow_write=False,
            timeout_sec=int(cfg.get("timeout_sec", 1800)),
        )
    )
    if result.exit_code != 0:
        raise RuntimeError(f"{name} failed as {role}: {result.stderr.strip()}")
    return result.stdout.strip()


def invoke_named_agent(
    *,
    registry: AgentRegistry,
    agent_name: str,
    role: str,
    template: str,
    cwd: Path,
    values: dict,
) -> str:
    cfg = registry.agent_configs[agent_name]
    adapter = registry.select(next(iter(cfg.get("capabilities", []))))[1]
    adapter = type(adapter)(agent_name, cfg)
    prompt = render_prompt(template, **values)
    console.print(f"[bold]{agent_name}[/bold] running as {role}...")
    result = adapter.run(
        AgentRequest(
            role=role,
            prompt=prompt,
            cwd=cwd,
            allow_write=False,
            timeout_sec=int(cfg.get("timeout_sec", 1800)),
        )
    )
    if result.exit_code != 0:
        raise RuntimeError(f"{agent_name} failed as {role}: {result.stderr.strip()}")
    return result.stdout.strip()


def create_session(paths: ProjectPaths, topic: str) -> CouncilSession:
    sessions_dir = paths.ai_dir / "sessions"
    sessions_dir.mkdir(parents=True, exist_ok=True)
    stamp = now_local().strftime("%Y-%m-%d-%H%M")
    session_id = f"{stamp}-{slugify(topic)}"
    session_path = sessions_dir / session_id
    suffix = 2
    while session_path.exists():
        session_path = sessions_dir / f"{session_id}-{suffix}"
        suffix += 1
    session_path.mkdir(parents=True)
    session = CouncilSession(
        id=session_path.name,
        path=session_path,
        state_file=session_path / "state.json",
        transcript_md=session_path / "transcript.md",
        transcript_jsonl=session_path / "transcript.jsonl",
    )
    session.transcript_md.write_text(f"# Council Session\n\nSession: `{session.id}`\n\n", encoding="utf-8")
    session.transcript_jsonl.write_text("", encoding="utf-8")
    return session


def append_message(session: CouncilSession, speaker: str, role: str, content: str) -> None:
    record = {
        "speaker": speaker,
        "role": role,
        "content": content,
        "created_at": now_local().isoformat(),
    }
    with session.transcript_jsonl.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    with session.transcript_md.open("a", encoding="utf-8") as handle:
        handle.write(f"## {speaker} ({role})\n\n{content.strip()}\n\n")


def write_state(session: CouncilSession, state: dict) -> None:
    state["updated_at"] = now_local().isoformat()
    session.state_file.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def read_transcript(session: CouncilSession) -> str:
    text = session.transcript_md.read_text(encoding="utf-8")
    return text[-20000:]


def format_agent_profiles(config: dict[str, Any]) -> str:
    lines: list[str] = []
    for name, cfg in config.get("agents", {}).items():
        capabilities = ", ".join(cfg.get("capabilities", []))
        write_access = "yes" if cfg.get("write_access", False) else "no"
        lines.append(f"- {name}: capabilities={capabilities}; write_access={write_access}")
    return "\n".join(lines)


def parse_route_decision(raw: str) -> CouncilDecision:
    agent = clean_value(section(raw, "Decision"))
    role = clean_value(section(raw, "Role")) or "Respond to the council topic."
    reason = clean_value(section(raw, "Reason"))
    return CouncilDecision(action="continue", agent=agent, role=role, reason=reason, raw=raw)


def parse_continue_decision(raw: str) -> CouncilDecision:
    decision = clean_value(section(raw, "Decision")).lower()
    if "finalize" in decision:
        return CouncilDecision(action="finalize", agent=None, role="", reason=clean_value(section(raw, "Reason")), raw=raw)
    agent = clean_value(section(raw, "Next agent"))
    role = clean_value(section(raw, "Role")) or "Continue the council discussion."
    reason = clean_value(section(raw, "Reason"))
    return CouncilDecision(action="continue", agent=agent, role=role, reason=reason, raw=raw)


def resolve_agent_name(registry: AgentRegistry, requested: str | None) -> str:
    if requested and requested in registry.agent_configs:
        return requested
    if requested:
        lowered = requested.lower()
        for name in registry.agent_configs:
            if name.lower() == lowered:
                return name
    for fallback in ("codex", "opencode"):
        if fallback in registry.agent_configs:
            return fallback
    return next(iter(registry.agent_configs))


def section(markdown: str, title: str) -> str:
    pattern = re.compile(rf"^##\s+{re.escape(title)}\s*$", re.IGNORECASE | re.MULTILINE)
    match = pattern.search(markdown)
    if not match:
        return ""
    next_match = re.search(r"^##\s+", markdown[match.end() :], re.MULTILINE)
    end = match.end() + next_match.start() if next_match else len(markdown)
    return markdown[match.end() : end].strip()


def clean_value(value: str) -> str:
    value = value.strip()
    value = re.sub(r"^[-*]\s+", "", value)
    value = value.strip("` \n\t")
    return value.splitlines()[0].strip() if value else ""
