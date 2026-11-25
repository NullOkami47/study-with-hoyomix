"""Bounded JSON readers for untrusted public metadata and manual agent output."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .discovery import fail


def parse_json(data: bytes) -> Any:
    def unique(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                fail("duplicate JSON key")
            value[key] = item
        return value

    def constant(_):
        fail("non-finite JSON constant")

    try:
        return json.loads(data.decode("utf-8"), object_pairs_hook=unique, parse_constant=constant)
    except (ValueError, UnicodeError, RecursionError):
        fail("invalid JSON input")


def read_json(path: Path, maximum: int = 10 * 1024 * 1024) -> Any:
    with path.open("rb") as handle:
        data = handle.read(maximum + 1)
    if len(data) > maximum:
        fail("JSON input exceeds size limit")
    return parse_json(data)
