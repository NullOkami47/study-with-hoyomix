"""Finite metadata campaigns. Window ACK means storage, never ingestion approval.

Only a complete inventory certificate permits validate_outbox to release manifests.
The host owns immutable window storage, CAS/lease, baseline GET and POST reconciliation.
No cloud SDK, credentials, AI calls, catalogue writes or legacy report fabrication.
"""
from __future__ import annotations

from collections.abc import Mapping
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import sha256
import json
import math
import re
from time import monotonic
from typing import Any, Callable

from .discovery import (BROWSE, CHANNEL, RUN, VIDEO, DiscoveryConfig, batch_manifests,
                        fail, identifier, keys, known_video_ids, scan_releases,
                        string_list, text, validate_manifest)
from .jsonio import parse_json
from .normalize import CatalogueSyncError, _optional_text, dumps_review
from .transport import validate_origin
from . import ytmusic


MAX_RECORD_BYTES = 10 * 1024 * 1024
MAX_VIDEO_IDENTITIES = 32000
_HASH = re.compile(r"[a-f0-9]{64}")
_STATUSES = {"ready", "in_progress", "outbox_pending", "complete", "blocked", "pending_review"}
_REASONS = {"request_limit", "time_limit", "release_page_limit", "album_track_limit",
            "album_tracks_incomplete", "unclassified_game", "invalid_release_date",
            "discovery_limit", "unavailable_track", "duplicate_video", "duplicate_album",
            "inventory_limit", "inventory_drift", "zero_progress", "step_limit",
            "scan_failed", "invalid_page", "record_limit", "clock_invalid", "exclusion_conflict"}
_STATE_KEYS = {"schemaVersion", "campaignId", "origin", "createdAt", "config", "limits",
               "scope", "inventoryId", "inventorySize", "cursor", "position", "steps",
               "status", "reasons", "globalComplete", "pages", "pending", "outbox",
               "acknowledged", "seenVideos", "certificate", "digest"}
_ENVELOPE_KEYS = {"schemaVersion", "campaignId", "batchId", "scope", "inventoryId",
                  "inventorySize", "startIndex", "endIndex", "cursorStart", "cursorEnd",
                  "pageComplete", "globalComplete", "provisional", "catalogueRevision",
                  "catalogueFingerprint", "catalogueKnownVideoIds", "releases", "manifests", "payloadDigest"}
_RECEIPT_KEYS = {"batchId", "payloadDigest", "startIndex", "endIndex", "cursorStart",
                 "cursorEnd", "albumIds", "videoIds"}


class _CampaignRecordLimit(CatalogueSyncError):
    pass


class _NeedsReview(CatalogueSyncError):
    pass


def _limits(window: int) -> dict:
    _integer(window, 1, 30)
    return {"windowAlbums": window, "inventory": 800, "steps": 32, "apiCalls": 80,
            "seconds": 240, "responseBytes": 8 * 1024 * 1024, "candidates": 1000,
            "manifestRows": 100, "manifests": 10}


def _integer(value: Any, minimum: int, maximum: int) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        fail("campaign integer exceeds bounds")
    return value


def _encode(value: Any) -> bytes:
    try:
        dumps_review(value)  # shared secret/media safety boundary
        data = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
                          allow_nan=False).encode("utf-8")
    except (ValueError, TypeError, UnicodeError, RecursionError):
        raise CatalogueSyncError("invalid campaign JSON") from None
    if len(data) > MAX_RECORD_BYTES:
        raise _CampaignRecordLimit("campaign record exceeds size limit")
    return data


def _hash(value: Any) -> str:
    return sha256(_encode(value)).hexdigest()


def _without(value: dict, name: str) -> dict:
    return {key: item for key, item in value.items() if key != name}


def _config(value: DiscoveryConfig | dict) -> tuple[DiscoveryConfig, dict]:
    if isinstance(value, DiscoveryConfig):
        value = {"schemaVersion": 1, "channels": [{"id": key, "games": games}
                 for key, games in sorted(value.channels.items())], "albumGames": value.album_games}
    config = DiscoveryConfig.from_dict(value)
    if not config.channels:
        fail("campaign requires explicit public channels")
    canonical = {"schemaVersion": 1, "channels": [{"id": key, "games": games}
                 for key, games in sorted(config.channels.items())], "albumGames": config.album_games}
    return config, canonical


def _scope(value: dict) -> str:
    fields = {key: value[key] for key in ("campaignId", "origin", "createdAt", "config", "limits")}
    if "reviewedExclusions" in value:
        fields["reviewedExclusions"] = value["reviewedExclusions"]
    return _hash(fields)


def _reviewed_exclusions(value: Any, config: DiscoveryConfig) -> list[dict]:
    if not isinstance(value, list) or len(value) > 800:
        fail("reviewed exclusions must be a bounded list")
    seen, result = set(), []
    for item in value:
        keys(item, {"artistChannelId", "albumBrowseId", "disposition", "reason", "evidence"})
        channel = identifier(item["artistChannelId"], CHANNEL, "excluded channel ID")
        browse = identifier(item["albumBrowseId"], BROWSE, "excluded album ID")
        identity = (channel, browse)
        if (channel not in config.channels or identity in seen or item["disposition"] != "out_of_scope"
                or config.channels[channel] or browse in config.album_games):
            fail("reviewed exclusion is duplicated, outside scope or conflicts with target mapping")
        text(item["reason"], "review reason")
        evidence = string_list(item["evidence"], "exclusion evidence", maximum=2)
        album_url = "https://music.youtube.com/browse/" + browse
        allowed = {album_url, "https://music.youtube.com/channel/" + channel}
        if album_url not in evidence or not set(evidence) <= allowed:
            fail("reviewed exclusion requires exact official album evidence")
        seen.add(identity)
        result.append({**deepcopy(item), "evidence": evidence})
    return sorted(result, key=lambda item: (item["albumBrowseId"], item["artistChannelId"]))


def _included_releases(releases: list, state: dict, config: DiscoveryConfig) -> list:
    excluded = {(item["artistChannelId"], item["albumBrowseId"])
                for item in state.get("reviewedExclusions", [])}
    included = []
    for release in releases:
        channel, browse = release["artistChannelId"], release["albumBrowseId"]
        summary = release.get("summary")
        title = _optional_text(release["album"].get("title")) or _optional_text(
            summary.get("title") if isinstance(summary, Mapping) else None)
        if title is None:
            fail("campaign album has no title")
        games = config.games_for(channel, browse, title)
        if (channel, browse) in excluded:
            if games:
                raise _NeedsReview("exclusion_conflict")
        elif not games:
            raise _NeedsReview("unclassified_game")
        else:
            included.append(release)
    return included


def _baseline(value: Any) -> tuple[str, str]:
    keys(value, {"revision", "tracks"})
    if not isinstance(value["revision"], str) or not re.fullmatch(r"[1-9][0-9]{0,15}", value["revision"]):
        fail("invalid campaign catalogue revision")
    known_video_ids(value)
    return value["revision"], _hash(value)


def _inventory(config: DiscoveryConfig, albums: list) -> str:
    # Same identity recipe as discover_bounded_releases; does not call legacy merge.
    return sha256(json.dumps([sorted(config.channels), 100, sorted(albums)],
                             separators=(",", ":")).encode("utf-8")).hexdigest()


def _boundary(value: Any, inventory: str, position: int, size: int, *, start=False) -> None:
    expected = None if (start and position == 0) or (not start and position == size) else ytmusic._cursor(inventory, position)
    if value != expected:
        fail("campaign cursor chain is invalid")


def _project(releases: list) -> list:
    """Allowlist durable metadata; never save raw public response objects."""
    projected = []
    for release in releases:
        summary = {key: release.get("summary", {})[key] for key in ("title", "playlistId")
                   if key in release.get("summary", {})}
        album = {key: release["album"][key] for key in ("title", "audioPlaylistId", "releaseDate", "trackCount")
                 if key in release["album"]}
        if "trackCount" in album and (type(album["trackCount"]) is not int
                or not 0 <= album["trackCount"] <= 1000
                or album["trackCount"] != len(release["album"]["tracks"])):
            fail("invalid stable album track count")
        album["tracks"] = [{key: track[key] for key in ("videoId", "title", "duration", "duration_seconds", "isAvailable")
                            if key in track} for track in release["album"]["tracks"]]
        for track in album["tracks"]:
            if "isAvailable" in track and type(track["isAvailable"]) is not bool:
                fail("invalid stable availability flag")
            if "duration_seconds" in track and type(track["duration_seconds"]) is not int:
                fail("invalid stable track duration")
        projected.append({"artistChannelId": release["artistChannelId"],
                          "albumBrowseId": release["albumBrowseId"], "summary": summary, "album": album})
    _encode(projected)
    return projected


def _identities(releases: list, included: list | None = None) -> list:
    albums = [[release["albumBrowseId"], release["artistChannelId"]] for release in releases]
    for release in releases:
        for track in release["album"]["tracks"]:
            identifier(track.get("videoId"), VIDEO, "video ID")
    checked = releases if included is None else included
    videos = [track["videoId"] for release in checked for track in release["album"]["tracks"]]
    if len({tuple(pair) for pair in albums}) != len(albums):
        fail("duplicate_album")
    if len(set(videos)) != len(videos):
        fail("duplicate_video")
    return albums


def _receipt(envelope: dict, included: list | None = None) -> dict:
    checked = envelope["releases"] if included is None else included
    albums = _identities(envelope["releases"], checked)
    videos = _video_fingerprints(checked)
    return {**{key: envelope[key] for key in ("batchId", "payloadDigest", "startIndex", "endIndex", "cursorStart", "cursorEnd")},
            "albumIds": albums, "videoIds": sorted(videos)}


def _video_fingerprints(releases: list) -> dict:
    # Include baseline-known and excluded tracks: a later fresh baseline can remove IDs.
    return {track["videoId"]: _hash({"artistChannelId": release["artistChannelId"],
            "albumBrowseId": release["albumBrowseId"], "track": track})
            for release in releases for track in release["album"]["tracks"]}


def _certificate(value: dict) -> dict:
    windows = [{key: page[key] for key in ("batchId", "payloadDigest")} for page in value["pages"]]
    return {"schemaVersion": 1, "campaignId": value["campaignId"], "scope": value["scope"],
            "inventoryId": value["inventoryId"], "inventorySize": value["inventorySize"],
            "windows": windows, "chainDigest": _hash(value["pages"])}


@dataclass(frozen=True)
class CampaignState:
    _value: dict

    @classmethod
    def from_json(cls, data: bytes | str) -> CampaignState:
        try:
            if isinstance(data, str):
                data = data.encode("utf-8")
            if not isinstance(data, bytes) or len(data) > MAX_RECORD_BYTES:
                fail("campaign JSON exceeds size limit")
            return validate_state(parse_json(data))
        except (ValueError, TypeError, UnicodeError, RecursionError):
            raise CatalogueSyncError("invalid campaign checkpoint") from None

    def to_dict(self) -> dict:
        return deepcopy(validate_state(self)._value)

    def to_json(self) -> bytes:
        return _encode(self.to_dict())


@dataclass(frozen=True)
class CampaignAdvance:
    status: str
    checkpoint: CampaignState
    outbox: list[dict]


def _seal(value: dict) -> CampaignState:
    value["digest"] = _hash(_without(value, "digest"))
    return validate_state(value)


def start_campaign(config: DiscoveryConfig | dict, origin: str, campaign_id: str,
                   now: str, *, window_albums: int = 30,
                   reviewed_exclusions: list[dict] | None = None) -> CampaignState:
    parsed, cfg = _config(config)
    reviewed = _reviewed_exclusions([] if reviewed_exclusions is None else reviewed_exclusions, parsed)
    identifier(campaign_id, RUN, "campaignId")
    if len(campaign_id) > 80:
        fail("campaignId exceeds batch naming limit")
    if not isinstance(now, str) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z", now):
        fail("campaign creation time must be UTC")
    try:
        datetime.strptime(now, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        fail("invalid campaign creation time")
    value = {"schemaVersion": 1, "campaignId": campaign_id, "origin": validate_origin(origin),
             "createdAt": now, "config": cfg, "limits": _limits(window_albums),
             "inventoryId": None, "inventorySize": None, "cursor": None, "position": 0,
             "steps": 0, "status": "ready", "reasons": [], "globalComplete": False,
             "pages": [], "pending": None, "outbox": [], "acknowledged": [],
             "seenVideos": {}, "certificate": None}
    if reviewed:
        value["reviewedExclusions"] = reviewed
    value["scope"] = _scope(value)
    return _seal(value)


def _validate_envelope(envelope: dict, state: dict, config: DiscoveryConfig) -> dict:
    keys(envelope, _ENVELOPE_KEYS)
    _encode(envelope)
    if (type(envelope["schemaVersion"]) is not int or envelope["schemaVersion"] != 1
            or envelope["pageComplete"] is not True or envelope["globalComplete"] is not False
            or envelope["provisional"] is not True
            or any(envelope[key] != state[key] for key in ("campaignId", "scope", "inventoryId", "inventorySize"))
            or envelope["payloadDigest"] != _hash(_without(envelope, "payloadDigest"))):
        fail("invalid provisional campaign window")
    identifier(envelope["batchId"], RUN, "batchId")
    start = _integer(envelope["startIndex"], 0, state["inventorySize"])
    end = _integer(envelope["endIndex"], start, min(state["inventorySize"], start + state["limits"]["windowAlbums"]))
    if start == end and state["inventorySize"] != 0:
        fail("campaign window made zero progress")
    _boundary(envelope["cursorStart"], state["inventoryId"], start, state["inventorySize"], start=True)
    _boundary(envelope["cursorEnd"], state["inventoryId"], end, state["inventorySize"])
    if (not isinstance(envelope["releases"], list) or len(envelope["releases"]) != end - start
            or _project(envelope["releases"]) != envelope["releases"]):
        fail("campaign window is missing stable album data")
    if (not isinstance(envelope["catalogueRevision"], str)
            or not re.fullmatch(r"[1-9][0-9]{0,15}", envelope["catalogueRevision"])):
        fail("invalid window baseline revision")
    identifier(envelope["catalogueFingerprint"], _HASH, "catalogue fingerprint")
    # Revalidate all underlying albums even if they were known in the old baseline.
    all_track_ids = {track["videoId"] for release in envelope["releases"] for track in release["album"]["tracks"]}
    known = envelope["catalogueKnownVideoIds"]
    if not isinstance(known, list) or len(known) > 30000:
        fail("invalid saved window baseline identities")
    if (any(not isinstance(item, str) or not VIDEO.fullmatch(item) or item not in all_track_ids for item in known)
            or known != sorted(set(known))):
        fail("invalid saved window baseline identities")
    included = _included_releases(envelope["releases"], state, config)
    included_track_ids = [track["videoId"] for release in included for track in release["album"]["tracks"]]
    if len(set(included_track_ids)) != len(included_track_ids):
        fail("duplicate video identity inside campaign window")
    baseline = {"tracks": [{"sources": [{"provider": "youtube", "externalId": item}]} for item in known]}
    allowed = {}
    for release in included:
        result = scan_releases([release], baseline, config)
        if not result.report["complete"] or result.report["unavailable"]:
            fail("campaign window metadata requires review")
        allowed.update({row["videoId"]: row for row in result.discoveries})
    manifests = envelope["manifests"]
    if not isinstance(manifests, list) or not 1 <= len(manifests) <= 10:
        fail("invalid campaign manifest count")
    rows, runs = set(), set()
    for manifest in manifests:
        validate_manifest(manifest)
        if manifest["runId"] in runs:
            fail("duplicate campaign manifest run")
        runs.add(manifest["runId"])
        for row in manifest["discoveries"]:
            if row["videoId"] in rows or row != allowed.get(row["videoId"]):
                fail("campaign manifest is duplicated or does not match metadata")
            rows.add(row["videoId"])
    if rows != set(allowed):
        fail("campaign manifests omit discovered tracks")
    receipt = _receipt(envelope, included)
    if receipt["albumIds"] != sorted(receipt["albumIds"]):
        fail("campaign albums are not ordered")
    return receipt


def validate_state(value: dict | CampaignState) -> CampaignState:
    """Strict integrity/structure validation; host must authenticate its stored record."""
    try:
        raw = value._value if isinstance(value, CampaignState) else value
        keys(raw, _STATE_KEYS, {"reviewedExclusions"})
        _encode(raw)
        if type(raw["schemaVersion"]) is not int or raw["schemaVersion"] != 1:
            fail("unsupported campaign schema")
        if raw["digest"] != _hash(_without(raw, "digest")):
            fail("campaign checkpoint digest mismatch")
        config, canonical = _config(raw["config"])
        if "reviewedExclusions" in raw and (not raw["reviewedExclusions"]
                or raw["reviewedExclusions"] != _reviewed_exclusions(raw["reviewedExclusions"], config)):
            fail("reviewed exclusions are not canonical")
        identifier(raw["campaignId"], RUN, "campaignId")
        if len(raw["campaignId"]) > 80 or validate_origin(raw["origin"]) != raw["origin"]:
            fail("invalid campaign target")
        if (not isinstance(raw["createdAt"], str)
                or datetime.strptime(raw["createdAt"], "%Y-%m-%dT%H:%M:%SZ").strftime("%Y-%m-%dT%H:%M:%SZ") != raw["createdAt"]):
            fail("invalid campaign creation time")
        keys(raw["limits"], set(_limits(30)))
        if raw["config"] != canonical or raw["limits"] != _limits(raw["limits"]["windowAlbums"]) or raw["scope"] != _scope(raw):
            fail("campaign scope mismatch")
        steps = _integer(raw["steps"], 0, 32)
        position = _integer(raw["position"], 0, 800)
        if raw["status"] not in _STATUSES or type(raw["globalComplete"]) is not bool:
            fail("invalid campaign status")
        reasons = raw["reasons"]
        if (not isinstance(reasons, list) or any(not isinstance(x, str) or x not in _REASONS for x in reasons)
                or reasons != sorted(set(reasons))):
            fail("invalid campaign reasons")
        if bool(reasons) != (raw["status"] in {"blocked", "pending_review"}):
            fail("campaign failure status mismatch")
        if raw["pending"] is not None:
            keys(raw["pending"], {"startIndex", "endIndex", "apiCalls"})
            _integer(raw["pending"]["startIndex"], position, position)
            _integer(raw["pending"]["endIndex"], position, 800)
            _integer(raw["pending"]["apiCalls"], 0, 80)
            if not reasons:
                fail("uncommitted diagnostic requires blocked status")
        terminal_failure = raw["status"] in {"blocked", "pending_review"}
        if (not isinstance(raw["pages"], list) or len(raw["pages"]) > min(steps, 32)
                or steps != len(raw["pages"]) + int(bool(raw["outbox"])
                    or (terminal_failure and "step_limit" not in raw["reasons"]))):
            fail("invalid campaign page count")
        if not isinstance(raw["outbox"], list) or len(raw["outbox"]) > 1:
            fail("campaign must have at most one unacknowledged window")
        if not isinstance(raw["seenVideos"], dict) or len(raw["seenVideos"]) > MAX_VIDEO_IDENTITIES:
            fail("invalid campaign video ledger")
        for video, digest in raw["seenVideos"].items():
            identifier(video, VIDEO, "video ID")
            identifier(digest, _HASH, "video fingerprint")
        if raw["inventoryId"] is None:
            if (raw["inventorySize"] is not None or position or raw["cursor"] is not None
                    or raw["pages"] or raw["outbox"] or raw["seenVideos"]):
                fail("campaign has no pinned inventory")
        else:
            identifier(raw["inventoryId"], _HASH, "inventory ID")
            _integer(raw["inventorySize"], 0, 800)
        end, albums, videos = 0, [], set()
        for index, page in enumerate(raw["pages"]):
            keys(page, _RECEIPT_KEYS)
            if page["batchId"] != f'{raw["campaignId"]}-w{index + 1:04d}':
                fail("campaign window order is invalid")
            identifier(page["payloadDigest"], _HASH, "stored window digest")
            _integer(page["startIndex"], end, end)
            end = _integer(page["endIndex"], end, min(raw["inventorySize"], end + raw["limits"]["windowAlbums"]))
            if end == page["startIndex"] and (raw["inventorySize"] != 0 or index):
                fail("campaign page made zero progress")
            _boundary(page["cursorStart"], raw["inventoryId"], page["startIndex"], raw["inventorySize"], start=True)
            _boundary(page["cursorEnd"], raw["inventoryId"], end, raw["inventorySize"])
            if not isinstance(page["albumIds"], list) or len(page["albumIds"]) != end - page["startIndex"]:
                fail("campaign page is missing albums")
            for pair in page["albumIds"]:
                if not isinstance(pair, list) or len(pair) != 2:
                    fail("invalid campaign album identity")
                identifier(pair[0], BROWSE, "album ID")
                identifier(pair[1], CHANNEL, "channel ID")
                if pair[1] not in config.channels:
                    fail("campaign album channel is outside scope")
            albums.extend(page["albumIds"])
            if (not isinstance(page["videoIds"], list) or len(page["videoIds"]) > 30000
                    or any(not isinstance(v, str) or not VIDEO.fullmatch(v) for v in page["videoIds"])
                    or len(set(page["videoIds"])) != len(page["videoIds"])
                    or videos.intersection(page["videoIds"])):
                fail("invalid or duplicated campaign video identities")
            videos.update(page["videoIds"])
        if albums != sorted(albums) or len({tuple(p) for p in albums}) != len(albums):
            fail("campaign album chain is duplicated or unordered")
        if set(raw["seenVideos"]) != videos:
            fail("campaign video ledger does not match stored pages")
        prior_album_ids = {tuple(pair) for page in raw["pages"] for pair in page["albumIds"]}
        if raw["acknowledged"] != [{key: p[key] for key in ("batchId", "payloadDigest")} for p in raw["pages"]]:
            fail("campaign storage receipts do not match pages")
        if raw["outbox"]:
            envelope = raw["outbox"][0]
            receipt = _validate_envelope(envelope, raw, config)
            if (receipt["startIndex"] != end or receipt["endIndex"] != position
                    or receipt["batchId"] != f'{raw["campaignId"]}-w{len(raw["pages"]) + 1:04d}'
                    or set(receipt["videoIds"]).intersection(videos)
                    or prior_album_ids.intersection(map(tuple, receipt["albumIds"]))
                    or raw["status"] != "outbox_pending" or steps != len(raw["pages"]) + 1):
                fail("unacknowledged campaign window is not contiguous")
        elif position != end or raw["status"] == "outbox_pending":
            fail("campaign position is missing its window")
        if raw["inventoryId"] is not None:
            _boundary(raw["cursor"], raw["inventoryId"], position, raw["inventorySize"],
                      start=not raw["pages"] and not raw["outbox"])
        complete = (bool(raw["pages"]) and raw["inventorySize"] == end and not raw["outbox"] and not reasons)
        if raw["globalComplete"] != complete or (raw["status"] == "complete") != complete:
            fail("campaign global completion is not proven")
        if complete:
            if raw["inventoryId"] != _inventory(config, albums) or raw["certificate"] != _certificate(raw):
                fail("campaign certificate does not match full inventory")
        elif raw["certificate"] is not None:
            fail("incomplete campaign cannot carry a certificate")
        if raw["status"] == "ready" and (steps or position or raw["pages"] or raw["inventoryId"] is not None):
            fail("invalid initial campaign")
        return CampaignState(deepcopy(raw))
    except (KeyError, TypeError, ValueError, AttributeError, RecursionError):
        raise CatalogueSyncError("invalid campaign checkpoint") from None


class _WindowClient:
    """Enforce injected-clock deadline and response bounds around trusted clients."""
    def __init__(self, client: Any, clock: Callable[[], float]):
        self.client, self.clock = client, clock
        self.started = self.previous = self._now()
        self._listed = {}

    def _now(self) -> float:
        value = self.clock()
        if type(value) not in (int, float) or not math.isfinite(value):
            raise ytmusic._BudgetReached("clock_invalid")
        return value

    def _check(self):
        current = self._now()
        if current < self.previous:
            raise ytmusic._BudgetReached("clock_invalid")
        self.previous = current
        if current - self.started >= 240:
            raise ytmusic._BudgetReached("time_limit")

    def _call(self, name, *args, **kwargs):
        self._check()
        result = getattr(self.client, name)(*args, **kwargs)
        self._check()
        # Actual HTTP transport also checks streaming bodies before materialisation.
        if len(json.dumps(result, allow_nan=False).encode("utf-8")) > 8 * 1024 * 1024:
            raise CatalogueSyncError("public response exceeds bounds")
        return result

    def get_artist(self, channel):
        value = self._call("get_artist", channel)
        seen = set()
        for shelf in ("albums", "singles"):
            section = value.get(shelf) if isinstance(value, dict) else None
            if isinstance(section, dict) and isinstance(section.get("results"), list) and len(section["results"]) >= 100:
                raise ytmusic._BudgetReached("release_page_limit")
            if isinstance(section, dict) and isinstance(section.get("results"), list):
                for item in section["results"]:
                    browse = item.get("browseId") if isinstance(item, dict) else None
                    if isinstance(browse, str) and browse in seen:
                        raise CatalogueSyncError("duplicate public shelf identity")
                    if isinstance(browse, str):
                        seen.add(browse)
        for shelf in ("albums", "singles"):
            section = value.get(shelf) if isinstance(value, dict) else None
            if isinstance(section, dict):
                params = ytmusic._non_empty_string(section.get("params"))
                if params is None:
                    continue
                context = (ytmusic._release_page_id(section, channel), params)
                if context in self._listed:
                    fail("duplicate public shelf context")
                preview = {item["browseId"] for item in section.get("results", [])
                           if isinstance(item, dict) and isinstance(item.get("browseId"), str)}
                self._listed[context] = (preview, seen)
        return value

    def get_artist_albums(self, shelf_id, params, *, limit):
        params = ytmusic._non_empty_string(params)
        context = (shelf_id, params)
        if params is None or context not in self._listed:
            fail("unregistered public shelf context")
        preview, seen = self._listed[context]
        value = self._call("get_artist_albums", shelf_id, params, limit=limit)
        page_seen = set()
        if not isinstance(value, list):
            return value
        for item in value:
            browse = item.get("browseId") if isinstance(item, dict) else None
            if isinstance(browse, str) and ((browse in seen and browse not in preview) or browse in page_seen):
                raise CatalogueSyncError("duplicate public shelf identity")
            if isinstance(browse, str):
                page_seen.add(browse)
        # The upstream method returns a full shelf, including its preview, not a delta.
        if not preview <= page_seen:
            raise ytmusic._BudgetReached("inventory_drift")
        seen.update(page_seen)
        return value

    def get_album(self, browse):
        return self._call("get_album", browse)


def _blocked(value: dict, reasons: list[str], *, review=False) -> CampaignAdvance:
    value["position"] = value["pages"][-1]["endIndex"] if value["pages"] else 0
    value["cursor"] = value["pages"][-1]["cursorEnd"] if value["pages"] else None
    value["status"] = "pending_review" if review else "blocked"
    value["reasons"] = sorted(set(reasons))
    value["outbox"], value["globalComplete"], value["certificate"] = [], False, None
    state = _seal(value)
    return CampaignAdvance(value["status"], state, [])


def advance_campaign(state: CampaignState, *, catalogue: dict, client: Any = None,
                     clock: Callable[[], float] = monotonic) -> CampaignAdvance:
    value = validate_state(state).to_dict()
    revision, fingerprint = _baseline(catalogue)  # fresh on every invocation, including restarts
    if value["status"] in {"outbox_pending", "complete", "blocked", "pending_review"}:
        return CampaignAdvance(value["status"], CampaignState(value), deepcopy(value["outbox"]))
    if value["steps"] >= 32:
        return _blocked(value, ["step_limit"])
    value["steps"] += 1
    config, _ = _config(value["config"])
    session = None
    try:
        if client is None:
            session = ytmusic._PublicSession(80, monotonic() + 240)
            client = ytmusic.YTMusic(requests_session=session)
        bounded = _WindowClient(client, clock)
        page = ytmusic.discover_bounded_releases(config.channels, client=bounded,
                    max_albums=value["limits"]["windowAlbums"], page_limit=100,
                    max_api_calls=80, max_seconds=240, cursor=value["cursor"])
        if session is not None:
            page.api_calls = session.count
        reasons = set(page.incomplete_reasons) - {"album_limit", "continuation_requires_merge"}
        if (not isinstance(page.inventory_id, str) or not _HASH.fullmatch(page.inventory_id)
                or type(page.inventory_size) is not int or not 0 <= page.inventory_size <= 800):
            if page.inventory_id is None and reasons:
                return _blocked(value, sorted(reasons))
            return _blocked(value, ["inventory_limit" if page.inventory_size > 800 else "invalid_page"])
        if value["inventoryId"] is not None and (page.inventory_id != value["inventoryId"] or page.inventory_size != value["inventorySize"]):
            return _blocked(value, ["inventory_drift"])
        value["inventoryId"], value["inventorySize"] = page.inventory_id, page.inventory_size
        if page.end_index == page.start_index and page.inventory_size:
            reasons.add("zero_progress")
        if (page.cursor != value["cursor"] or page.start_index != value["position"]
                or not page.start_index <= page.end_index <= min(page.inventory_size, page.start_index + value["limits"]["windowAlbums"])
                or len(page.releases) != page.end_index - page.start_index):
            reasons.add("invalid_page")
        if reasons:
            value["pending"] = {"startIndex": value["position"], "endIndex": max(value["position"], page.end_index),
                                "apiCalls": page.api_calls}
            return _blocked(value, sorted(reasons))
        _boundary(page.next_cursor, page.inventory_id, page.end_index, page.inventory_size)
        included = _included_releases(page.releases, value, config)
        try:
            included_video_list = [
                identifier(track.get("videoId"), VIDEO, "video ID")
                for release in included
                for track in release["album"]["tracks"]
            ]
        except CatalogueSyncError:
            included_video_list = None
        if included_video_list is not None and len(set(included_video_list)) != len(included_video_list):
            return _blocked(value, ["duplicate_video"], review=True)
        scan = scan_releases(included, catalogue, config)
        if scan.report["unavailable"]:
            scan.report["incompleteReasons"].append("unavailable_track")
        if scan.report["incompleteReasons"]:
            reasons = scan.report["incompleteReasons"]
            return _blocked(value, reasons, review="unclassified_game" in reasons or "unavailable_track" in reasons)
        releases = _project(page.releases)
        included_projected = _included_releases(releases, value, config)
        for release in releases:
            for track in release["album"]["tracks"]:
                identifier(track.get("videoId"), VIDEO, "video ID")
        included_videos = [track["videoId"] for release in included_projected for track in release["album"]["tracks"]]
        if len(set(included_videos)) != len(included_videos):
            return _blocked(value, ["duplicate_video"], review=True)
        window_videos = _video_fingerprints(included_projected)
        if set(window_videos).intersection(value["seenVideos"]):
            return _blocked(value, ["duplicate_video"], review=True)
        if len(value["seenVideos"]) + len(window_videos) > MAX_VIDEO_IDENTITIES:
            return _blocked(value, ["record_limit"])
        prior_albums = {tuple(pair) for item in value["pages"] for pair in item["albumIds"]}
        if prior_albums.intersection(map(tuple, _identities(releases, included_projected))):
            return _blocked(value, ["duplicate_album"])
        batch = f'{value["campaignId"]}-w{len(value["pages"]) + 1:04d}'
        envelope = {"schemaVersion": 1, "campaignId": value["campaignId"], "batchId": batch,
                    "scope": value["scope"], "inventoryId": page.inventory_id, "inventorySize": page.inventory_size,
                    "startIndex": page.start_index, "endIndex": page.end_index,
                    "cursorStart": page.cursor, "cursorEnd": page.next_cursor,
                    "pageComplete": True, "globalComplete": False, "provisional": True,
                    "catalogueRevision": revision, "catalogueFingerprint": fingerprint,
                    "catalogueKnownVideoIds": sorted(known_video_ids(catalogue) &
                        {track["videoId"] for release in releases for track in release["album"]["tracks"]}),
                    "releases": releases, "manifests": batch_manifests(scan.discoveries, batch)}
        envelope["payloadDigest"] = _hash(envelope)
        value.update(position=page.end_index, cursor=page.next_cursor, status="outbox_pending", outbox=[envelope])
        checkpoint = _seal(value)
        return CampaignAdvance("outbox_pending", checkpoint, deepcopy([envelope]))
    except ytmusic._BudgetReached as error:
        return _blocked(value, [error.reason])
    except _CampaignRecordLimit:
        return _blocked(value, ["record_limit"])
    except _NeedsReview as error:
        return _blocked(value, [str(error)], review=True)
    except Exception:
        # Do not retain/log upstream text, partial raw bodies or untrusted identities.
        # A failed uncommitted window restarts only under a new explicit campaign.
        value["position"] = value["pages"][-1]["endIndex"] if value["pages"] else 0
        value["cursor"] = value["pages"][-1]["cursorEnd"] if value["pages"] else None
        return _blocked(value, ["scan_failed"])
    finally:
        if session is not None:
            session.close()


def ack_outbox(state: CampaignState, batch_id: str, payload_digest: str) -> CampaignState:
    """ACK verified durable immutable storage only. Never call this after a POST."""
    value = validate_state(state).to_dict()
    receipt = {"batchId": batch_id, "payloadDigest": payload_digest}
    if receipt in value["acknowledged"]:
        return CampaignState(value)
    if not value["outbox"]:
        fail("no campaign window awaits storage acknowledgement")
    envelope = value["outbox"][0]
    if any(envelope[key] != receipt[key] for key in receipt):
        fail("storage acknowledgement does not match pending window")
    config, _ = _config(value["config"])
    page = _validate_envelope(envelope, value, config)
    videos = _video_fingerprints(_included_releases(envelope["releases"], value, config))
    value["pages"].append(page)
    value["seenVideos"].update(videos)
    value["acknowledged"].append(receipt)
    value["outbox"] = []
    value["status"] = "in_progress"
    if value["position"] == value["inventorySize"]:
        value["globalComplete"] = True
        value["status"] = "complete"
        value["certificate"] = _certificate(value)
    return _seal(value)


def validate_outbox(state: CampaignState, *, catalogue: dict, outbox: dict | None = None) -> list[dict]:
    """Release ONE stored window only after the entire inventory is certified.

    Host verifies every certificate blob exists/matches before its first POST, and
    keeps exact final-payload send intents. Fresh catalogue changes require a new
    intent; uncertain sends must be reconciled before any revalidation/resubmission.
    """
    value = validate_state(state).to_dict()
    _baseline(catalogue)
    if not value["globalComplete"] or value["status"] != "complete" or outbox is None:
        fail("only a globally complete campaign can release stored windows")
    config, _ = _config(value["config"])
    try:
        receipt = _validate_envelope(outbox, value, config)
        if receipt not in value["pages"]:
            fail("window does not belong to the complete campaign certificate")
        included = _included_releases(outbox["releases"], value, config)
        videos = _video_fingerprints(included)
        if any(value["seenVideos"].get(video) != digest for video, digest in videos.items()):
            fail("stored window identity does not match campaign ledger")
        result = scan_releases(included, catalogue, config)
        if not result.report["complete"] or result.report["unavailable"]:
            fail("stored window is incomplete against fresh baseline")
        return batch_manifests(result.discoveries, outbox["batchId"])
    except (KeyError, TypeError, ValueError, AttributeError, RecursionError):
        raise CatalogueSyncError("invalid or stale campaign window") from None
