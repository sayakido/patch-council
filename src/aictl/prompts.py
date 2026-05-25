from __future__ import annotations

from pathlib import Path
from typing import Any

from jinja2 import Environment, FileSystemLoader, StrictUndefined


PROMPT_DIR = Path(__file__).parent / "prompts"


def render_prompt(template_name: str, **values: Any) -> str:
    env = Environment(
        loader=FileSystemLoader(PROMPT_DIR),
        autoescape=False,
        undefined=StrictUndefined,
        trim_blocks=True,
        lstrip_blocks=True,
    )
    template = env.get_template(template_name)
    return template.render(**values)
