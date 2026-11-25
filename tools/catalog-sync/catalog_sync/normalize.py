"""Normalise public discovery into deterministic, review-only catalogue diffs."""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from collections.abc import Mapping, Sequence
from copy import deepcopy
from typing import Any
from urllib.parse import parse_qsl, urlsplit


class CatalogueSyncError(ValueError):
    """Base error for malformed public or approved catalogue metadata."""


class UnsafeReviewPayload(CatalogueSyncError):
    """Raised before serialisation when a payload contains secret or media data."""


_BLOCKED_KEYS = {"authorization", "cookie", "cookies", "headers", "streamingdata"}
_MANAGED_SOURCE_METADATA = {
    "albumBrowseId",
    "albumTitle",
    "artistChannelId",
    "available",
    "durationSeconds",
    "playlistId",
}
_STABLE_METADATA_FIELDS = (
    "videoId",
    "title",
    "artistChannelId",
    "albumBrowseId",
    "albumTitle",
    "playlistId",
    "durationSeconds",
    "available",
)
_VERSION_MARKERS = (
    "acoustic",
    "arrangement",
    "arranged",
    "concert",
    "demo",
    "instrumental",
    "language version",
    "live",
    "orchestral",
    "piano",
    "rearranged",
    "remaster",
    "remastered",
    "remix",
    "version",
    "ver.",
)
_BRACKETED_SUFFIX = re.compile(r"\s*[\(\[（【]([^\)\]）】]+)[\)\]）】]\s*$")
_DASH_SUFFIX = re.compile(r"\s+[-–—]\s+(.+?)\s*$")
_SIGNED_URL_QUERY_KEYS = {
    "awsaccesskeyid",
    "credential",
    "expire",
    "expires",
    "googleaccessid",
    "lsig",
    "security-token",
    "securitytoken",
    "sig",
    "signature",
    "token",
}
_SIGNED_URL_QUERY_PREFIXES = ("x-amz-", "x-goog-")


def _assert_safe_payload(value: object, path: str = "review") -> None:
    if isinstance(value, Mapping):
        for key, item in value.items():
            normalised_key = str(key).replace("_", "").replace("-", "").casefold()
            if normalised_key in _BLOCKED_KEYS:
                raise UnsafeReviewPayload(f"{path}.{key}: forbidden field")
            _assert_safe_payload(item, f"{path}.{key}")
        return
    if isinstance(value, (list, tuple)):
        for index, item in enumerate(value):
            _assert_safe_payload(item, f"{path}[{index}]")
        return
    if isinstance(value, str):
        folded = value.casefold()
        if "videoplayback" in folded:
            raise UnsafeReviewPayload(f"{path}: short-lived media URL is forbidden")
        parsed = urlsplit(value)
        if parsed.scheme.casefold() not in {"http", "https"}:
            return
        hostname = (parsed.hostname or "").casefold()
        query_keys = {
            key.strip().casefold().replace("_", "-")
            for key, _ in parse_qsl(parsed.query)
        }
        has_signing_query = any(
            key in _SIGNED_URL_QUERY_KEYS
            or key.startswith(_SIGNED_URL_QUERY_PREFIXES)
            for key in query_keys
        )
        if (
            hostname == "googlevideo.com"
            or hostname.endswith(".googlevideo.com")
            or has_signing_query
        ):
            raise UnsafeReviewPayload(f"{path}: signed or media-delivery URL is forbidden")


def _text(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise CatalogueSyncError(f"{field} must be a non-empty string")
    return " ".join(unicodedata.normalize("NFC", value).split())


def _optional_text(value: object) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    return " ".join(unicodedata.normalize("NFC", value).split())


def _duration_seconds(track: Mapping[str, Any]) -> int | None:
    raw_seconds = track.get("duration_seconds")
    if isinstance(raw_seconds, int) and not isinstance(raw_seconds, bool) and raw_seconds >= 0:
        return raw_seconds
    if isinstance(raw_seconds, str) and raw_seconds.isdigit():
        return int(raw_seconds)

    duration = track.get("duration")
    if not isinstance(duration, str):
        return None
    parts = duration.strip().split(":")
    if len(parts) not in (2, 3) or any(not part.isdigit() for part in parts):
        return None
    total = 0
    for part in parts:
        total = total * 60 + int(part)
    return total


def _has_version_marker(value: str) -> bool:
    folded = value.casefold()
    return any(marker in folded for marker in _VERSION_MARKERS)


def _work_group_title(title: str) -> str:
    candidate = title
    while True:
        match = _BRACKETED_SUFFIX.search(candidate)
        if match and _has_version_marker(match.group(1)):
            candidate = candidate[: match.start()].rstrip()
            continue
        match = _DASH_SUFFIX.search(candidate)
        if match and _has_version_marker(match.group(1)):
            candidate = candidate[: match.start()].rstrip()
            continue
        break
    return candidate or title


def _work_group_candidate(title: str) -> tuple[str, str]:
    candidate_title = _work_group_title(title)
    identity = unicodedata.normalize("NFKC", candidate_title).casefold()
    identity = " ".join(identity.split())
    digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:20]
    return f"candidate:{digest}", candidate_title


def normalize_discovery(releases: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Allowlist stable fields from album responses and reject ambiguous IDs."""

    normalised: dict[str, dict[str, Any]] = {}
    ordered_releases = sorted(
        releases,
        key=lambda release: (
            str(release.get("albumBrowseId", "")),
            str(release.get("artistChannelId", "")),
        ),
    )

    for release in ordered_releases:
        _assert_safe_payload(release)
        channel_id = _text(release.get("artistChannelId"), "artistChannelId")
        browse_id = _text(release.get("albumBrowseId"), "albumBrowseId")
        album = release.get("album")
        if not isinstance(album, Mapping):
            raise CatalogueSyncError(f"album {browse_id!r} must be an object")
        summary = release.get("summary")
        if not isinstance(summary, Mapping):
            summary = {}

        album_title = _optional_text(album.get("title")) or _optional_text(summary.get("title"))
        if album_title is None:
            raise CatalogueSyncError(f"album {browse_id!r} has no title")
        playlist_id = _optional_text(album.get("audioPlaylistId")) or _optional_text(
            summary.get("playlistId")
        )
        tracks = album.get("tracks")
        if not isinstance(tracks, list):
            raise CatalogueSyncError(f"album {browse_id!r} has no track list")

        for track_index, track in enumerate(tracks):
            if not isinstance(track, Mapping):
                raise CatalogueSyncError(
                    f"album {browse_id!r} track {track_index} must be an object"
                )
            video_id = _optional_text(track.get("videoId"))
            if video_id is None:
                raise CatalogueSyncError(
                    f"album {browse_id!r} track {track_index} has no stable videoId"
                )
            title = _text(track.get("title"), f"track {video_id!r} title")
            work_group_id, work_group_title = _work_group_candidate(title)
            candidate: dict[str, Any] = {
                "stableId": f"youtube:{video_id}",
                "videoId": video_id,
                "title": title,
                "artistChannelId": channel_id,
                "albumBrowseId": browse_id,
                "albumTitle": album_title,
                "available": track.get("isAvailable") is not False,
                "workGroupCandidate": work_group_id,
                "workGroupCandidateTitle": work_group_title,
            }
            if playlist_id is not None:
                candidate["playlistId"] = playlist_id
            duration_seconds = _duration_seconds(track)
            if duration_seconds is not None:
                candidate["durationSeconds"] = duration_seconds

            stable_id = candidate["stableId"]
            previous = normalised.get(stable_id)
            if previous is not None and previous != candidate:
                raise CatalogueSyncError(
                    f"conflicting public metadata for stable ID {stable_id!r}"
                )
            normalised[stable_id] = candidate

    return [normalised[stable_id] for stable_id in sorted(normalised)]


def _youtube_source(track: Mapping[str, Any]) -> Mapping[str, Any] | None:
    sources = track.get("sources")
    if not isinstance(sources, list):
        raise CatalogueSyncError("approved track sources must be a list")
    matches = [
        source
        for source in sources
        if isinstance(source, Mapping) and source.get("provider") == "youtube"
    ]
    if len(matches) > 1:
        raise CatalogueSyncError("approved track has duplicate YouTube sources")
    return matches[0] if matches else None


def _source_metadata(discovered: Mapping[str, Any]) -> dict[str, str]:
    metadata: dict[str, str] = {}
    for field in _MANAGED_SOURCE_METADATA:
        value = discovered.get(field)
        if value is None:
            continue
        if isinstance(value, bool):
            metadata[field] = "true" if value else "false"
        else:
            metadata[field] = str(value)
    return dict(sorted(metadata.items()))


def _approved_metadata(track: Mapping[str, Any], source: Mapping[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {
        "videoId": source.get("externalId"),
        "title": track.get("title"),
    }
    metadata = source.get("metadata")
    if isinstance(metadata, Mapping):
        for field in _MANAGED_SOURCE_METADATA:
            value = metadata.get(field)
            if value is None:
                continue
            if field == "durationSeconds" and isinstance(value, str) and value.isdigit():
                value = int(value)
            elif field == "available" and isinstance(value, str):
                value = value.casefold() == "true"
            result[field] = value
    return {field: result[field] for field in _STABLE_METADATA_FIELDS if field in result}


def _discovered_metadata(discovered: Mapping[str, Any]) -> dict[str, Any]:
    return {
        field: discovered[field]
        for field in _STABLE_METADATA_FIELDS
        if field in discovered
    }


def _catalogue_candidate(
    discovered: Mapping[str, Any], approved: Mapping[str, Any] | None
) -> dict[str, Any]:
    if approved is None:
        return {
            "id": discovered["stableId"],
            "title": discovered["title"],
            "aliases": {},
            "games": [],
            "relationIds": [],
            "tabs": [],
            "workGroupId": discovered["workGroupCandidate"],
            "needsClassification": True,
            "sources": [
                {
                    "provider": "youtube",
                    "externalId": discovered["videoId"],
                    "metadata": _source_metadata(discovered),
                }
            ],
        }

    candidate = deepcopy(dict(approved))
    candidate["title"] = discovered["title"]
    sources = candidate.get("sources")
    if not isinstance(sources, list):
        raise CatalogueSyncError("approved track sources must be a list")
    for source in sources:
        if not isinstance(source, dict) or source.get("provider") != "youtube":
            continue
        source["externalId"] = discovered["videoId"]
        existing_metadata = source.get("metadata")
        metadata = dict(existing_metadata) if isinstance(existing_metadata, Mapping) else {}
        for field in _MANAGED_SOURCE_METADATA:
            metadata.pop(field, None)
        metadata.update(_source_metadata(discovered))
        if metadata:
            source["metadata"] = dict(sorted(metadata.items()))
        else:
            source.pop("metadata", None)
        break
    return candidate


def build_review(
    discovered_tracks: Sequence[Mapping[str, Any]],
    approved_catalogue: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    """Build material diffs without mutating or writing the approved catalogue."""

    approved_by_video: dict[str, Mapping[str, Any]] = {}
    approved_source_by_video: dict[str, Mapping[str, Any]] = {}
    for track in approved_catalogue:
        source = _youtube_source(track)
        if source is None:
            continue
        video_id = _text(source.get("externalId"), "approved YouTube externalId")
        if video_id in approved_by_video:
            raise CatalogueSyncError(f"duplicate approved YouTube videoId {video_id!r}")
        approved_by_video[video_id] = track
        approved_source_by_video[video_id] = source

    changes: list[dict[str, Any]] = []
    seen_stable_ids: set[str] = set()
    for discovered in sorted(discovered_tracks, key=lambda item: str(item.get("stableId", ""))):
        _assert_safe_payload(discovered, "discovered")
        stable_id = _text(discovered.get("stableId"), "stableId")
        if stable_id in seen_stable_ids:
            raise CatalogueSyncError(f"duplicate discovered stable ID {stable_id!r}")
        seen_stable_ids.add(stable_id)
        video_id = _text(discovered.get("videoId"), f"{stable_id}.videoId")
        if stable_id != f"youtube:{video_id}":
            raise CatalogueSyncError(f"{stable_id!r} does not match its YouTube videoId")

        approved = approved_by_video.get(video_id)
        before = (
            _approved_metadata(approved, approved_source_by_video[video_id])
            if approved is not None
            else None
        )
        after = _discovered_metadata(discovered)
        if before == after:
            continue
        kind = (
            "unavailable"
            if discovered.get("available") is False
            else "added"
            if approved is None
            else "changed"
        )
        changes.append(
            {
                "stableId": stable_id,
                "kind": kind,
                "metadataDiff": {"before": before, "after": after},
                "workGroupCandidate": {
                    "id": discovered["workGroupCandidate"],
                    "title": discovered["workGroupCandidateTitle"],
                },
                "catalogueCandidate": _catalogue_candidate(discovered, approved),
            }
        )

    review = {"schemaVersion": 1, "changes": changes}
    _assert_safe_payload(review)
    return review


def dumps_review(review: Mapping[str, Any]) -> bytes:
    """Serialise a safe review deterministically as UTF-8 JSON plus one newline."""

    _assert_safe_payload(review)
    return (
        json.dumps(review, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False) + "\n"
    ).encode("utf-8")
