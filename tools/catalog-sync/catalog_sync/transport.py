"""Public baseline GET and explicitly gated review ingestion; no publishing API."""
from __future__ import annotations

import re
from pathlib import Path
from time import monotonic
from urllib.parse import urlsplit
from typing import Any

from requests import Session

from .discovery import fail, known_video_ids, validate_manifest
from .jsonio import parse_json, read_json
from .normalize import CatalogueSyncError, dumps_review


MAX_BYTES = 10 * 1024 * 1024


def validate_origin(origin: str) -> str:
    try:
        parsed = urlsplit(origin)
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
                or parsed.path not in ("", "/") or parsed.query or parsed.fragment
                or parsed.port not in (None, 443) or any(char.isspace() for char in origin)
                or "\\" in origin):
            fail("origin must be a bare public HTTPS origin")
    except (ValueError, TypeError):
        fail("origin must be a bare public HTTPS origin")
    return origin.rstrip("/")


def _request(origin: str, path: str, method: str, *, data: bytes | None = None,
             token: str | None = None, session: Any = None, read_body: bool = True) -> bytes:
    origin = validate_origin(origin)
    own_session = session is None
    public = session if session is not None else Session()
    public.trust_env = False
    response = None
    try:
        headers = {"Accept": "application/json"}
        if token is not None:
            if not isinstance(token, str) or not token or len(token) > 4096 or any(ord(char) < 33 or ord(char) > 126 for char in token):
                fail("ingestion token is missing or malformed")
            headers["Authorization"] = "Bearer " + token
            headers["Content-Type"] = "application/json"
        deadline = monotonic() + 20
        response = public.request(method, origin + path, headers=headers, data=data,
                                  timeout=20, allow_redirects=False, stream=True)
        if not 200 <= response.status_code < 300:
            fail("catalogue endpoint rejected the request; no retry attempted")
        if not read_body:
            return b""
        result = bytearray()
        for chunk in response.iter_content(65536):
            result.extend(chunk)
            if len(result) > MAX_BYTES or monotonic() > deadline:
                fail("catalogue response exceeds limits")
        return bytes(result)
    except Exception:
        raise CatalogueSyncError("catalogue request failed; details redacted; no retry attempted") from None
    finally:
        if response is not None:
            response.close()
        if own_session:
            public.close()


def fetch_catalogue(origin: str, *, session: Any = None) -> dict:
    value = parse_json(_request(origin, "/api/catalogue", "GET", session=session))
    if not isinstance(value, dict) or set(value) != {"revision", "tracks"}:
        fail("invalid public catalogue envelope")
    if not isinstance(value["revision"], str) or not re.fullmatch(r"[1-9][0-9]{0,15}", value["revision"]):
        fail("invalid public catalogue revision")
    known_video_ids(value)
    return value


def ingest_manifests(origin: str, directory: Path, token: str, *, enabled: bool = False,
                     session: Any = None) -> int:
    if enabled is not True:
        fail("ingestion is disabled")
    if not token:
        fail("separate ingestion token is required")
    validate_origin(origin)
    report = read_json(directory / "scan-report.json", 65536)
    if (not isinstance(report, dict) or report.get("complete") is not True
            or report.get("source") != "public-ytmusic" or report.get("catalogueSource") != "public-api"):
        fail("only complete public discovery with a public API baseline can be ingested")
    names = report.get("manifests")
    if not isinstance(names, list) or not 1 <= len(names) <= 10 or len(set(names)) != len(names):
        fail("invalid manifest artifact list")
    payloads = []
    seen_runs, seen_videos = set(), set()
    for name in names:
        if not isinstance(name, str) or not re.fullmatch(r"manifest-[0-9]{4}\.json", name):
            fail("invalid manifest artifact name")
        path = directory / name
        if path.is_symlink() or path.resolve().parent != directory.resolve():
            fail("manifest escapes artifact directory")
        value = validate_manifest(read_json(path, 1024 * 1024))
        if value["runId"] in seen_runs:
            fail("duplicate manifest run ID")
        seen_runs.add(value["runId"])
        for item in value["discoveries"]:
            if item["videoId"] in seen_videos:
                fail("duplicate video across manifests")
            seen_videos.add(item["videoId"])
        if value["discoveries"]:
            payloads.append(dumps_review(value))
    # Validate every payload before the first write; stop at the first failure.
    for data in payloads:
        _request(origin, "/api/catalogue/discovery/runs", "POST", data=data,
                 token=token, session=session, read_body=False)
    return len(payloads)
