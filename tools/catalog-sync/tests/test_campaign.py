"""Campaign contract tests: real scanner/normaliser, synthetic public metadata only."""
from copy import deepcopy
import importlib.util
import json

import pytest

from catalog_sync.discovery import DiscoveryConfig
from catalog_sync.normalize import CatalogueSyncError
from test_discovery import CHANNEL


def core():
    assert importlib.util.find_spec("catalog_sync.campaign"), "finite campaign coordinator is missing"
    from catalog_sync import campaign
    return campaign


def config():
    return DiscoveryConfig.from_dict({"schemaVersion": 1, "channels": [
        {"id": CHANNEL, "games": []}], "albumGames": {}})


def baseline(*videos, revision="1"):
    return {"revision": revision, "tracks": [{"sources": [
        {"provider": "youtube", "externalId": video}]} for video in videos]}


class Inventory:
    def __init__(self, count=154, tracks=1):
        self.ids = [f"MPREb_{i:03d}" for i in range(count)]
        self.tracks = tracks
        self.fetched = []
        self.album_title = "Genshin Impact - Official fixture"
        self.track_count_delta = 0
        self.track_title_size = 0
        self.fail_at = None
        self.on_album = None

    def get_artist(self, channel):
        # Mirrors 83 albums +71 singles in the observed finite inventory.
        return {"albums": {"results": [{"browseId": x} for x in self.ids[:83]]},
                "singles": {"results": [{"browseId": x} for x in self.ids[83:]]}}

    def get_artist_albums(self, channel, params, *, limit):
        return []

    def get_album(self, browse):
        if browse == self.fail_at:
            raise KeyboardInterrupt()
        self.fetched.append(browse)
        if self.on_album:
            self.on_album()
        i = int(browse.rsplit("_", 1)[1])
        return {"title": self.album_title, "releaseDate": "2026-11-15",
                "trackCount": self.tracks + self.track_count_delta,
                "tracks": [{"videoId": f"{i * 1000 + t:011d}",
                            "title": ("R" * self.track_title_size if self.track_title_size else f"Recording {t} (Live)"),
                            "duration_seconds": 120}
                           for t in range(self.tracks)]}


def start(**kwargs):
    return core().start_campaign(config(), "https://catalogue.example", "weekly-20261115",
                                 "2026-11-15T00:00:00Z", **kwargs)


def advance(state, client, catalogue=None, **kwargs):
    return core().advance_campaign(state, catalogue=catalogue or baseline(), client=client, **kwargs)


def store(state, blobs):
    c = core()
    envelope = state.to_dict()["outbox"][0]
    assert envelope["provisional"] is True
    assert envelope["globalComplete"] is False
    blobs.append(deepcopy(envelope))
    return c.ack_outbox(state, envelope["batchId"], envelope["payloadDigest"])


def finish(client, **kwargs):
    state, blobs = start(**kwargs), []
    for _ in range(32):
        result = advance(state, client)
        state = core().CampaignState.from_json(result.checkpoint.to_json())
        if result.outbox:
            state = store(state, blobs)
        if state.to_dict()["status"] in {"complete", "blocked", "pending_review"}:
            return state, blobs
    pytest.fail("finite coordinator did not terminate")


def test_154_releases_survive_process_restarts_and_only_global_certificate_releases_batches():
    c, client, state, blobs = core(), Inventory(), start(), []
    for n in range(6):
        result = advance(c.CampaignState.from_json(state.to_json()), client)
        state = result.checkpoint
        assert result.status == "outbox_pending"
        assert result.outbox[0]["startIndex"] == n * 30
        assert result.outbox[0]["endIndex"] == min(154, (n + 1) * 30)
        assert result.outbox[0]["pageComplete"] is True
        with pytest.raises(CatalogueSyncError):
            c.validate_outbox(state, catalogue=baseline(), outbox=result.outbox[0])
        # Crash after emitting but before storage ACK: no extra album fetched, exact same outbox.
        fetched = client.fetched[:]
        repeated = advance(c.CampaignState.from_json(state.to_json()), client)
        assert repeated.outbox == result.outbox
        assert client.fetched == fetched
        state = store(state, blobs)
        assert state.to_dict()["globalComplete"] is (n == 5)
    assert client.fetched == client.ids
    assert len(state.to_dict()["certificate"]["windows"]) == 6
    assert state.to_dict()["outbox"] == []
    emitted = [d for blob in blobs for m in c.validate_outbox(state, catalogue=baseline(), outbox=blob)
               for d in m["discoveries"]]
    assert len(emitted) == len({d["videoId"] for d in emitted}) == 154
    assert all("(Live)" in d["title"] for d in emitted)
    assert all(d["albumBrowseId"] in client.ids for d in emitted)


def test_interrupted_uncommitted_window_restarts_without_replaying_stored_prefix():
    client, blobs = Inventory(), []
    state = store(advance(start(), client).checkpoint, blobs)
    client.fail_at = "MPREb_033"
    saved = state.to_json()
    with pytest.raises(KeyboardInterrupt):
        advance(state, client)
    assert state.to_json() == saved
    client.fail_at = None
    result = advance(core().CampaignState.from_json(saved), client)
    assert result.outbox[0]["startIndex"] == 30
    assert client.fetched.count("MPREb_000") == 1


def test_resume_and_final_drain_use_fresh_catalogue_and_never_rewrite_immutable_blob():
    c, client, state, blobs = core(), Inventory(31), start(), []
    state = store(advance(state, client).checkpoint, blobs)
    known = "00000030000"
    state = store(advance(state, client, baseline(known, revision="2")).checkpoint, blobs)
    before = deepcopy(blobs)
    assert c.validate_outbox(state, catalogue=baseline("00000000000", revision="3"), outbox=blobs[0])[0]["discoveries"][0]["videoId"] == "00000001000"
    # A track removed from the fresh catalogue is recovered from stable per-window metadata.
    assert c.validate_outbox(state, catalogue=baseline(revision="4"), outbox=blobs[1])[0]["discoveries"][0]["videoId"] == known
    assert blobs == before


def test_storage_ack_is_exact_idempotent_and_does_not_grant_ingestion_authority():
    c, state, blobs = core(), advance(start(), Inventory()).checkpoint, []
    envelope = state.to_dict()["outbox"][0]
    with pytest.raises(CatalogueSyncError):
        c.ack_outbox(state, envelope["batchId"], "0" * 64)
    stored = store(state, blobs)
    assert c.ack_outbox(stored, envelope["batchId"], envelope["payloadDigest"]).to_json() == stored.to_json()
    assert stored.to_dict()["certificate"] is None
    with pytest.raises(CatalogueSyncError):
        c.validate_outbox(stored, catalogue=baseline(), outbox=envelope)


@pytest.mark.parametrize("change", ["drift", "unknown_game", "missing_tracks", "api_failure", "duplicate_video"])
def test_later_failure_never_releases_earlier_provisional_windows(change):
    c, client, blobs = core(), Inventory(31), []
    state = store(advance(start(), client).checkpoint, blobs)
    if change == "drift":
        client.ids.append("MPREb_999")
    elif change == "unknown_game":
        client.album_title = "HOYO-MiX - Another Franchise"
    elif change == "missing_tracks":
        client.track_count_delta = 1
    elif change == "api_failure":
        def broken(*args):
            raise RuntimeError("Bearer PRIVATE_DO_NOT_ECHO")
        client.get_album = broken
    else:
        original = client.get_album
        def duplicate(browse):
            value = original(browse)
            value["tracks"][0]["videoId"] = "00000000000"
            return value
        client.get_album = duplicate
    result = advance(state, client)
    assert result.status in {"blocked", "pending_review"}
    assert result.outbox == []
    assert result.checkpoint.to_dict()["globalComplete"] is False
    assert b"PRIVATE_DO_NOT_ECHO" not in result.checkpoint.to_json()
    with pytest.raises(CatalogueSyncError):
        c.validate_outbox(result.checkpoint, catalogue=baseline(), outbox=blobs[0])


def test_more_than_1000_campaign_candidates_use_separate_bounded_window_blobs():
    c, state, blobs = core(), *finish(Inventory(154, tracks=10))
    assert state.to_dict()["status"] == "complete"
    assert len(blobs) == 6
    assert len(state.to_json()) < 300000  # no accumulated candidate bodies
    total = 0
    for blob in blobs:
        manifests = c.validate_outbox(state, catalogue=baseline(), outbox=blob)
        assert len(manifests) <= 10
        assert all(len(m["discoveries"]) <= 100 for m in manifests)
        total += sum(len(m["discoveries"]) for m in manifests)
    assert total == 1540


def test_candidate_overflow_blocks_whole_window_without_truncated_manifest():
    result = advance(start(), Inventory(30, tracks=34))
    assert result.status == "blocked"
    assert "discovery_limit" in result.checkpoint.to_dict()["reasons"]
    assert result.outbox == []


def test_zero_progress_budget_and_release_page_limit_cannot_issue_certificate(monkeypatch):
    from catalog_sync import ytmusic
    client = Inventory()
    client.on_album = lambda: None
    # Exercise coordinator validation independently of trusted scanner return values.
    monkeypatch.setattr(ytmusic, "discover_bounded_releases", lambda *a, **kw: ytmusic.BoundedReleases(
        [], ["request_limit"], 80, inventory_id="a" * 64, inventory_size=154,
        next_cursor=ytmusic._cursor("a" * 64, 0)))
    result = advance(start(), client)
    assert result.status == "blocked"
    assert "zero_progress" in result.checkpoint.to_dict()["reasons"]
    assert result.outbox == []


def test_request_limit_is_http_not_just_client_method_count(monkeypatch):
    from catalog_sync import ytmusic
    from requests import Session
    requests = []
    class Reply:
        status_code = 200
        def iter_content(self, size):
            yield b"{}"
        def close(self):
            pass
    def request(*a, **kw):
        requests.append(1)
        return Reply()
    class Client(Inventory):
        def __init__(self, *, requests_session):
            super().__init__(31)
            self.session = requests_session
        def get_album(self, browse):
            for _ in range(3):
                self.session.request("GET", "https://music.youtube.com/fixture")
            return super().get_album(browse)
    monkeypatch.setattr(Session, "request", request)
    monkeypatch.setattr(ytmusic, "YTMusic", Client)
    result = core().advance_campaign(start(), catalogue=baseline())
    assert len(requests) == 80
    assert result.status == "blocked"
    assert "request_limit" in result.checkpoint.to_dict()["reasons"]
    assert result.outbox == []


def test_injected_monotonic_clock_enforces_whole_window_deadline():
    class Clock:
        value = 100.0
        def __call__(self):
            return self.value
    clock, client = Clock(), Inventory()
    def slow():
        clock.value += 121
    client.on_album = slow
    result = advance(start(), client, clock=clock)
    assert result.status == "blocked"
    assert "time_limit" in result.checkpoint.to_dict()["reasons"]
    assert len(client.fetched) == 2


@pytest.mark.parametrize("mutation", ["position", "scope", "missing_page", "last_page", "duplicate_page", "certificate", "body", "unknown_key"])
def test_checkpoint_and_window_tampering_are_rejected_before_release(mutation):
    c, state, blobs = core(), *finish(Inventory(31))
    value = state.to_dict()
    if mutation == "body":
        altered = deepcopy(blobs[0])
        altered["manifests"][0]["discoveries"][0]["title"] = "Changed"
        with pytest.raises(CatalogueSyncError):
            c.validate_outbox(state, catalogue=baseline(), outbox=altered)
        return
    if mutation == "position":
        value["position"] = 0
    elif mutation == "scope":
        value["scope"] = "0" * 64
    elif mutation in {"missing_page", "last_page"}:
        value["pages"] = value["pages"][1:]
    elif mutation == "duplicate_page":
        value["pages"].append(value["pages"][0])
    elif mutation == "certificate":
        value["certificate"] = None
    else:
        value["cookie"] = "never store"
    with pytest.raises(CatalogueSyncError):
        c.CampaignState.from_json(json.dumps(value))


def test_rehashed_last_page_and_forged_completion_are_structurally_rejected():
    from hashlib import sha256
    c, state, blobs = core(), *finish(Inventory(31))
    value = state.to_dict()
    value["pages"] = value["pages"][1:]
    value["digest"] = sha256(canonical_without(value, "digest")).hexdigest()
    with pytest.raises(CatalogueSyncError):
        c.validate_state(value)


def canonical_without(value, field):
    return json.dumps({k: v for k, v in value.items() if k != field}, ensure_ascii=False,
                      sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


@pytest.mark.parametrize("data", [b'{"schemaVersion":1,"schemaVersion":1}', b'{"x":NaN}', b"x" * (10 * 1024 * 1024 + 1)], ids=["duplicate-key", "nonfinite", "oversize"])
def test_untrusted_json_is_bounded_and_strict(data):
    with pytest.raises(CatalogueSyncError):
        core().CampaignState.from_json(data)


def test_finite_scope_rejects_limit_bypass_and_config_origin_mismatch():
    for limit in [0, True, 31, 100, 801]:
        with pytest.raises(CatalogueSyncError):
            start(window_albums=limit)
    with pytest.raises(CatalogueSyncError):
        core().start_campaign(config(), "https://user:pass@example.org", "x", "2026-11-15T00:00:00Z")


def test_empty_inventory_requires_storage_ack_before_global_completion():
    result = advance(start(), Inventory(0))
    assert result.status == "outbox_pending"
    assert result.checkpoint.to_dict()["globalComplete"] is False
    state = store(result.checkpoint, [])
    assert state.to_dict()["globalComplete"] is True


def test_32_steps_are_terminal_even_when_each_window_makes_progress():
    c, client, state, blobs = core(), Inventory(65), start(window_albums=2), []
    for _ in range(32):
        state = store(advance(state, client).checkpoint, blobs)
    assert state.to_dict()["position"] == 64
    result = advance(state, client)
    assert result.status == "blocked"
    assert result.checkpoint.to_dict()["reasons"] == ["step_limit"]
    assert result.checkpoint.to_dict()["steps"] == 32
    with pytest.raises(CatalogueSyncError):
        c.validate_outbox(result.checkpoint, catalogue=baseline(), outbox=blobs[0])


@pytest.mark.parametrize("kind", ["duplicate", "saturated"])
def test_shelf_duplicates_and_unknown_bounded_listing_tail_block(kind):
    client = Inventory(3)
    def artist(channel):
        results = [{"browseId": "MPREb_000"}, {"browseId": "MPREb_000"}]
        if kind != "duplicate":
            results = [{"browseId": f"MPREb_{i:03d}"} for i in range(100)]
        return {"albums": {"results": results, "params": "page", "browseId": "SHELF_001"}}
    client.get_artist = artist
    client.get_artist_albums = lambda *a, **kw: [{"browseId": f"MPREb_{i:03d}"} for i in range(100)]
    result = advance(start(), client)
    assert result.status == "blocked"
    assert result.outbox == []


def test_rehashed_checkpoint_cannot_skip_attempts_or_replace_int_with_bool():
    from hashlib import sha256
    c = core()
    state, blobs = finish(Inventory(1))
    for name, replacement in [("steps", 32), ("position", True)]:
        value = state.to_dict()
        value[name] = replacement
        value["digest"] = sha256(canonical_without(value, "digest")).hexdigest()
        with pytest.raises(CatalogueSyncError):
            c.validate_state(value)


def test_later_complete_page_with_repeated_album_id_is_blocked_before_storage(monkeypatch):
    from catalog_sync import ytmusic
    c, client, blobs = core(), Inventory(31), []
    state = store(advance(start(), client).checkpoint, blobs)
    original = ytmusic.discover_bounded_releases
    def repeated(*args, **kwargs):
        page = original(*args, **kwargs)
        page.releases[0]["albumBrowseId"] = "MPREb_000"
        return page
    monkeypatch.setattr(ytmusic, "discover_bounded_releases", repeated)
    result = advance(state, client)
    assert result.status == "blocked"
    assert result.outbox == []


@pytest.mark.parametrize("changed", [{"isAvailable": "false"}, {"duration_seconds": True}])
def test_invalid_track_field_types_never_enter_durable_window(changed):
    client = Inventory(1)
    original = client.get_album
    def altered(browse):
        album = original(browse)
        album["tracks"][0].update(changed)
        return album
    client.get_album = altered
    result = advance(start(), client)
    assert result.status == "blocked"
    assert result.outbox == []


def test_fresh_baseline_candidate_overflow_cannot_release_old_bounded_batch():
    c, client = core(), Inventory(2, tracks=600)
    known = [f"{t:011d}" for t in range(600)]
    result = advance(start(), client, baseline(*known))
    assert result.status == "outbox_pending"
    blobs = []
    state = store(result.checkpoint, blobs)
    with pytest.raises(CatalogueSyncError):
        c.validate_outbox(state, catalogue=baseline(revision="2"), outbox=blobs[0])


def test_1000_candidates_emit_exactly_ten_100_row_manifests():
    c, state, blobs = core(), *finish(Inventory(10, tracks=100))
    manifests = c.validate_outbox(state, catalogue=baseline(), outbox=blobs[0])
    assert len(manifests) == 10
    assert [len(m["discoveries"]) for m in manifests] == [100] * 10
    assert len({m["runId"] for m in manifests}) == 10


def test_oversized_projected_window_yields_explicit_blocked_record_without_raw_content():
    client = Inventory(2, tracks=1000)
    client.track_title_size = 6000
    known = [f"{i:011d}" for i in range(2000)]
    result = advance(start(window_albums=2), client, baseline(*known))
    assert result.status == "blocked"
    assert "record_limit" in result.checkpoint.to_dict()["reasons"]
    assert result.outbox == []
    assert len(result.checkpoint.to_json()) < 10000


def test_original_state_and_outbox_are_detached_from_mutable_callers():
    result = advance(start(), Inventory(1))
    saved = result.checkpoint.to_json()
    result.outbox[0]["manifests"][0]["discoveries"].clear()
    value = result.checkpoint.to_dict()
    value["pages"].append({})
    assert result.checkpoint.to_json() == saved


def test_full_shelf_can_repeat_preview_without_losing_inventory():
    client = Inventory(3)
    client.get_artist = lambda channel: {"albums": {
        "results": [{"browseId": "MPREb_000"}], "params": "albums", "browseId": CHANNEL}}
    client.get_artist_albums = lambda *a, **kw: [{"browseId": browse} for browse in client.ids]
    state, blobs = finish(client)
    assert state.to_dict()["status"] == "complete"
    assert state.to_dict()["inventorySize"] == 3
    assert client.fetched == client.ids
    assert sum(len(m["discoveries"]) for m in core().validate_outbox(
        state, catalogue=baseline(), outbox=blobs[0])) == 3


def test_full_shelf_missing_a_preview_identity_cannot_certify_inventory():
    client = Inventory(2)
    client.get_artist = lambda channel: {"albums": {
        "results": [{"browseId": "MPREb_000"}], "params": "albums", "browseId": CHANNEL}}
    client.get_artist_albums = lambda *a, **kw: [{"browseId": "MPREb_001"}]
    result = advance(start(), client)
    assert result.status == "blocked"
    assert result.outbox == []
    assert result.checkpoint.to_dict()["certificate"] is None


def test_154_full_shelves_with_shared_browse_id_and_distinct_params_complete():
    client = Inventory(154)
    client.get_artist = lambda channel: {
        "albums": {"results": [{"browseId": "MPREb_000"}], "browseId": CHANNEL, "params": "albums"},
        "singles": {"results": [{"browseId": "MPREb_083"}], "browseId": CHANNEL, "params": "singles"}}
    def full_shelf(channel, params, *, limit):
        assert channel == CHANNEL and limit == 100
        ids = client.ids[:83] if params == "albums" else client.ids[83:]
        return [{"browseId": browse} for browse in ids]
    client.get_artist_albums = full_shelf
    state, blobs = finish(client)
    assert state.to_dict()["status"] == "complete"
    assert state.to_dict()["inventorySize"] == 154
    assert len(state.to_dict()["certificate"]["windows"]) == 6
    assert client.fetched == client.ids
    assert sum(len(m["discoveries"]) for blob in blobs for m in core().validate_outbox(
        state, catalogue=baseline(), outbox=blob)) == 154


def test_video_ledger_limit_blocks_before_emitting_an_unacknowledgeable_window(monkeypatch):
    c, client, blobs = core(), Inventory(2), []
    # Exercise the real ledger boundary with two records instead of generating 32,001.
    monkeypatch.setattr(c, "MAX_VIDEO_IDENTITIES", 1, raising=False)
    state = store(advance(start(window_albums=1), client, baseline("00000000000")).checkpoint, blobs)
    result = advance(state, client, baseline("00000000000", "00000001000"))
    assert result.status == "blocked"
    assert result.checkpoint.to_dict()["reasons"] == ["record_limit"]
    assert len(result.checkpoint.to_dict()["seenVideos"]) == 1
    assert result.outbox == []
    with pytest.raises(CatalogueSyncError):
        c.validate_outbox(result.checkpoint, catalogue=baseline(), outbox=blobs[0])


def test_rehashed_pending_album_with_incomplete_track_count_is_rejected():
    from hashlib import sha256
    c = core()
    value = advance(start(), Inventory(1)).checkpoint.to_dict()
    envelope = value["outbox"][0]
    envelope["releases"][0]["album"]["trackCount"] = 2
    envelope["payloadDigest"] = sha256(canonical_without(envelope, "payloadDigest")).hexdigest()
    value["digest"] = sha256(canonical_without(value, "digest")).hexdigest()
    with pytest.raises(CatalogueSyncError):
        c.validate_state(value)


def test_saturated_inline_shelf_without_continuation_cannot_certify_inventory():
    # This fixture's albums shelf has 83 items, so put all 100 on a single shelf.
    client = Inventory(100)
    client.get_artist = lambda channel: {"albums": {
        "results": [{"browseId": browse} for browse in client.ids]}}
    result = advance(start(), client)
    assert result.status == "blocked"
    assert "release_page_limit" in result.checkpoint.to_dict()["reasons"]
    assert result.outbox == []


def test_known_duplicate_across_windows_blocks_before_final_storage_ack():
    c, client, blobs = core(), Inventory(2), []
    original = client.get_album
    def duplicate(browse):
        album = original(browse)
        album["tracks"][0]["videoId"] = "00000000000"
        return album
    client.get_album = duplicate
    state = store(advance(start(window_albums=1), client, baseline("00000000000")).checkpoint, blobs)
    result = advance(state, client, baseline("00000000000"))
    assert result.status == "pending_review"
    assert result.checkpoint.to_dict()["globalComplete"] is False
    assert "duplicate_video" in result.checkpoint.to_dict()["reasons"]
    assert result.outbox == []
    with pytest.raises(CatalogueSyncError):
        c.validate_outbox(result.checkpoint, catalogue=baseline(revision="2"), outbox=blobs[0])


def exclusion(browse="MPREb_000", channel=CHANNEL):
    return {"artistChannelId": channel, "albumBrowseId": browse,
            "disposition": "out_of_scope", "reason": "Owner reviewed official album metadata: HI3.",
            "evidence": ["https://music.youtube.com/browse/" + browse]}


def test_reviewed_exclusion_is_exact_and_scope_bound_through_restart_and_final_drain():
    c, client, blobs = core(), Inventory(2), []
    original = client.get_album
    def mixed(browse):
        album = original(browse)
        if browse == "MPREb_000":
            album["title"] = "Honkai Impact 3rd - Official fixture"
        return album
    client.get_album = mixed
    reviewed = [exclusion()]
    state = start(window_albums=1, reviewed_exclusions=reviewed)
    assert state.to_dict()["scope"] != start(window_albums=1).to_dict()["scope"]
    reviewed[0]["reason"] = "Caller mutation"
    first = advance(c.CampaignState.from_json(state.to_json()), client)
    assert first.status == "outbox_pending"
    assert first.outbox[0]["manifests"][0]["discoveries"] == []
    with pytest.raises(CatalogueSyncError):
        c.validate_outbox(first.checkpoint, catalogue=baseline(), outbox=first.outbox[0])
    state = store(first.checkpoint, blobs)
    state = store(advance(c.CampaignState.from_json(state.to_json()), client).checkpoint, blobs)
    assert state.to_dict()["certificate"]["scope"] == state.to_dict()["scope"]
    assert state.to_dict()["position"] == state.to_dict()["inventorySize"] == 2
    rows = [row for blob in blobs for manifest in c.validate_outbox(
        state, catalogue=baseline(revision="2"), outbox=blob) for row in manifest["discoveries"]]
    assert [row["albumBrowseId"] for row in rows] == ["MPREb_001"]
    assert "Caller mutation" not in state.to_json().decode()


@pytest.mark.parametrize("field,value", [
    ("albumBrowseId", "MPREb_*"), ("artistChannelId", "*"),
    ("disposition", "guessed"), ("reason", ""), ("reason", "token=private"),
    ("evidence", []), ("evidence", ["HI3 by title"]),
    ("evidence", ["https://music.youtube.com/browse/MPREb_001"]),
    ("evidence", ["https://music.youtube.com/browse/MPREb_000?token=private"]),
    ("evidence", ["https://example.org/MPREb_000"]),
])
def test_reviewed_exclusions_reject_inexact_or_unsupported_evidence(field, value):
    reviewed = exclusion()
    reviewed[field] = value
    with pytest.raises(CatalogueSyncError):
        start(reviewed_exclusions=[reviewed])


def test_reviewed_exclusions_reject_duplicate_identity_or_target_mapping():
    with pytest.raises(CatalogueSyncError):
        start(reviewed_exclusions=[exclusion(), exclusion()])
    cfg = {"schemaVersion": 1, "channels": [{"id": CHANNEL, "games": []}],
           "albumGames": {"MPREb_000": ["genshin"]}}
    with pytest.raises(CatalogueSyncError):
        core().start_campaign(cfg, "https://catalogue.example", "weekly", "2026-11-15T00:00:00Z",
                              reviewed_exclusions=[exclusion()])


@pytest.mark.parametrize("reviewed", [[exclusion("MPREb_001")], []])
def test_unreviewed_unknown_album_never_inherits_an_exclusion(reviewed):
    client = Inventory(1)
    client.album_title = "Unknown franchise"
    result = advance(start(reviewed_exclusions=reviewed), client)
    assert result.status == "pending_review"
    assert result.checkpoint.to_dict()["certificate"] is None
    assert result.outbox == []


def test_reviewed_exclusion_does_not_match_the_same_album_on_another_channel():
    other = "UC" + "B" * 22
    cfg = {"schemaVersion": 1, "channels": [{"id": CHANNEL, "games": []}, {"id": other, "games": []}],
           "albumGames": {}}
    state = core().start_campaign(cfg, "https://catalogue.example", "weekly", "2026-11-15T00:00:00Z",
                                 reviewed_exclusions=[exclusion(channel=other)])
    client = Inventory(1)
    client.album_title = "Unknown franchise"
    original = client.get_artist
    client.get_artist = lambda channel: original(channel) if channel == CHANNEL else {}
    result = advance(state, client)
    assert result.status == "pending_review"
    assert result.outbox == []
    assert result.checkpoint.to_dict()["certificate"] is None


def test_exclusion_conflicting_with_target_metadata_stays_pending_review():
    result = advance(start(reviewed_exclusions=[exclusion()]), Inventory(1))
    assert result.status == "pending_review"
    assert "exclusion_conflict" in result.checkpoint.to_dict()["reasons"]
    assert result.outbox == []


def test_exclusion_evidence_cannot_be_changed_without_changing_campaign_scope():
    from hashlib import sha256
    c = core()
    state = start(reviewed_exclusions=[exclusion()])
    value = state.to_dict()
    value["reviewedExclusions"][0]["reason"] = "Different review decision"
    value["digest"] = sha256(canonical_without(value, "digest")).hexdigest()
    with pytest.raises(CatalogueSyncError):
        c.validate_state(value)


@pytest.mark.parametrize("title", [
    "Genshin  Impact - Cafe\u0301 fixture",
    "Genshin\u00a0Impact - Cafe\u0301 fixture",
    " \tGenshin\nImpact - Cafe\u0301 fixture  ",
])
def test_review_f1_normalised_target_cannot_be_excluded_after_restart(title):
    from catalog_sync.discovery import scan_releases
    c, client, blobs = core(), Inventory(2), []
    state = start(window_albums=1, reviewed_exclusions=[exclusion("MPREb_001")])
    state = store(advance(state, client).checkpoint, blobs)
    client.album_title = title
    release = {"artistChannelId": CHANNEL, "albumBrowseId": "MPREb_001",
               "summary": {}, "album": client.get_album("MPREb_001")}
    scanner = scan_releases([release], baseline(), config())
    assert scanner.report["complete"] is True
    assert scanner.discoveries[0]["games"] == ["genshin"]
    result = advance(c.CampaignState.from_json(state.to_json()), client)
    assert result.status == "pending_review"
    assert result.checkpoint.to_dict()["reasons"] == ["exclusion_conflict"]
    assert result.outbox == []
    assert result.checkpoint.to_dict()["certificate"] is None
    with pytest.raises(CatalogueSyncError):
        c.validate_outbox(result.checkpoint, catalogue=baseline(revision="2"), outbox=blobs[0])


@pytest.mark.parametrize("title", [
    "Genshin  Impact - Cafe\u0301 fixture",
    "Genshin\u00a0Impact - Cafe\u0301 fixture",
    " \tGenshin\nImpact - Cafe\u0301 fixture  ",
])
def test_review_f1_normalised_target_survives_restart_and_fresh_drain(title):
    client = Inventory(2)
    client.album_title = title
    state, blobs = finish(client, window_albums=1)
    assert state.to_dict()["status"] == "complete"
    rows = [row for blob in blobs for manifest in core().validate_outbox(
        state, catalogue=baseline(revision="2"), outbox=blob) for row in manifest["discoveries"]]
    assert len(rows) == 2
    assert all(row["album"] == "Genshin Impact - Caf\u00e9 fixture" for row in rows)
    assert all(row["games"] == ["genshin"] for row in rows)


@pytest.mark.parametrize("with_exclusion", [False, True])
def test_review_f1_whitespace_album_title_uses_canonical_summary_fallback(with_exclusion):
    client = Inventory(1)
    client.album_title = " \t\u00a0 "
    client.get_artist = lambda channel: {"albums": {"results": [
        {"browseId": "MPREb_000", "title": "Genshin\u00a0Impact - Cafe\u0301 fixture"}]}}
    state = start(reviewed_exclusions=[exclusion()] if with_exclusion else [])
    result = advance(core().CampaignState.from_json(state.to_json()), client)
    if with_exclusion:
        assert result.status == "pending_review"
        assert result.checkpoint.to_dict()["reasons"] == ["exclusion_conflict"]
        assert result.outbox == []
    else:
        assert result.status == "outbox_pending"
        blobs = []
        complete = store(result.checkpoint, blobs)
        rows = core().validate_outbox(complete, catalogue=baseline(revision="2"), outbox=blobs[0])[0]["discoveries"]
        assert rows[0]["album"] == "Genshin Impact - Caf\u00e9 fixture"


def test_review_f1_unknown_fullwidth_title_does_not_gain_nfkc_target_mapping():
    client = Inventory(1)
    client.album_title = "Ｇｅｎｓｈｉｎ　Ｉｍｐａｃｔ - Unknown fixture"
    result = advance(start(), client)
    assert result.status == "pending_review"
    assert result.checkpoint.to_dict()["reasons"] == ["unclassified_game"]
    assert result.outbox == []


@pytest.mark.parametrize("params", ["albums", " albums ", "\talbums\u00a0"])
def test_review_f2_missing_preview_blocks_before_album_fetch_with_canonical_params(params):
    client = Inventory(2)
    client.get_artist = lambda channel: {"albums": {"results": [{"browseId": "MPREb_000"}],
                                                  "browseId": CHANNEL, "params": params}}
    calls = []
    def full_shelf(channel, actual_params, *, limit):
        calls.append((channel, actual_params, limit))
        return [{"browseId": "MPREb_001"}]
    client.get_artist_albums = full_shelf
    result = advance(start(), client)
    assert calls == [(CHANNEL, "albums", 100)]
    assert result.status == "blocked"
    assert result.checkpoint.to_dict()["reasons"] == ["inventory_drift"]
    assert client.fetched == []
    assert result.outbox == []
    assert result.checkpoint.to_dict()["certificate"] is None


@pytest.mark.parametrize("params", ["albums", " albums ", "\talbums\u00a0"])
def test_review_f2_legitimate_overlap_completes_after_params_canonicalisation(params):
    client = Inventory(2)
    client.get_artist = lambda channel: {"albums": {"results": [{"browseId": "MPREb_000"}],
                                                  "browseId": CHANNEL, "params": params}}
    def full_shelf(channel, actual_params, *, limit):
        assert channel == CHANNEL and actual_params == "albums" and limit == 100
        return [{"browseId": browse} for browse in client.ids]
    client.get_artist_albums = full_shelf
    state, blobs = finish(client, window_albums=1)
    assert state.to_dict()["status"] == "complete"
    assert client.fetched == client.ids
    rows = [row for blob in blobs for manifest in core().validate_outbox(
        state, catalogue=baseline(revision="2"), outbox=blob) for row in manifest["discoveries"]]
    assert len(rows) == 2


@pytest.mark.parametrize("context", ["no_artist", "wrong_shelf", "wrong_params", "empty_params"])
def test_review_f2_unknown_guard_context_rejects_before_request(context):
    client, calls = Inventory(1), []
    client.get_artist = lambda channel: {"albums": {"results": [{"browseId": "MPREb_000"}],
                                                  "browseId": CHANNEL, "params": " albums "}}
    def full_shelf(*args, **kwargs):
        calls.append(1)
        return []
    client.get_artist_albums = full_shelf
    bounded = core()._WindowClient(client, lambda: 100.0)
    if context != "no_artist":
        bounded.get_artist(CHANNEL)
    shelf = "OTHER_SHELF" if context == "wrong_shelf" else CHANNEL
    params = "unregistered" if context == "wrong_params" else "" if context == "empty_params" else "albums"
    with pytest.raises(CatalogueSyncError):
        bounded.get_artist_albums(shelf, params, limit=100)
    assert calls == []


def test_reviewed_exclusion_allows_included_album_sharing_video_with_out_of_scope_duplicate():
    c = core()
    client = Inventory(2)
    original = client.get_album

    def shared_with_excluded(browse):
        album = original(browse)
        if browse == "MPREb_000":
            album["title"] = "Duplicate Single"
            album["tracks"] = [{"videoId": "00000001000", "title": "Recording 0 (Live)", "duration_seconds": 120}]
        return album

    client.get_album = shared_with_excluded
    state, blobs = finish(client, window_albums=1, reviewed_exclusions=[exclusion("MPREb_000")])
    assert state.to_dict()["status"] == "complete"
    assert state.to_dict()["inventorySize"] == 2
    rows = [row for blob in blobs for manifest in c.validate_outbox(
        state, catalogue=baseline(revision="2"), outbox=blob) for row in manifest["discoveries"]]
    assert [(r["albumBrowseId"], r["videoId"]) for r in rows] == [("MPREb_001", "00000001000")]


def test_intra_window_duplicate_video_across_included_albums_requires_review():
    client = Inventory(2)
    original = client.get_album

    def duplicate_included(browse):
        album = original(browse)
        album["tracks"] = [{"videoId": "00000000000", "title": "Recording 0 (Live)", "duration_seconds": 120}]
        return album

    client.get_album = duplicate_included
    result = advance(start(window_albums=2), client)
    assert result.status == "pending_review"
    assert result.checkpoint.to_dict()["reasons"] == ["duplicate_video"]
    assert result.outbox == []
