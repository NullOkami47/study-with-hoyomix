from copy import deepcopy
import json

import pytest

from catalog_sync.discovery import DiscoveryConfig, batch_manifests, scan_releases, validate_manifest
from catalog_sync.normalize import CatalogueSyncError, dumps_review

CHANNEL = "UC" + "A" * 22  # Synthetic fixture ID; never an official source.


def config(**overrides):
    value = {"schemaVersion": 1, "channels": [{"id": CHANNEL, "games": []}], "albumGames": {}}
    value.update(overrides)
    return DiscoveryConfig.from_dict(value)


def release(video="abcdefghijk", title="Same Song", album="Genshin Impact - Fixture Album", **track):
    return {"artistChannelId": CHANNEL, "albumBrowseId": "MPREb_fixture", "summary": {},
            "album": {"title": album, "tracks": [{"videoId": video, "title": title, **track}]}}


def approved(video="abcdefghijk", title="Same Song"):
    return [{"id": "approved-one", "title": title, "sources": [{"provider": "youtube", "externalId": video}]}]


def test_manifest_has_only_contract_fields_and_reuses_normalization():
    item = release(title="  Same   Song  ", duration="3:42")
    item["album"]["releaseDate"] = "2026-11-06"
    result = scan_releases([item], [], config())
    manifest = batch_manifests(result.discoveries, "fixture-run")[0]
    assert set(manifest) == {"schemaVersion", "runId", "discoveries"}
    assert manifest["discoveries"] == [{"videoId": "abcdefghijk", "title": "Same Song",
        "album": "Genshin Impact - Fixture Album", "games": ["genshin"],
        "artistChannelId": CHANNEL, "albumBrowseId": "MPREb_fixture", "durationSeconds": 222,
        "releaseDate": "2026-11-06", "evidence": ["https://music.youtube.com/browse/MPREb_fixture",
        "https://music.youtube.com/channel/" + CHANNEL, "https://music.youtube.com/watch?v=abcdefghijk"]}]
    assert validate_manifest(manifest) == manifest
    assert result.report["complete"] is True
    assert b"workGroup" not in dumps_review(manifest)


def test_no_new_tracks_yields_one_empty_manifest_without_changing_catalogue():
    existing = approved()
    before = deepcopy(existing)
    result = scan_releases([release()], existing, config())
    assert batch_manifests(result.discoveries, "empty") == [{"schemaVersion": 1, "runId": "empty", "discoveries": []}]
    assert result.report["existing"] == 1
    assert result.report["complete"] is True
    assert existing == before


def test_repeated_public_tracks_are_unique_and_input_order_does_not_matter():
    items = [release(), release("zzzzzzzzzzz", "Other"), release()]
    first = scan_releases(items, [], config())
    second = scan_releases(list(reversed(items)), [], config())
    assert len(first.discoveries) == 2
    assert dumps_review(batch_manifests(first.discoveries, "repeat")[0]) == dumps_review(batch_manifests(second.discoveries, "repeat")[0])


def test_title_matching_never_merges_versions_or_different_video_ids():
    result = scan_releases([release("bbbbbbbbbbb"), release("ccccccccccc", "Same Song (Live Version)")], approved(), config())
    assert [item["videoId"] for item in result.discoveries] == ["bbbbbbbbbbb", "ccccccccccc"]
    assert all("workGroupId" not in item for item in result.discoveries)


def test_conflicting_metadata_for_same_identity_fails_closed():
    with pytest.raises(CatalogueSyncError):
        scan_releases([release(), release(title="Different")], [], config())


@pytest.mark.parametrize("track", [{"videoId": "short"}, {"title": ""}, {"duration_seconds": True},
    {"duration_seconds": -1}, {"duration": "3:99"}, {"duration_seconds": float("nan")}])
def test_bad_track_metadata_fails_closed(track):
    with pytest.raises(CatalogueSyncError):
        item = release()
        item["album"]["tracks"][0].update(track)
        scan_releases([item], [], config())


@pytest.mark.parametrize("date", ["2026", "2026-02-30", "2026-1-01", "tomorrow"])
def test_bad_or_partial_dates_are_never_fabricated(date):
    item = release()
    item["album"]["releaseDate"] = date
    result = scan_releases([item], [], config())
    assert "releaseDate" not in result.discoveries[0]
    assert "invalid_release_date" in result.report["incompleteReasons"]


def test_unknown_game_is_reported_and_ai_cannot_supply_identity():
    result = scan_releases([release(album="Unclassified Album")], [], config())
    assert result.discoveries == []
    assert result.report["complete"] is False
    assert "unclassified_game" in result.report["incompleteReasons"]


def test_games_come_from_explicit_album_mapping_then_channel_or_official_name():
    cfg = config(albumGames={"MPREb_fixture": ["zzz"]})
    assert scan_releases([release()], [], cfg).discoveries[0]["games"] == ["zzz"]
    cfg = config(channels=[{"id": CHANNEL, "games": ["hsr"]}])
    assert scan_releases([release(album="Unknown")], [], cfg).discoveries[0]["games"] == ["hsr"]
    assert scan_releases([release(album="Honkai: Star Rail - Fixture")], [], config()).discoveries[0]["games"] == ["hsr"]


def test_unavailable_tracks_are_omitted_without_pretending_they_are_new():
    result = scan_releases([release(isAvailable=False)], [], config())
    assert result.discoveries == []
    assert result.report["unavailable"] == 1


def test_batches_are_deterministic_and_each_has_at_most_100_discoveries():
    items = [release()]
    items[0]["album"]["tracks"] = [{"videoId": f"{index:011d}", "title": f"Track {index}"} for index in range(205)]
    result = scan_releases(items, [], config(), max_discoveries=201)
    batches = batch_manifests(list(reversed(result.discoveries)), "many")
    assert [len(batch["discoveries"]) for batch in batches] == [100, 100, 1]
    assert [batch["runId"] for batch in batches] == ["many-0001", "many-0002", "many-0003"]
    assert result.report["omitted"] == 4
    assert "discovery_limit" in result.report["incompleteReasons"]
    assert result.report["complete"] is False
    assert batches == batch_manifests(result.discoveries, "many")


@pytest.mark.parametrize("mutate", [
    lambda m: m.update(suggestions=[]), lambda m: m.update(schemaVersion=True),
    lambda m: m["discoveries"][0].update(cookie="secret"),
    lambda m: m["discoveries"][0].update(videoId="short"),
    lambda m: m["discoveries"][0].update(games=["guessed"]),
    lambda m: m["discoveries"][0].update(releaseDate="2026-02-30"),
    lambda m: m["discoveries"][0].update(durationSeconds=True),
    lambda m: m["discoveries"][0].update(evidence=["https://a.googlevideo.com/play?sig=secret"]),
    lambda m: m["discoveries"].append(deepcopy(m["discoveries"][0])),
    lambda m: m.update(runId="../escape"),
])
def test_manifest_validator_rejects_extra_unsafe_or_invalid_fields(mutate):
    manifest = batch_manifests(scan_releases([release()], [], config()).discoveries, "validate")[0]
    mutate(manifest)
    with pytest.raises(CatalogueSyncError):
        validate_manifest(manifest)


def test_config_refuses_unknown_fields_or_unconfirmed_channel_shapes():
    for value in [{"schemaVersion": 1, "channels": [{"id": "@HOYO-MiX", "games": []}], "albumGames": {}},
                  {"schemaVersion": 1, "channels": [], "albumGames": {}, "cookies": "secret"}]:
        with pytest.raises(CatalogueSyncError):
            DiscoveryConfig.from_dict(value)
