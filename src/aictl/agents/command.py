from __future__ import annotations

import os
import shutil
from pathlib import Path


def resolve_command(command: str) -> str | None:
    if os.name == "nt" and not Path(command).suffix:
        for suffix in (".cmd", ".exe", ".bat"):
            resolved = shutil.which(command + suffix)
            if resolved:
                return resolved
    return shutil.which(command)
