"""Review-only AI seam. Manual JSON is data, never executable agent instructions."""
from __future__ import annotations

import math
import re
from copy import deepcopy
from typing import Any, Protocol, Sequence

from .discovery import GAMES, VIDEO, fail, identifier, keys, string_list, text
from .normalize import dumps_review


class SuggestionAdapter(Protocol):
    name: str

    def suggest(self, discoveries: Sequence[dict]) -> list[dict]: ...


class DeterministicAdapter:
    name = "deterministic"

    def suggest(self, discoveries: Sequence[dict]) -> list[dict]:
        return [{"videoId": item["videoId"], "games": item["games"][:], "album": item["album"],
                 "aliases": {}, "relation_ids": [], "work_group_id": None, "vocal_status": "uncertain",
                 "tabs": [], "reasons": ["Explicit public source and deterministic game configuration"],
                 "evidence": item["evidence"][:], "confidence": 0.0,
                 "uncertainties": ["Aliases, relations, work grouping, vocals and tabs require human review"]}
                for item in discoveries]


class ImportedJsonAdapter:
    name = "imported-json"

    def __init__(self, value: Any):
        keys(value, {"schemaVersion", "suggestions"})
        if type(value["schemaVersion"]) is not int or value["schemaVersion"] != 1:
            fail("unsupported suggestion schemaVersion")
        if not isinstance(value["suggestions"], list) or len(value["suggestions"]) > 1000:
            fail("suggestions must contain at most 1000 items")
        try:
            dumps_review(value)
        except (ValueError, TypeError):
            fail("invalid or unsafe suggestion JSON")
        self.items = deepcopy(value["suggestions"])

    def suggest(self, discoveries: Sequence[dict]) -> list[dict]:
        return deepcopy(self.items)


def build_suggestions(discoveries: Sequence[dict], adapter: SuggestionAdapter) -> dict:
    allowed_ids = {item["videoId"] for item in discoveries}
    suggestions = adapter.suggest(deepcopy(discoveries))
    if not isinstance(suggestions, list) or len(suggestions) > 1000:
        fail("adapter suggestions exceed limits")
    seen = set()
    output = []
    for item in suggestions:
        keys(item, {"videoId", "games", "album", "aliases", "relation_ids", "work_group_id",
                    "vocal_status", "tabs", "reasons", "evidence", "confidence", "uncertainties"})
        video = identifier(item["videoId"], VIDEO, "suggestion videoId")
        if video not in allowed_ids or video in seen:
            fail("suggestion target is unknown or duplicated")
        seen.add(video)
        item["games"] = string_list(item["games"], "games", GAMES, 3)
        text(item["album"], "album")
        aliases = item["aliases"]
        if not isinstance(aliases, dict) or len(aliases) > 10:
            fail("aliases must be a bounded locale object")
        for locale, values in aliases.items():
            if not isinstance(locale, str) or not re.fullmatch(r"[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*", locale):
                fail("invalid alias locale")
            aliases[locale] = string_list(values, "aliases", maximum=20)
            for alias in aliases[locale]:
                text(alias, "alias", 500)
        item["relation_ids"] = string_list(item["relation_ids"], "relation_ids")
        for relation in item["relation_ids"]:
            if not re.fullmatch(r"(?:place|character|npc|faction|event):[A-Za-z0-9][A-Za-z0-9_-]{0,119}", relation):
                fail("invalid relation ID")
        if item["work_group_id"] is not None:
            identifier(item["work_group_id"], re.compile(r"[a-z0-9][a-z0-9_-]{0,119}", re.ASCII), "work_group_id")
        if item["vocal_status"] not in ("instrumental", "vocal", "uncertain"):
            fail("unknown vocal_status")
        item["tabs"] = string_list(item["tabs"], "tabs", {"sleep", "focus", "chill"}, 3)
        for field in ("reasons", "evidence", "uncertainties"):
            item[field] = string_list(item[field], field, maximum=16)
        if not item["reasons"] or not item["evidence"]:
            fail("suggestions require reasons and evidence")
        confidence = item["confidence"]
        if type(confidence) not in (int, float) or not math.isfinite(confidence) or not 0 <= confidence <= 1:
            fail("confidence must be a finite number between zero and one")
        if (confidence < 1 or item["vocal_status"] == "uncertain") and not item["uncertainties"]:
            fail("uncertain suggestions require explicit uncertainties")
        output.append(item)
    result = {"schemaVersion": 1, "adapter": adapter.name,
              "suggestions": sorted(output, key=lambda item: item["videoId"])}
    dumps_review(result)
    return result
