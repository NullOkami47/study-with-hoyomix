"""Continuation regressions: real scanner and ingestion gate, external metadata only is fake."""
from pathlib import Path

import pytest

import catalog_sync.ytmusic as module
from catalog_sync.discovery import DiscoveryConfig, scan_releases
from catalog_sync.normalize import CatalogueSyncError
from catalog_sync.transport import ingest_manifests

CHANNEL = "UC" + "A" * 22
OTHER_CHANNEL = "UC" + "B" * 22


class ReleaseInventory:
    def __init__(self, count=31):
        self.ids = ["MPREz_new"] + [f"MPREa_{i:03d}" for i in range(count - 1)]
        self.fetched = []

    def get_artist(self, channel):
        return {"albums": {"results": [{"browseId": value} for value in self.ids]}}

    def get_album(self, browse):
        self.fetched.append(browse)
        index = self.ids.index(browse)
        return {"title": "Genshin Impact - Fixture", "tracks": [
            {"videoId": f"{index:011d}", "title": f"Recording {index}"}
        ]}


def config():
    return DiscoveryConfig.from_dict({"schemaVersion": 1,
        "channels": [{"id": CHANNEL, "games": []}], "albumGames": {}})


def test_31_album_scan_resumes_bounded_work_and_only_complete_collection_can_ingest(tmp_path, monkeypatch):
    client = ReleaseInventory()
    first = module.discover_bounded_releases([CHANNEL], client=client)
    assert len(first.releases) == 30
    assert getattr(first, "next_cursor", None), "truncated scan must provide a safe continuation"
    second = module.discover_bounded_releases([CHANNEL], client=client, cursor=first.next_cursor)
    assert [r["albumBrowseId"] for r in second.releases] == ["MPREz_new"]
    assert len(set(client.fetched)) == len(client.fetched) == 31
    assert second.next_cursor is None
    assert scan_releases(second.releases, [], config(), incomplete_reasons=second.incomplete_reasons).report["complete"] is False
    merged = module.merge_bounded_releases([first, second])
    result = scan_releases(merged.releases, [], config(), incomplete_reasons=merged.incomplete_reasons)
    assert result.report["complete"] is True
    assert len(result.discoveries) == 31

    # Exercise the unchanged complete-only ingestion gate; no network or artefact writes.
    manifest = {"schemaVersion": 1, "runId": "resumed", "discoveries": result.discoveries}
    report = {**result.report, "source": "public-ytmusic", "catalogueSource": "public-api",
        "manifests": ["manifest-0001.json"]}
    monkeypatch.setattr("catalog_sync.transport.read_json", lambda path, *args:
        report if Path(path).name == "scan-report.json" else manifest)
    submitted = []
    monkeypatch.setattr("catalog_sync.transport._request", lambda *args, **kwargs: submitted.append(kwargs["data"]))
    assert ingest_manifests("https://catalogue.example", tmp_path, "fixture-token", enabled=True) == 1
    assert len(submitted) == 1
    report["complete"] = False
    with pytest.raises(CatalogueSyncError):
        ingest_manifests("https://catalogue.example", tmp_path, "fixture-token", enabled=True)
    assert len(submitted) == 1


def test_pending_pages_never_become_complete_and_a_terminal_page_cannot_stand_alone():
    client = ReleaseInventory()
    first = module.discover_bounded_releases([CHANNEL], client=client)
    assert getattr(first, "next_cursor", None)
    assert "album_limit" in module.merge_bounded_releases([first]).incomplete_reasons
    second = module.discover_bounded_releases([CHANNEL], client=client, cursor=first.next_cursor)
    with pytest.raises(module.DiscoveryError):
        module.merge_bounded_releases([second])
    with pytest.raises(module.DiscoveryError):
        module.merge_bounded_releases([first, first, second])


def test_cursor_is_bound_to_inventory_channels_and_listing_bound():
    client = ReleaseInventory()
    first = module.discover_bounded_releases([CHANNEL], client=client)
    assert getattr(first, "next_cursor", None)
    for kwargs in [{"page_limit": 99}, {"artist_channel_ids": [OTHER_CHANNEL]}]:
        channels = kwargs.pop("artist_channel_ids", [CHANNEL])
        with pytest.raises(module.DiscoveryError):
            module.discover_bounded_releases(channels, client=client, cursor=first.next_cursor, **kwargs)
    client.ids.append("MPREb_inserted")
    with pytest.raises(module.DiscoveryError):
        module.discover_bounded_releases([CHANNEL], client=client, cursor=first.next_cursor)
    assert len(client.fetched) == 30


@pytest.mark.parametrize("cursor", ["", "not-a-cursor", "x" * 1025, 1, {"offset": 30}])
def test_malformed_cursors_fail_before_fetching_any_album(cursor):
    client = ReleaseInventory()
    with pytest.raises(module.DiscoveryError):
        module.discover_bounded_releases([CHANNEL], client=client, cursor=cursor)
    assert client.fetched == []


def test_cursor_survives_reordered_listing_without_duplicate_albums():
    client = ReleaseInventory()
    first = module.discover_bounded_releases([CHANNEL], client=client)
    assert getattr(first, "next_cursor", None)
    client.ids.reverse()
    second = module.discover_bounded_releases([CHANNEL], client=client, cursor=first.next_cursor)
    assert [r["albumBrowseId"] for r in second.releases] == ["MPREz_new"]
    assert len(set(client.fetched)) == 31


def test_request_budget_resume_keeps_both_pages_bounded():
    client = ReleaseInventory(4)
    first = module.discover_bounded_releases([CHANNEL], client=client, max_api_calls=3)
    assert len(first.releases) == 2
    assert getattr(first, "next_cursor", None)
    second = module.discover_bounded_releases([CHANNEL], client=client, max_api_calls=3, cursor=first.next_cursor)
    assert first.api_calls == second.api_calls == 3
    assert len(set(client.fetched)) == len(client.fetched) == 4
    merged = module.merge_bounded_releases([first, second])
    assert merged.incomplete_reasons == []


def test_unproven_upstream_inventory_remains_incomplete_after_all_visible_pages():
    class Truncated(ReleaseInventory):
        def get_artist(self, channel):
            return {"albums": {"results": [], "params": "albums"}}
        def get_artist_albums(self, channel, params, *, limit):
            return [{"browseId": value} for value in self.ids][:limit]
    client = Truncated(4)
    first = module.discover_bounded_releases([CHANNEL], client=client, max_albums=2, page_limit=4)
    assert getattr(first, "next_cursor", None)
    second = module.discover_bounded_releases([CHANNEL], client=client, max_albums=2, page_limit=4, cursor=first.next_cursor)
    merged = module.merge_bounded_releases([first, second])
    assert merged.incomplete_reasons == ["release_page_limit"]
    assert scan_releases(merged.releases, [], config(), incomplete_reasons=merged.incomplete_reasons).report["complete"] is False


def test_one_hundred_album_scan_progresses_across_four_pages_with_stable_ids():
    client = ReleaseInventory(100)
    pages = []
    cursor = None
    for expected in [30, 30, 30, 10]:
        page = module.discover_bounded_releases([CHANNEL], client=client, cursor=cursor)
        assert len(page.releases) == expected
        assert page.api_calls <= 80
        pages.append(page)
        cursor = page.next_cursor
    assert cursor is None
    assert len(client.fetched) == len(set(client.fetched)) == 100
    merged = module.merge_bounded_releases(pages)
    result = scan_releases(merged.releases, [], config(), incomplete_reasons=merged.incomplete_reasons)
    assert result.report["complete"] is True
    assert {item["videoId"] for item in result.discoveries} == {f"{i:011d}" for i in range(100)}


def test_complete_pages_cannot_hide_missing_album_tracks():
    class MissingTracks(ReleaseInventory):
        def get_album(self, browse):
            album = super().get_album(browse)
            if browse == "MPREa_000":
                album["trackCount"] = 2
            return album
    client = MissingTracks()
    first = module.discover_bounded_releases([CHANNEL], client=client)
    second = module.discover_bounded_releases([CHANNEL], client=client, cursor=first.next_cursor)
    merged = module.merge_bounded_releases([first, second])
    assert merged.next_cursor is None
    assert merged.incomplete_reasons == ["album_tracks_incomplete"]
    assert scan_releases(merged.releases, [], config(), incomplete_reasons=merged.incomplete_reasons).report["complete"] is False


def test_combined_scan_still_refuses_more_than_one_hundred_albums():
    client = ReleaseInventory(101)
    first = module.discover_bounded_releases([CHANNEL], client=client)
    assert len(first.releases) == 30
    with pytest.raises(module.DiscoveryError, match="inventory limit"):
        module.merge_bounded_releases([first])


def test_multi_channel_discovery_deduplicates_shared_album_browse_ids_deterministically():
    class DualChannelClient:
        def __init__(self):
            self.album_calls = []

        def get_artist(self, channel):
            if channel == CHANNEL:
                return {"albums": {"results": [{"browseId": "MPREb_shared"}, {"browseId": "MPREb_primary"}]}}
            return {"albums": {"results": [{"browseId": "MPREb_shared"}, {"browseId": "MPREb_secondary"}]}}

        def get_album(self, browse):
            self.album_calls.append(browse)
            return {
                "title": "Zenless Zone Zero - Shared Fixture",
                "trackCount": 1,
                "tracks": [{"videoId": f"{len(self.album_calls):011d}", "title": browse}],
            }

    bounded_client = DualChannelClient()
    bounded = module.discover_bounded_releases([OTHER_CHANNEL, CHANNEL], client=bounded_client)
    assert [(r["albumBrowseId"], r["artistChannelId"]) for r in bounded.releases] == [
        ("MPREb_primary", CHANNEL),
        ("MPREb_secondary", OTHER_CHANNEL),
        ("MPREb_shared", CHANNEL),
    ]
    assert bounded_client.album_calls == ["MPREb_primary", "MPREb_secondary", "MPREb_shared"]

    unbounded_client = DualChannelClient()
    unbounded = module.discover_artist_releases([OTHER_CHANNEL, CHANNEL], client=unbounded_client)
    assert [(r["albumBrowseId"], r["artistChannelId"]) for r in unbounded] == [
        ("MPREb_primary", CHANNEL),
        ("MPREb_secondary", OTHER_CHANNEL),
        ("MPREb_shared", CHANNEL),
    ]
    assert unbounded_client.album_calls.count("MPREb_shared") == 1
