"""Bounded, deterministic discovery contract; no catalogue writes or identity guesses."""
from __future__ import annotations

import math
import re
from dataclasses import dataclass
from datetime import date
from typing import Any, Mapping, Sequence

from .normalize import CatalogueSyncError, dumps_review, normalize_discovery

VIDEO = re.compile(r"[A-Za-z0-9_-]{11}", re.ASCII)
CHANNEL = re.compile(r"UC[A-Za-z0-9_-]{22}", re.ASCII)
BROWSE = re.compile(r"[A-Za-z0-9_-]{3,160}", re.ASCII)
RUN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,119}", re.ASCII)
GAMES = {"genshin", "hsr", "zzz"}
GAME_NAMES = {"genshin": ("genshin impact", "原神"),
              "hsr": ("honkai: star rail", "honkai：star rail", "崩壞：星穹鐵道", "崩坏：星穹铁道"),
              "zzz": ("zenless zone zero", "絕區零", "绝区零")}


def fail(message: str) -> None:
    raise CatalogueSyncError(message)


def text(value: Any, field: str, maximum: int = 512) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        fail(field + " must be bounded non-empty text")
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        fail(field + " contains control characters")
    if re.search(r"(?i)(?:bearer\s+|(?:cookie|token|authorization|api[_-]?key)\s*[:=])", value):
        fail(field + " contains credential-like text")
    return value


def identifier(value: Any, pattern: re.Pattern, field: str) -> str:
    if not isinstance(value, str) or not pattern.fullmatch(value):
        fail(field + " is invalid")
    return value


def keys(value: Any, required: set[str], optional: set[str] | None = None) -> dict:
    if not isinstance(value, dict) or not required <= value.keys() or value.keys() - required - (optional or set()):
        fail("object has missing or unknown fields")
    return value


def string_list(value: Any, field: str, allowed: set[str] | None = None, maximum: int = 32) -> list[str]:
    if not isinstance(value, list) or len(value) > maximum:
        fail(field + " must be a bounded list")
    for item in value:
        text(item, field, 1024)
        if allowed is not None and item not in allowed:
            fail(field + " contains an unknown value")
    if len(set(value)) != len(value):
        fail(field + " contains duplicate values")
    return sorted(value)


def full_date(value: Any) -> bool:
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value):
        return False
    try:
        date.fromisoformat(value)
    except ValueError:
        return False
    return True


@dataclass(frozen=True)
class DiscoveryConfig:
    channels: dict[str, list[str]]
    album_games: dict[str, list[str]]

    @classmethod
    def from_dict(cls, value: Any) -> DiscoveryConfig:
        keys(value, {"schemaVersion", "channels", "albumGames"})
        if type(value["schemaVersion"]) is not int or value["schemaVersion"] != 1:
            fail("unsupported config schemaVersion")
        channels = value["channels"]
        albums = value["albumGames"]
        if not isinstance(channels, list) or len(channels) > 4 or not isinstance(albums, dict) or len(albums) > 1000:
            fail("config exceeds channel or album limit")
        channel_games = {}
        for channel in channels:
            keys(channel, {"id", "games"})
            channel_id = identifier(channel["id"], CHANNEL, "channel ID")
            if channel_id in channel_games:
                fail("duplicate configured channel")
            channel_games[channel_id] = string_list(channel["games"], "games", GAMES, 3)
        album_games = {}
        for browse_id, games in albums.items():
            identifier(browse_id, BROWSE, "album browse ID")
            album_games[browse_id] = string_list(games, "games", GAMES, 3)
            if not games:
                fail("explicit album games cannot be empty")
        dumps_review(value)
        return cls(channel_games, album_games)

    def games_for(self, channel: str, browse_id: str, album: str) -> list[str]:
        if browse_id in self.album_games:
            return self.album_games[browse_id][:]
        if self.channels.get(channel):
            return self.channels[channel][:]
        folded = album.casefold()
        return sorted(game for game, names in GAME_NAMES.items() if any(
            (name in folded if not name.isascii() else re.search(r"(?<![a-z0-9])" + re.escape(name) + r"(?![a-z0-9])", folded))
            for name in names))


@dataclass
class ScanResult:
    discoveries: list[dict[str, Any]]
    report: dict[str, Any]


def known_video_ids(catalogue: Any) -> set[str]:
    if isinstance(catalogue, dict):
        if "tracks" not in catalogue:
            fail("public catalogue has no tracks")
        catalogue = catalogue["tracks"]
    if not isinstance(catalogue, list) or len(catalogue) > 10000:
        fail("catalogue must contain at most 10000 tracks")
    known = set()
    for track in catalogue:
        if not isinstance(track, dict) or not isinstance(track.get("sources"), list):
            fail("catalogue track has invalid sources")
        for source in track["sources"]:
            if not isinstance(source, dict):
                fail("catalogue source must be an object")
            if source.get("provider") == "youtube":
                known.add(identifier(source.get("externalId"), VIDEO, "existing videoId"))
    return known


def validate_manifest(value: Any) -> dict:
    keys(value, {"schemaVersion", "runId", "discoveries"})
    if type(value["schemaVersion"]) is not int or value["schemaVersion"] != 1:
        fail("unsupported manifest schemaVersion")
    identifier(value["runId"], RUN, "runId")
    discoveries = value["discoveries"]
    if not isinstance(discoveries, list) or len(discoveries) > 100:
        fail("manifest discoveries must contain at most 100 items")
    seen = set()
    for item in discoveries:
        keys(item, {"videoId", "title", "album", "games", "artistChannelId", "albumBrowseId", "evidence"},
             {"releaseDate", "durationSeconds"})
        video = identifier(item["videoId"], VIDEO, "videoId")
        if video in seen:
            fail("duplicate discovery identity")
        seen.add(video)
        text(item["title"], "title")
        text(item["album"], "album")
        games = string_list(item["games"], "games", GAMES, 3)
        if not games:
            fail("discovery requires at least one explicit game")
        identifier(item["artistChannelId"], CHANNEL, "artistChannelId")
        identifier(item["albumBrowseId"], BROWSE, "albumBrowseId")
        if not string_list(item["evidence"], "evidence", maximum=16):
            fail("discovery requires evidence")
        if "releaseDate" in item and not full_date(item["releaseDate"]):
            fail("releaseDate must be a full calendar date")
        if "durationSeconds" in item:
            seconds = item["durationSeconds"]
            if type(seconds) not in (int, float) or not math.isfinite(seconds) or not 0 <= seconds <= 86400:
                fail("invalid durationSeconds")
    dumps_review(value)
    return value


def scan_releases(releases: Sequence[Mapping[str, Any]], catalogue: Any, config: DiscoveryConfig,
                  *, max_discoveries: int = 1000, incomplete_reasons: Sequence[str] = ()) -> ScanResult:
    if type(max_discoveries) is not int or not 1 <= max_discoveries <= 1000:
        fail("max_discoveries must be between 1 and 1000")
    if not isinstance(releases, list) or len(releases) > 100:
        fail("release input must contain at most 100 albums")
    known = known_video_ids(catalogue)
    reasons = set(incomplete_reasons)
    dates = {}
    for release in releases:
        if not isinstance(release, dict):
            fail("release must be an object")
        channel = identifier(release.get("artistChannelId"), CHANNEL, "artistChannelId")
        if channel not in config.channels:
            fail("release channel is not explicitly configured")
        browse = identifier(release.get("albumBrowseId"), BROWSE, "albumBrowseId")
        album = release.get("album")
        if not isinstance(album, dict) or not isinstance(album.get("tracks"), list) or len(album["tracks"]) > 1000:
            fail("album must contain at most 1000 tracks")
        raw_date = album.get("releaseDate")
        if raw_date is not None:
            if full_date(raw_date):
                if browse in dates and dates[browse] != raw_date:
                    fail("conflicting album release dates")
                dates[browse] = raw_date
            else:
                reasons.add("invalid_release_date")
        for track in album["tracks"]:
            if not isinstance(track, dict):
                fail("track must be an object")
            identifier(track.get("videoId"), VIDEO, "videoId")
            if "duration_seconds" in track:
                seconds = track["duration_seconds"]
                if isinstance(seconds, str) and seconds.isdigit():
                    seconds = int(seconds)
                if type(seconds) is not int or not 0 <= seconds <= 86400:
                    fail("invalid duration_seconds")
            elif "duration" in track:
                duration = track["duration"]
                if not isinstance(duration, str) or not re.fullmatch(r"[0-9]{1,2}:[0-5][0-9](?::[0-5][0-9])?", duration):
                    fail("invalid duration")
    normalised = normalize_discovery(releases)
    discoveries = []
    existing = unavailable = 0
    for item in normalised:
        if item["videoId"] in known:
            existing += 1
            continue
        if not item["available"]:
            unavailable += 1
            continue
        games = config.games_for(item["artistChannelId"], item["albumBrowseId"], item["albumTitle"])
        if not games:
            reasons.add("unclassified_game")
            continue
        video, channel, browse = item["videoId"], item["artistChannelId"], item["albumBrowseId"]
        discovery = {"videoId": video, "title": item["title"], "album": item["albumTitle"], "games": games,
                     "artistChannelId": channel, "albumBrowseId": browse,
                     "evidence": ["https://music.youtube.com/browse/" + browse,
                                  "https://music.youtube.com/channel/" + channel,
                                  "https://music.youtube.com/watch?v=" + video]}
        if "durationSeconds" in item:
            discovery["durationSeconds"] = item["durationSeconds"]
        if browse in dates:
            discovery["releaseDate"] = dates[browse]
        validate_manifest({"schemaVersion": 1, "runId": "validation", "discoveries": [discovery]})
        discoveries.append(discovery)
    omitted = max(0, len(discoveries) - max_discoveries)
    if omitted:
        reasons.add("discovery_limit")
    return ScanResult(discoveries[:max_discoveries], {"schemaVersion": 1, "complete": not reasons,
        "incompleteReasons": sorted(reasons), "existing": existing, "unavailable": unavailable,
        "scannedAlbums": len(releases), "scannedUniqueTracks": len(normalised),
        "discovered": min(len(discoveries), max_discoveries), "omitted": omitted,
        "limits": {"maxDiscoveries": max_discoveries, "manifestSize": 100}})


def batch_manifests(discoveries: Sequence[dict], run_id: str) -> list[dict]:
    identifier(run_id, RUN, "runId")
    if len(run_id) > 110 or len(discoveries) > 1000:
        fail("batch input exceeds limits")
    ordered = sorted(discoveries, key=lambda item: item["videoId"])
    if len({item["videoId"] for item in ordered}) != len(ordered):
        fail("duplicate discovery identity")
    count = max(1, (len(ordered) + 99) // 100)
    return [validate_manifest({"schemaVersion": 1, "runId": run_id if count == 1 else f"{run_id}-{index + 1:04d}",
                              "discoveries": ordered[index * 100:(index + 1) * 100]})
            for index in range(count)]
