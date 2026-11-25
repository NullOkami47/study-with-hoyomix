"""Read public YouTube Music catalogue metadata without authentication."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

from ytmusicapi import YTMusic


class DiscoveryError(ValueError):
    """Raised when public discovery does not expose a required stable identifier."""


def _non_empty_string(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value or None


def _release_page_id(section: Mapping[str, Any], channel_id: str) -> str:
    """A release shelf can differ from the input artist and subscription channel."""
    from .discovery import BROWSE

    # Older response shapes omit the shelf ID. Retain their existing channel route,
    # but never replace an explicitly malformed returned ID with a guessed one.
    browse_id = section.get("browseId", channel_id)
    if not isinstance(browse_id, str) or not BROWSE.fullmatch(browse_id):
        raise DiscoveryError("invalid public release shelf ID")
    return browse_id


def _release_summaries(
    artist: Mapping[str, Any], channel_id: str, client: Any
) -> list[dict[str, Any]]:
    summaries: dict[str, dict[str, Any]] = {}

    for section_name in ("albums", "singles"):
        section = artist.get(section_name)
        if not isinstance(section, Mapping):
            continue

        results = section.get("results", [])
        if isinstance(results, list):
            for result in results:
                if not isinstance(result, Mapping):
                    continue
                browse_id = _non_empty_string(result.get("browseId"))
                if browse_id:
                    summaries[browse_id] = dict(result)

        params = _non_empty_string(section.get("params"))
        if params:
            page = client.get_artist_albums(_release_page_id(section, channel_id), params, limit=None)
            if not isinstance(page, list):
                raise DiscoveryError(
                    f"artist {channel_id!r} section {section_name!r} returned a non-list page"
                )
            for result in page:
                if not isinstance(result, Mapping):
                    continue
                browse_id = _non_empty_string(result.get("browseId"))
                if browse_id:
                    summaries[browse_id] = dict(result)

    return [summaries[browse_id] for browse_id in sorted(summaries)]


def discover_artist_releases(
    artist_channel_ids: Iterable[str], *, client: Any | None = None
) -> list[dict[str, Any]]:
    """Fetch each public album once and attach only discovery context.

    Production creates ``YTMusic()`` with no arguments. The optional client exists
    solely for deterministic fixtures and cannot introduce an authentication file
    or cookie option into the command-line interface.
    """

    public_client = client if client is not None else YTMusic()
    channel_ids = sorted({_non_empty_string(value) for value in artist_channel_ids} - {None})
    if not channel_ids:
        raise DiscoveryError("at least one public artist channel ID is required")

    releases: list[dict[str, Any]] = []
    seen_browse: set[str] = set()
    for channel_id in channel_ids:
        artist = public_client.get_artist(channel_id)
        if not isinstance(artist, Mapping):
            raise DiscoveryError(f"artist {channel_id!r} returned a non-object response")

        for summary in _release_summaries(artist, channel_id, public_client):
            browse_id = _non_empty_string(summary.get("browseId"))
            if browse_id is None or browse_id in seen_browse:
                continue
            seen_browse.add(browse_id)
            album = public_client.get_album(browse_id)
            if not isinstance(album, Mapping):
                raise DiscoveryError(f"album {browse_id!r} returned a non-object response")
            releases.append(
                {
                    "artistChannelId": channel_id,
                    "albumBrowseId": browse_id,
                    "summary": summary,
                    "album": dict(album),
                }
            )

    return sorted(
        releases,
        key=lambda release: (release["albumBrowseId"], release["artistChannelId"]),
    )


# Both discovery paths use the upstream shelf identity; new callers opt into bounds.
from dataclasses import dataclass
from time import monotonic
from hashlib import sha256
import base64
import binascii
import json
import re
import math

from requests import Session


class _BudgetReached(Exception):
    def __init__(self, reason: str):
        self.reason = reason


class _PublicSession(Session):
    """No ambient netrc/proxy credentials, redirects, cookies, retries or large bodies."""

    def __init__(self, maximum: int, deadline: float):
        super().__init__()
        self.trust_env = False
        self.maximum = maximum
        self.count = 0
        self.deadline = deadline

    def request(self, method, url, **kwargs):
        remaining = self.deadline - monotonic()
        if remaining <= 0:
            raise _BudgetReached("time_limit")
        if self.count >= self.maximum:
            raise _BudgetReached("request_limit")
        self.count += 1
        self.cookies.clear()
        kwargs.pop("cookies", None)
        kwargs["allow_redirects"] = False
        kwargs["timeout"] = min(15, remaining)
        kwargs["stream"] = True
        response = super().request(method, url, **kwargs)
        try:
            if response.status_code >= 300:
                raise DiscoveryError("public discovery API failed")
            chunks = []
            size = 0
            for chunk in response.iter_content(65536):
                size += len(chunk)
                if size > 8 * 1024 * 1024:
                    raise DiscoveryError("public discovery response exceeds size limit")
                if monotonic() > self.deadline:
                    raise _BudgetReached("time_limit")
                chunks.append(chunk)
            response._content = b"".join(chunks)
            response._content_consumed = True
            return response
        finally:
            response.close()
            self.cookies.clear()


@dataclass
class BoundedReleases:
    releases: list[dict[str, Any]]
    incomplete_reasons: list[str]
    api_calls: int
    cursor: str | None = None
    next_cursor: str | None = None
    inventory_id: str | None = None
    inventory_size: int = 0
    start_index: int = 0
    end_index: int = 0


def _cursor(inventory_id: str, offset: int) -> str:
    payload = json.dumps({"v": 1, "inventory": inventory_id, "offset": offset}, separators=(",", ":")).encode("ascii")
    return base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")


def _read_cursor(value: str) -> tuple[str, int]:
    # The cursor is position/scope only: no upstream URL, credentials or invented IDs.
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,512}", value):
        raise DiscoveryError("invalid discovery cursor")
    try:
        decoded = json.loads(base64.b64decode(value + "=" * (-len(value) % 4), altchars=b"-_", validate=True))
        if (not isinstance(decoded, dict) or set(decoded) != {"v", "inventory", "offset"}
                or type(decoded["v"]) is not int or decoded["v"] != 1
                or not isinstance(decoded["inventory"], str) or not re.fullmatch(r"[a-f0-9]{64}", decoded["inventory"])
                or type(decoded["offset"]) is not int or not 0 <= decoded["offset"] <= 1000
                or _cursor(decoded["inventory"], decoded["offset"]) != value):
            raise ValueError()
        return decoded["inventory"], decoded["offset"]
    except (ValueError, TypeError, UnicodeError, binascii.Error):
        raise DiscoveryError("invalid discovery cursor") from None


def merge_bounded_releases(pages: list[BoundedReleases]) -> BoundedReleases:
    """Merge one contiguous scan. A final page alone never proves a complete inventory.

    Callers retain every page, resume next_cursor, and only submit this merged result.
    The existing 100-album normalisation ceiling remains a whole-scan bound.
    """
    if not isinstance(pages, list) or not 1 <= len(pages) <= 100:
        raise DiscoveryError("invalid discovery pages")
    inventory_id = pages[0].inventory_id
    size = pages[0].inventory_size
    if not inventory_id or not 0 <= size <= 100:
        raise DiscoveryError("combined discovery exceeds inventory limit")
    releases: list[dict[str, Any]] = []
    reasons: set[str] = set()
    expected_cursor = None
    position = 0
    seen = set()
    calls = 0
    for index, page in enumerate(pages):
        if (page.inventory_id != inventory_id or page.inventory_size != size
                or page.cursor != expected_cursor or page.start_index != position
                or not position <= page.end_index <= size
                or (index and expected_cursor is None)
                or len(page.releases) > page.end_index - position):
            raise DiscoveryError("discovery pages are not contiguous")
        if page.next_cursor is not None:
            scope, offset = _read_cursor(page.next_cursor)
            if scope != inventory_id or offset != page.end_index or offset >= size:
                raise DiscoveryError("invalid discovery page cursor")
        elif page.end_index != size:
            raise DiscoveryError("discovery page is missing its continuation")
        for release in page.releases:
            identity = (release["albumBrowseId"], release["artistChannelId"])
            if identity in seen:
                raise DiscoveryError("duplicate discovery album across pages")
            seen.add(identity)
            releases.append(release)
        reasons.update(page.incomplete_reasons)
        calls += page.api_calls
        position = page.end_index
        expected_cursor = page.next_cursor
    if position == size and expected_cursor is None:
        # Only proven contiguous exhaustion resolves transport/work budgets.
        reasons.difference_update({"album_limit", "request_limit", "time_limit", "continuation_requires_merge"})
    else:
        reasons.add("album_limit")
    if len(releases) != position:
        reasons.add("album_tracks_incomplete")
    return BoundedReleases(releases, sorted(reasons), calls, next_cursor=expected_cursor,
                           inventory_id=inventory_id, inventory_size=size, end_index=position)


def discover_bounded_releases(artist_channel_ids: Iterable[str], *, client: Any | None = None,
                             max_albums: int = 30, page_limit: int = 100,
                             max_api_calls: int = 80, max_seconds: int = 240,
                             cursor: str | None = None, deadline: float | None = None) -> BoundedReleases:
    from .discovery import BROWSE, CHANNEL

    bounds = ((max_albums, 100), (page_limit, 100), (max_api_calls, 200), (max_seconds, 300))
    if any(type(value) is not int or not 1 <= value <= cap for value, cap in bounds):
        raise DiscoveryError("invalid discovery limits")
    channels = sorted(set(artist_channel_ids))
    if not channels or len(channels) > 4 or any(not isinstance(value, str) or not CHANNEL.fullmatch(value) for value in channels):
        raise DiscoveryError("one to four explicit public channel IDs are required")
    continuation = _read_cursor(cursor) if cursor is not None else None
    if deadline is not None and (type(deadline) not in (int, float) or not math.isfinite(deadline)):
        raise DiscoveryError("invalid discovery deadline")
    deadline = min(monotonic() + max_seconds, deadline) if deadline is not None else monotonic() + max_seconds
    session = _PublicSession(max_api_calls, deadline)
    calls = 0
    releases = []
    reasons: set[str] = set()
    inventory_id = None
    ordered: list[tuple[str, str]] = []
    start = position = 0
    try:
        public = client if client is not None else YTMusic(requests_session=session)

        def call(method, *args, **kwargs):
            nonlocal calls
            if monotonic() >= deadline:
                raise _BudgetReached("time_limit")
            if calls >= max_api_calls:
                raise _BudgetReached("request_limit")
            calls += 1
            return method(*args, **kwargs)

        seen_browse: set[str] = set()
        summaries: dict[tuple[str, str], dict] = {}
        for channel in channels:
            channel_browse: set[str] = set()
            artist = call(public.get_artist, channel)
            if not isinstance(artist, Mapping):
                raise DiscoveryError("invalid public artist metadata")
            for section_name in ("albums", "singles"):
                section = artist.get(section_name)
                if section is None:
                    continue
                if not isinstance(section, Mapping):
                    raise DiscoveryError("invalid public release section")
                results = section.get("results", [])
                if not isinstance(results, list):
                    raise DiscoveryError("invalid public release list")
                params = _non_empty_string(section.get("params"))
                if params:
                    page = call(public.get_artist_albums, _release_page_id(section, channel), params, limit=page_limit)
                    if not isinstance(page, list):
                        raise DiscoveryError("invalid public release page")
                    if len(page) >= page_limit:
                        reasons.add("release_page_limit")
                    results = results + page[:page_limit]
                for result in results:
                    if not isinstance(result, Mapping):
                        raise DiscoveryError("invalid public release summary")
                    browse = result.get("browseId")
                    if not isinstance(browse, str) or not BROWSE.fullmatch(browse):
                        raise DiscoveryError("public release is missing a stable album ID")
                    if browse in seen_browse:
                        continue
                    summaries[(browse, channel)] = dict(result)
                    channel_browse.add(browse)
            seen_browse.update(channel_browse)
        ordered = sorted(summaries)
        inventory_id = sha256(json.dumps([channels, page_limit, ordered], separators=(",", ":")).encode("utf-8")).hexdigest()
        if continuation:
            scope, start = continuation
            if scope != inventory_id or start >= len(ordered):
                raise DiscoveryError("stale or out-of-scope discovery cursor")
        position = start
        if len(ordered) - start > max_albums:
            reasons.add("album_limit")
        for browse, channel in ordered[start:start + max_albums]:
            album = call(public.get_album, browse)
            if not isinstance(album, Mapping) or not isinstance(album.get("tracks"), list):
                raise DiscoveryError("invalid public album metadata")
            if len(album["tracks"]) > 1000:
                reasons.add("album_track_limit")
                position += 1
                continue
            if album.get("trackCount") is not None and album["trackCount"] != len(album["tracks"]):
                reasons.add("album_tracks_incomplete")
            releases.append({"artistChannelId": channel, "albumBrowseId": browse,
                             "summary": summaries[(browse, channel)], "album": dict(album)})
            position += 1
    except _BudgetReached as error:
        reasons.add(error.reason)
    except Exception:
        raise DiscoveryError("public discovery API failed") from None
    finally:
        session.close()
    if cursor is not None:
        reasons.add("continuation_requires_merge")
    next_cursor = _cursor(inventory_id, position) if inventory_id is not None and position < len(ordered) else None
    return BoundedReleases(releases, sorted(reasons), session.count if client is None else calls,
                           cursor, next_cursor, inventory_id, len(ordered), start, position)
