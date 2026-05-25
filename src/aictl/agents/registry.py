from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .command import resolve_command
from .generic_cli import GenericCliAdapter


@dataclass
class AgentInfo:
    name: str
    command: str
    capabilities: list[str]
    write_access: bool
    available: bool
    timeout_sec: int


class AgentRegistry:
    def __init__(self, config: dict[str, Any]):
        self.config = config
        self.agent_configs = config.get("agents", {})

    def infos(self) -> list[AgentInfo]:
        items: list[AgentInfo] = []
        for name, cfg in self.agent_configs.items():
            command = str(cfg.get("command", name))
            items.append(
                AgentInfo(
                    name=name,
                    command=command,
                    capabilities=list(cfg.get("capabilities", [])),
                    write_access=bool(cfg.get("write_access", False)),
                    available=resolve_command(command) is not None,
                    timeout_sec=int(cfg.get("timeout_sec", 1800)),
                )
            )
        return items

    def select(self, capability: str, write_access: bool | None = None) -> tuple[str, GenericCliAdapter, dict[str, Any]]:
        for name, cfg in self.agent_configs.items():
            if capability not in cfg.get("capabilities", []):
                continue
            if write_access is not None and bool(cfg.get("write_access", False)) != write_access:
                continue
            return name, GenericCliAdapter(name, cfg), cfg
        raise ValueError(f"No agent configured for capability: {capability}")
