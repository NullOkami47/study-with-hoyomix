from __future__ import annotations

import ast
import json
from argparse import Namespace
from copy import deepcopy
from pathlib import Path

import pytest

import catalog_sync.__main__ as catalog_sync_main
import catalog_sync.ytmusic as ytmusic_module
from catalog_sync.__main__ import run
from catalog_sync.normalize import (
    UnsafeReviewPayload,
    build_review,
    dumps_review,
    normalize_discovery,
)
from catalog_sync.ytmusic import discover_artist_releases


@pytest.fixture
def artist_page() -> dict:
    return {
        "albums": {
            "results": [
                {
                    "browseId": "MPREb_album_b",
                    "title": "Second Album",
                    "playlistId": "OLAK5uy_album_b",
                }
            ],
            "browseId": "UC_HOYOMIX_ALBUMS",
            "params": "albums-page-token",
        },
        "singles": {
            "results": [
                {"browseId": "MPREb_single", "title": "A Single"},
            ],
            "browseId": "UC_HOYOMIX_SINGLES",
            "params": "singles-page-token",
        },
    }


@pytest.fixture
def album_pages() -> dict[str, list[dict]]:
    return {
        "albums-page-token": [
            {"browseId": "MPREb_album_a", "title": "First Album"},
            {"browseId": "MPREb_album_b", "title": "Second Album"},
        ],
        "singles-page-token": [
            {"browseId": "MPREb_single", "title": "A Single"},
        ],
    }


@pytest.fixture
def album_details() -> dict[str, dict]:
    return {
        "MPREb_album_a": {
            "title": "First Album",
            "audioPlaylistId": "OLAK5uy_album_a",
            "tracks": [
                {
                    "videoId": "video-live",
                    "title": "Moon in One's Cup (Live Version)",
                    "duration_seconds": 245,
                    "isAvailable": True,
                },
                {
                    "videoId": "video-original",
                    "title": "  Moon in One's Cup  ",
                    "duration": "3:42",
                },
            ],
        },
        "MPREb_album_b": {
            "title": "Second Album",
            "tracks": [
                {
                    "videoId": "video-unavailable",
                    "title": "Forgotten Song",
                    "isAvailable": False,
                }
            ],
        },
        "MPREb_single": {
            "title": "A Single",
            "tracks": [
                {
                    "videoId": "video-single",
                    "title": "Interstellar Journey",
                    "duration": "1:02:03",
                }
            ],
        },
    }


class FakeYTMusic:
    def __init__(self, artist_page: dict, album_pages: dict, album_details: dict):
        self.artist_page = artist_page
        self.album_pages = album_pages
        self.album_details = album_details
        self.artist_album_calls: list[tuple[str, str, int | None]] = []
        self.album_calls: list[str] = []

    def get_artist(self, channel_id: str) -> dict:
        assert channel_id == "UC_HOYOMIX"
        return deepcopy(self.artist_page)

    def get_artist_albums(
        self, channel_id: str, params: str, *, limit: int | None = 100
    ) -> list[dict]:
        self.artist_album_calls.append((channel_id, params, limit))
        return deepcopy(self.album_pages[params])

    def get_album(self, browse_id: str) -> dict:
        self.album_calls.append(browse_id)
        return deepcopy(self.album_details[browse_id])


def test_production_discovery_constructs_ytmusic_without_authentication(monkeypatch) -> None:
    constructor_calls: list[tuple[tuple, dict]] = []

    class PublicClient:
        def __init__(self, *args, **kwargs):
            constructor_calls.append((args, kwargs))

        def get_artist(self, channel_id: str) -> dict:
            return {}

    monkeypatch.setattr(ytmusic_module, "YTMusic", PublicClient)

    assert discover_artist_releases(["UC_PUBLIC"]) == []
    assert constructor_calls == [((), {})]


def test_discovers_all_paginated_album_sections_once(
    artist_page: dict,
    album_pages: dict,
    album_details: dict,
) -> None:
    client = FakeYTMusic(artist_page, album_pages, album_details)

    releases = discover_artist_releases(["UC_HOYOMIX"], client=client)

    assert client.artist_album_calls == [
        ("UC_HOYOMIX_ALBUMS", "albums-page-token", None),
        ("UC_HOYOMIX_SINGLES", "singles-page-token", None),
    ]
    assert client.album_calls == ["MPREb_album_a", "MPREb_album_b", "MPREb_single"]
    assert [release["albumBrowseId"] for release in releases] == [
        "MPREb_album_a",
        "MPREb_album_b",
        "MPREb_single",
    ]


def test_normalizes_tracks_and_emits_version_grouping_candidates(
    artist_page: dict,
    album_pages: dict,
    album_details: dict,
) -> None:
    client = FakeYTMusic(artist_page, album_pages, album_details)
    discovered = normalize_discovery(
        discover_artist_releases(["UC_HOYOMIX"], client=client)
    )

    by_id = {track["stableId"]: track for track in discovered}
    assert by_id["youtube:video-original"]["title"] == "Moon in One's Cup"
    assert by_id["youtube:video-original"]["durationSeconds"] == 222
    assert by_id["youtube:video-single"]["durationSeconds"] == 3723
    assert by_id["youtube:video-live"]["workGroupCandidate"] == by_id[
        "youtube:video-original"
    ]["workGroupCandidate"]
    assert by_id["youtube:video-live"]["workGroupCandidateTitle"] == "Moon in One's Cup"


def test_unavailable_tracks_are_retained_for_review(
    artist_page: dict,
    album_pages: dict,
    album_details: dict,
) -> None:
    client = FakeYTMusic(artist_page, album_pages, album_details)
    discovered = normalize_discovery(
        discover_artist_releases(["UC_HOYOMIX"], client=client)
    )

    review = build_review(discovered, approved_catalogue=[])

    unavailable = next(
        change for change in review["changes"] if change["stableId"] == "youtube:video-unavailable"
    )
    assert unavailable["kind"] == "unavailable"
    assert unavailable["metadataDiff"]["after"]["available"] is False


def test_existing_manual_taxonomy_and_non_youtube_sources_are_preserved() -> None:
    approved = [
        {
            "id": "manual-track-id",
            "title": "Old official title",
            "aliases": {"zh-Hant": ["人工別名"]},
            "games": ["genshin"],
            "relationIds": ["place:liyue"],
            "tabs": ["focus", "sleep"],
            "workGroupId": "work:maintainer-approved",
            "needsClassification": False,
            "sources": [
                {
                    "provider": "youtube",
                    "externalId": "video-original",
                    "metadata": {"albumBrowseId": "MPREb_old"},
                },
                {
                    "provider": "r2",
                    "externalId": "authorised/manual-track.ogg",
                    "metadata": {"contentType": "audio/ogg"},
                },
            ],
        }
    ]
    discovered = [
        {
            "stableId": "youtube:video-original",
            "videoId": "video-original",
            "title": "Moon in One's Cup",
            "artistChannelId": "UC_HOYOMIX",
            "albumBrowseId": "MPREb_album_a",
            "albumTitle": "First Album",
            "playlistId": "OLAK5uy_album_a",
            "durationSeconds": 222,
            "available": True,
            "workGroupCandidate": "candidate:ignored-for-existing-track",
            "workGroupCandidateTitle": "Moon in One's Cup",
        }
    ]

    review = build_review(discovered, approved)

    candidate = review["changes"][0]["catalogueCandidate"]
    assert candidate["title"] == "Moon in One's Cup"
    assert candidate["aliases"] == {"zh-Hant": ["人工別名"]}
    assert candidate["games"] == ["genshin"]
    assert candidate["relationIds"] == ["place:liyue"]
    assert candidate["tabs"] == ["focus", "sleep"]
    assert candidate["workGroupId"] == "work:maintainer-approved"
    assert candidate["needsClassification"] is False
    assert candidate["sources"][1] == approved[0]["sources"][1]


def test_output_is_byte_identical_and_sorted_for_the_same_fixture() -> None:
    discovered = [
        {
            "stableId": f"youtube:{video_id}",
            "videoId": video_id,
            "title": title,
            "artistChannelId": "UC_HOYOMIX",
            "albumBrowseId": "MPREb_album",
            "albumTitle": "Album",
            "available": True,
            "workGroupCandidate": f"candidate:{video_id}",
            "workGroupCandidateTitle": title,
        }
        for video_id, title in [("z-video", "Zed"), ("a-video", "Alpha")]
    ]

    first = dumps_review(build_review(discovered, []))
    second = dumps_review(build_review(list(reversed(discovered)), []))

    assert first == second
    assert first.endswith(b"\n")
    payload = json.loads(first)
    assert [change["stableId"] for change in payload["changes"]] == [
        "youtube:a-video",
        "youtube:z-video",
    ]


@pytest.mark.parametrize(
    "unsafe_value",
    [
        {"streamingData": {"adaptiveFormats": []}},
        {"cookies": "SID=secret"},
        {"headers": {"Authorization": "Bearer secret"}},
        {"url": "https://example.googlevideo.com/videoplayback?expire=1"},
        {
            "nested": {
                "url": "https://rr1---sn.example.googlevideo.com/media?id=abc&expire=9999999999&sig=secret"
            }
        },
        {
            "source": {
                "url": (
                    "https://catalogue.r2.example/track.ogg?"
                    "X-Amz-Algorithm=AWS4-HMAC-SHA256&"
                    "X-Amz-Credential=secret&X-Amz-Expires=900&"
                    "X-Amz-Security-Token=token&X-Amz-Signature=signature"
                )
            }
        },
        {
            "source": {
                "url": (
                    "https://storage.googleapis.example/track.ogg?"
                    "X-Goog-Algorithm=GOOG4-RSA-SHA256&"
                    "X-Goog-Credential=secret&X-Goog-Expires=900&"
                    "X-Goog-Signature=signature"
                )
            }
        },
    ],
)
def test_serializer_rejects_sensitive_or_short_lived_media_data(unsafe_value: dict) -> None:
    with pytest.raises(UnsafeReviewPayload):
        dumps_review({"schemaVersion": 1, "changes": [unsafe_value]})


def test_cli_writes_only_a_new_review_file_and_never_overwrites_catalogue(
    monkeypatch, tmp_path: Path
) -> None:
    approved_path = tmp_path / "catalog.json"
    approved_bytes = b"[]\n"
    approved_path.write_bytes(approved_bytes)
    review_dir = tmp_path / "review"
    discovered = [
        {
            "stableId": "youtube:fixture-video",
            "videoId": "fixture-video",
            "title": "Fixture Track",
            "artistChannelId": "UC_PUBLIC",
            "albumBrowseId": "MPREb_fixture",
            "albumTitle": "Fixture Album",
            "available": True,
            "workGroupCandidate": "candidate:fixture",
            "workGroupCandidateTitle": "Fixture Track",
        }
    ]
    monkeypatch.setattr(catalog_sync_main, "discover_artist_releases", lambda _: [])
    monkeypatch.setattr(catalog_sync_main, "normalize_discovery", lambda _: discovered)
    args = Namespace(
        artist_channel_id=["UC_PUBLIC"],
        catalogue=approved_path,
        review_dir=review_dir,
        timestamp="20260810T120000Z",
    )

    output_path = run(args)

    assert output_path == (review_dir / "20260810T120000Z.json").resolve()
    assert approved_path.read_bytes() == approved_bytes
    assert json.loads(output_path.read_bytes())["changes"][0]["stableId"] == (
        "youtube:fixture-video"
    )
    with pytest.raises(FileExistsError):
        run(args)
    assert approved_path.read_bytes() == approved_bytes


def test_cli_module_does_not_import_python_311_datetime_utc() -> None:
    source_path = Path(catalog_sync_main.__file__)
    tree = ast.parse(source_path.read_text(encoding="utf-8"), feature_version=(3, 10))

    datetime_imports = {
        alias.name
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom) and node.module == "datetime"
        for alias in node.names
    }
    assert "UTC" not in datetime_imports
