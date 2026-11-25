import json
import os
from pathlib import Path
import subprocess
import sys

import pytest
from test_discovery import CHANNEL, config, release

ROOT = Path(__file__).resolve().parents[1]


def invoke(tmp_path, *extra):
    cfg = tmp_path / "config.json"
    cfg.write_text(json.dumps({"schemaVersion": 1, "channels": [{"id": CHANNEL, "games": []}], "albumGames": {}}), encoding="utf-8")
    fixture = tmp_path / "fixture.json"
    fixture.write_text(json.dumps({"schemaVersion": 1, "releases": [release()]}), encoding="utf-8")
    catalogue = tmp_path / "catalogue.json"
    catalogue.write_text("[]", encoding="utf-8")
    env = dict(os.environ, PYTHONPATH=str(ROOT), PYTHONDONTWRITEBYTECODE="1")
    args = [sys.executable, "-m", "catalog_sync.discover_cli", "--config", str(cfg),
            "--fixture", str(fixture), "--catalogue", str(catalogue), "--run-id", "fixture-run",
            "--output-dir", str(tmp_path / "output"), *extra]
    return subprocess.run(args, capture_output=True, text=True, env=env, timeout=20)


def test_fixture_cli_is_runnable_exclusive_and_does_not_touch_input_files(tmp_path):
    first = invoke(tmp_path)
    assert first.returncode == 0, first.stderr
    output = tmp_path / "output"
    assert sorted(path.name for path in output.iterdir()) == ["manifest-0001.json", "scan-report.json", "suggestions.json"]
    manifest = json.loads((output / "manifest-0001.json").read_bytes())
    assert set(manifest) == {"schemaVersion", "runId", "discoveries"}
    assert len(manifest["discoveries"]) == 1
    report = json.loads((output / "scan-report.json").read_bytes())
    assert report["complete"] is True
    assert report["source"] == "fixture"
    assert report["manifests"] == ["manifest-0001.json"]
    assert (tmp_path / "catalogue.json").read_text() == "[]"
    before = {path.name: path.read_bytes() for path in output.iterdir()}
    assert invoke(tmp_path).returncode != 0
    assert before == {path.name: path.read_bytes() for path in output.iterdir()}


def test_cli_rejects_unsafe_manual_ai_without_echoing_input(tmp_path):
    unsafe = tmp_path / "suggestions.json"
    unsafe.write_text('{"schemaVersion":1,"suggestions":[],"cookie":"DO_NOT_ECHO"}', encoding="utf-8")
    result = invoke(tmp_path, "--suggestions-json", str(unsafe))
    assert result.returncode == 1
    assert result.stderr == "catalog-discover: scan failed (details redacted)\n"
    assert "DO_NOT_ECHO" not in result.stdout + result.stderr
    assert "Traceback" not in result.stderr
    assert not list((tmp_path / "output").glob("manifest-*.json"))


def test_cli_fails_safely_for_api_error_and_writes_only_failure_report(tmp_path, monkeypatch):
    from catalog_sync import discover_cli
    def broken(*args, **kwargs):
        raise RuntimeError("upstream Bearer DO_NOT_ECHO")
    monkeypatch.setattr(discover_cli, "discover_bounded_releases", broken)
    cfg = tmp_path / "config.json"
    cfg.write_text(json.dumps({"schemaVersion": 1, "channels": [{"id": CHANNEL, "games": []}], "albumGames": {}}))
    with pytest.raises(Exception) as captured:
        discover_cli.run(discover_cli.parser().parse_args(["--config", str(cfg), "--run-id", "api-failure", "--output-dir", str(tmp_path / "output")]))
    assert "DO_NOT_ECHO" not in str(captured.value)
    report = json.loads((tmp_path / "output" / "scan-report.json").read_bytes())
    assert report["complete"] is False
    assert report["incompleteReasons"] == ["scan_failed"]
    assert not list((tmp_path / "output").glob("manifest-*.json"))


def test_cli_rejects_duplicate_keys_and_invalid_json_constants(tmp_path):
    bad = tmp_path / "bad.json"
    for value in ['{"schemaVersion":1,"schemaVersion":1,"suggestions":[]}', '{"schemaVersion":1,"suggestions":[],"x":NaN}']:
        bad.write_text(value, encoding="utf-8")
        result = invoke(tmp_path, "--suggestions-json", str(bad))
        assert result.returncode == 1
        assert result.stderr == "catalog-discover: scan failed (details redacted)\n"


def test_invalid_limits_fail_before_any_public_api_call(tmp_path, monkeypatch):
    from catalog_sync import discover_cli
    calls = []
    def unexpected(*args, **kwargs):
        calls.append(True)
        raise RuntimeError("should not reach public API")
    monkeypatch.setattr(discover_cli, "discover_bounded_releases", unexpected)
    cfg = tmp_path / "config.json"
    cfg.write_text(json.dumps({"schemaVersion": 1, "channels": [{"id": CHANNEL, "games": []}], "albumGames": {}}))
    args = discover_cli.parser().parse_args(["--config", str(cfg), "--run-id", "bad-limits", "--output-dir", str(tmp_path / "output"), "--max-discoveries", "1001"])
    with pytest.raises(Exception):
        discover_cli.run(args)
    assert calls == []


class PublicInventory:
    """Fake public metadata/HTTP only; exercise real CLI, scanner and transport gates."""

    def __init__(self, count=31):
        self.ids = [f"MPREb_{index:03d}" for index in range(count)]
        self.fetched = []
        self.requests = []
        self.interrupt_at = None
        self.on_album = None
        self.on_artist = None
        self.extra_track = {}
        self.track_count = None
        self.paged_listing = False
        self.album_requests = 1

    def install(self, monkeypatch):
        from catalog_sync import ytmusic, transport
        from requests import Session
        inventory = self

        class Reply:
            status_code = 200
            def iter_content(self, size):
                yield b"{}"
            def close(self):
                pass

        def request(session, method, url, **kwargs):
            inventory.requests.append(url)
            return Reply()

        class PublicClient:
            def __init__(self, *, requests_session):
                self.session = requests_session
            def get_artist(self, channel):
                self.session.request("GET", "https://music.youtube.com/fixture-artist")
                if inventory.on_artist:
                    inventory.on_artist()
                if inventory.paged_listing:
                    return {"albums": {"results": [], "params": "fixture-page"}}
                return {"albums": {"results": [{"browseId": value} for value in inventory.ids]}}
            def get_artist_albums(self, channel, params, *, limit):
                self.session.request("GET", "https://music.youtube.com/fixture-listing")
                return [{"browseId": value} for value in inventory.ids[:limit]]
            def get_album(self, browse):
                for _ in range(inventory.album_requests):
                    self.session.request("GET", "https://music.youtube.com/fixture-album/" + browse)
                if browse == inventory.interrupt_at:
                    raise KeyboardInterrupt()
                inventory.fetched.append(browse)
                if inventory.on_album:
                    inventory.on_album()
                index = int(browse.rsplit("_", 1)[1])
                return {"title": "Genshin Impact - Fixture", "trackCount": inventory.track_count, "tracks": [
                    {"videoId": f"{index:011d}", "title": f"Recording {index}", **inventory.extra_track}]}

        monkeypatch.setattr(Session, "request", request)
        monkeypatch.setattr(ytmusic, "YTMusic", PublicClient)
        # Public GET boundary, with the first 30 recordings already approved.
        monkeypatch.setattr(transport, "_request", lambda *args, **kwargs: json.dumps({"revision": "1", "tracks": [
            {"id": f"approved-{index}", "sources": [{"provider": "youtube", "externalId": f"{index:011d}"}]}
            for index in range(30)]}).encode())


def public_args(tmp_path, *extra, output="output"):
    from catalog_sync import discover_cli
    cfg = tmp_path / "config.json"
    cfg.write_text(json.dumps({"schemaVersion": 1, "channels": [{"id": CHANNEL, "games": []}], "albumGames": {}}), encoding="utf-8")
    return discover_cli.parser().parse_args(["--config", str(cfg), "--run-id", "public-run",
        "--origin", "https://catalogue.example", "--output-dir", str(tmp_path / output), *extra])


def test_actual_cli_paginates_31_albums_with_weekly_defaults_and_complete_ingestion(tmp_path, monkeypatch):
    from catalog_sync import discover_cli, transport
    inventory = PublicInventory()
    inventory.install(monkeypatch)
    report = discover_cli.run(public_args(tmp_path))
    assert inventory.fetched == inventory.ids, "weekly entrypoint must reach the album after the first 30"
    assert report["complete"] is True
    assert report["scannedAlbums"] == 31
    assert report["apiCalls"] == 33  # Two inventory reads plus 31 album reads.
    manifest = json.loads((tmp_path / "output" / "manifest-0001.json").read_bytes())
    assert [item["videoId"] for item in manifest["discoveries"]] == ["00000000030"]
    submitted = []
    monkeypatch.setattr(transport, "_request", lambda *args, **kwargs: submitted.append(kwargs["data"]))
    assert transport.ingest_manifests("https://catalogue.example", tmp_path / "output", "fixture-token", enabled=True) == 1
    assert len(submitted) == 1


def test_actual_cli_checkpoint_survives_interruption_and_resumes_without_refetching_prefix(tmp_path, monkeypatch):
    from catalog_sync import discover_cli, transport
    from catalog_sync.normalize import CatalogueSyncError
    inventory = PublicInventory()
    inventory.install(monkeypatch)
    inventory.interrupt_at = "MPREb_030"
    with pytest.raises((CatalogueSyncError, KeyboardInterrupt)):
        discover_cli.run(public_args(tmp_path))
    checkpoint = tmp_path / "output" / "scan-checkpoint.json"
    assert checkpoint.exists(), "completed pages must survive an interrupted next page"
    original = checkpoint.read_bytes()
    assert not list((tmp_path / "output").glob("manifest-*.json"))
    with pytest.raises((CatalogueSyncError, FileNotFoundError)):
        transport.ingest_manifests("https://catalogue.example", tmp_path / "output", "fixture-token", enabled=True)
    inventory.interrupt_at = None
    # A resumed run rechecks the public baseline, so already-approved tracks stay excluded.
    monkeypatch.setattr(transport, "_request", lambda *args, **kwargs: json.dumps({"revision": "2", "tracks": []}).encode())
    report = discover_cli.run(public_args(tmp_path, "--resume-from", str(checkpoint), output="resumed"))
    assert report["complete"] is True
    assert report["scannedAlbums"] == 31
    assert report["discovered"] == 31
    assert report["apiCalls"] == 2  # Only a fresh inventory and the remaining album in this invocation.
    assert inventory.fetched == inventory.ids
    assert checkpoint.read_bytes() == original
    manifest = json.loads((tmp_path / "resumed" / "manifest-0001.json").read_bytes())
    assert len({item["videoId"] for item in manifest["discoveries"]}) == 31


@pytest.mark.parametrize("count", [61, 100])
def test_actual_cli_multiple_pages_share_the_request_budget_and_preserve_ids(tmp_path, monkeypatch, count):
    from catalog_sync import discover_cli
    inventory = PublicInventory(count)
    inventory.install(monkeypatch)
    report = discover_cli.run(public_args(tmp_path, "--max-api-calls", "110"))
    assert report["complete"] is True
    assert inventory.fetched == inventory.ids
    assert report["scannedAlbums"] == count
    assert report["apiCalls"] == count + (count + 29) // 30
    checkpoint = json.loads((tmp_path / "output" / "scan-checkpoint.json").read_bytes())
    assert [page["end_index"] for page in checkpoint["pages"]] == ([30, 60, 61] if count == 61 else [30, 60, 90, 100])
    manifest = json.loads((tmp_path / "output" / "manifest-0001.json").read_bytes())
    assert [item["videoId"] for item in manifest["discoveries"]] == [f"{index:011d}" for index in range(30, count)]


def test_actual_cli_exhausted_request_budget_stays_incomplete_and_explicit_resume_progresses(tmp_path, monkeypatch):
    from catalog_sync import discover_cli, transport
    from catalog_sync.normalize import CatalogueSyncError
    inventory = PublicInventory(61)
    inventory.install(monkeypatch)
    report = discover_cli.run(public_args(tmp_path, "--max-api-calls", "35"))
    assert len(inventory.requests) == report["apiCalls"] == 35
    assert len(inventory.fetched) == report["scannedAlbums"] == 33
    assert report["complete"] is False
    assert "request_limit" in report["incompleteReasons"]
    with pytest.raises(CatalogueSyncError):
        transport.ingest_manifests("https://catalogue.example", tmp_path / "output", "fixture-token", enabled=True)
    checkpoint = tmp_path / "output" / "scan-checkpoint.json"
    original = checkpoint.read_bytes()
    report = discover_cli.run(public_args(tmp_path, "--max-api-calls", "35", "--resume-from", str(checkpoint), output="resumed"))
    assert report["complete"] is True
    assert report["scannedAlbums"] == 61
    assert report["apiCalls"] == 29
    assert inventory.fetched == inventory.ids
    assert checkpoint.read_bytes() == original


def test_actual_cli_time_budget_is_shared_across_pages_and_can_resume(tmp_path, monkeypatch):
    from catalog_sync import discover_cli, ytmusic
    clock = [0.0]
    monkeypatch.setattr(discover_cli, "monotonic", lambda: clock[0])
    monkeypatch.setattr(ytmusic, "monotonic", lambda: clock[0])
    inventory = PublicInventory(61)
    inventory.install(monkeypatch)
    def elapsed():
        clock[0] += 1
    inventory.on_artist = elapsed
    inventory.on_album = elapsed
    report = discover_cli.run(public_args(tmp_path, "--max-seconds", "35"))
    assert len(inventory.fetched) == 33
    assert report["apiCalls"] == 35
    assert clock[0] == 35  # The second page cannot get a new 35-second budget.
    assert report["complete"] is False
    assert "time_limit" in report["incompleteReasons"]
    checkpoint = tmp_path / "output" / "scan-checkpoint.json"
    report = discover_cli.run(public_args(tmp_path, "--max-seconds", "35", "--resume-from", str(checkpoint), output="resumed"))
    assert report["complete"] is True
    assert inventory.fetched == inventory.ids


def test_actual_cli_global_album_budget_is_not_multiplied_by_pages(tmp_path, monkeypatch):
    from catalog_sync import discover_cli
    inventory = PublicInventory(61)
    inventory.install(monkeypatch)
    report = discover_cli.run(public_args(tmp_path, "--max-albums", "35"))
    assert len(inventory.fetched) == report["scannedAlbums"] == 35
    assert report["complete"] is False
    assert "album_limit" in report["incompleteReasons"]
    assert len(inventory.requests) == 37


def test_actual_cli_zero_progress_stops_after_one_inventory_read(tmp_path, monkeypatch):
    from catalog_sync import discover_cli
    inventory = PublicInventory()
    inventory.install(monkeypatch)
    report = discover_cli.run(public_args(tmp_path, "--max-api-calls", "1"))
    assert report["complete"] is False
    assert "no_progress" in report["incompleteReasons"]
    assert report["apiCalls"] == len(inventory.requests) == 1
    assert inventory.fetched == []
    assert not (tmp_path / "output" / "scan-checkpoint.json").exists()


@pytest.mark.parametrize("drift", ["add", "remove", "reorder"])
def test_actual_cli_resume_checks_current_inventory_before_fetching_albums(tmp_path, monkeypatch, drift):
    from catalog_sync import discover_cli
    from catalog_sync.normalize import CatalogueSyncError
    inventory = PublicInventory()
    inventory.install(monkeypatch)
    first = discover_cli.run(public_args(tmp_path, "--max-api-calls", "31"))
    assert first["complete"] is False
    checkpoint = tmp_path / "output" / "scan-checkpoint.json"
    original = checkpoint.read_bytes()
    before = inventory.fetched[:]
    if drift == "add":
        inventory.ids.append("MPREb_031")
    elif drift == "remove":
        inventory.ids.remove("MPREb_002")
    else:
        inventory.ids.reverse()
    if drift == "reorder":
        report = discover_cli.run(public_args(tmp_path, "--resume-from", str(checkpoint), output="resumed"))
        assert report["complete"] is True
        assert inventory.fetched == before + ["MPREb_030"]
    else:
        with pytest.raises(CatalogueSyncError):
            discover_cli.run(public_args(tmp_path, "--resume-from", str(checkpoint), output="resumed"))
        assert inventory.fetched == before
        assert json.loads((tmp_path / "resumed" / "scan-report.json").read_bytes())["complete"] is False
        assert not list((tmp_path / "resumed").glob("manifest-*.json"))
    assert checkpoint.read_bytes() == original


@pytest.mark.parametrize("change", ["missing_prefix", "duplicate", "cursor", "wrong_scope", "extra_key"])
def test_actual_cli_rejects_invalid_checkpoint_before_public_reads(tmp_path, monkeypatch, change):
    from catalog_sync import discover_cli
    from catalog_sync.normalize import CatalogueSyncError
    inventory = PublicInventory(61)
    inventory.install(monkeypatch)
    discover_cli.run(public_args(tmp_path, "--max-api-calls", "35"))
    checkpoint = tmp_path / "output" / "scan-checkpoint.json"
    value = json.loads(checkpoint.read_bytes())
    if change == "missing_prefix":
        value["pages"].pop(0)
    elif change == "duplicate":
        value["pages"].append(value["pages"][0])
    elif change == "cursor":
        value["pages"][1]["cursor"] = None
    elif change == "wrong_scope":
        value["scope"] = "0" * 64
    else:
        value["cookie"] = "DO_NOT_ECHO"
    bad = tmp_path / "bad-checkpoint.json"
    bad.write_text(json.dumps(value), encoding="utf-8")
    requests_before = inventory.requests[:]
    with pytest.raises(CatalogueSyncError):
        discover_cli.run(public_args(tmp_path, "--resume-from", str(bad), output="resumed"))
    assert inventory.requests == requests_before
    assert b"DO_NOT_ECHO" not in (tmp_path / "resumed" / "scan-report.json").read_bytes()


def test_actual_cli_checkpoint_contains_stable_metadata_only_and_rejects_unsafe_data(tmp_path, monkeypatch):
    from catalog_sync import discover_cli
    from catalog_sync.normalize import CatalogueSyncError
    inventory = PublicInventory()
    inventory.install(monkeypatch)
    inventory.extra_track = {"unusedPrivateField": "DO_NOT_PERSIST"}
    discover_cli.run(public_args(tmp_path))
    assert b"DO_NOT_PERSIST" not in (tmp_path / "output" / "scan-checkpoint.json").read_bytes()
    inventory.extra_track = {"cookie": "DO_NOT_PERSIST"}
    with pytest.raises(CatalogueSyncError):
        discover_cli.run(public_args(tmp_path, output="unsafe"))
    assert not (tmp_path / "unsafe" / "scan-checkpoint.json").exists()
    assert b"DO_NOT_PERSIST" not in (tmp_path / "unsafe" / "scan-report.json").read_bytes()


def test_actual_cli_counts_http_requests_inside_each_public_method_across_pages(tmp_path, monkeypatch):
    from catalog_sync import discover_cli
    inventory = PublicInventory(61)
    inventory.install(monkeypatch)
    inventory.album_requests = 2
    report = discover_cli.run(public_args(tmp_path, "--max-api-calls", "65"))
    assert len(inventory.requests) == report["apiCalls"] == 65
    assert len(inventory.fetched) == 31
    assert report["complete"] is False
    assert "request_limit" in report["incompleteReasons"]


@pytest.mark.parametrize("cause", ["release_page_limit", "album_tracks_incomplete"])
def test_actual_cli_never_clears_upstream_incompleteness_when_pagination_finishes(tmp_path, monkeypatch, cause):
    from catalog_sync import discover_cli, transport
    from catalog_sync.normalize import CatalogueSyncError
    inventory = PublicInventory()
    inventory.install(monkeypatch)
    extra = []
    if cause == "release_page_limit":
        inventory.paged_listing = True
        extra = ["--page-limit", "31"]
    else:
        inventory.track_count = 2
    report = discover_cli.run(public_args(tmp_path, *extra))
    assert inventory.fetched == inventory.ids
    assert report["complete"] is False
    assert cause in report["incompleteReasons"]
    with pytest.raises(CatalogueSyncError):
        transport.ingest_manifests("https://catalogue.example", tmp_path / "output", "fixture-token", enabled=True)


def test_actual_cli_detects_inventory_drift_between_pages_in_one_run(tmp_path, monkeypatch):
    from catalog_sync import discover_cli
    from catalog_sync.normalize import CatalogueSyncError
    inventory = PublicInventory()
    inventory.install(monkeypatch)
    reads = []
    def change_inventory():
        reads.append(True)
        if len(reads) == 2:
            inventory.ids.append("MPREb_031")
    inventory.on_artist = change_inventory
    with pytest.raises(CatalogueSyncError):
        discover_cli.run(public_args(tmp_path))
    assert len(inventory.fetched) == 30
    assert json.loads((tmp_path / "output" / "scan-report.json").read_bytes())["complete"] is False
    assert len(json.loads((tmp_path / "output" / "scan-checkpoint.json").read_bytes())["pages"]) == 1


def test_actual_cli_runs_with_empty_inventory_without_claiming_progress(tmp_path, monkeypatch):
    from catalog_sync import discover_cli
    inventory = PublicInventory(0)
    inventory.install(monkeypatch)
    report = discover_cli.run(public_args(tmp_path))
    assert report["complete"] is True
    assert report["scannedAlbums"] == report["discovered"] == 0
    assert report["apiCalls"] == 1


def test_actual_cli_retains_the_hard_hundred_album_policy(tmp_path, monkeypatch):
    from catalog_sync import discover_cli
    from catalog_sync.normalize import CatalogueSyncError
    inventory = PublicInventory(101)
    inventory.install(monkeypatch)
    with pytest.raises(CatalogueSyncError):
        discover_cli.run(public_args(tmp_path))
    assert len(inventory.fetched) <= 100
    assert not list((tmp_path / "output").glob("manifest-*.json"))
    assert json.loads((tmp_path / "output" / "scan-report.json").read_bytes())["complete"] is False


def test_atomic_checkpoint_failure_keeps_previous_page_resumable(tmp_path, monkeypatch):
    from catalog_sync import discover_cli
    from catalog_sync.normalize import CatalogueSyncError
    inventory = PublicInventory()
    inventory.install(monkeypatch)
    replace = os.replace
    replacements = []
    def interrupted_replace(source, target):
        replacements.append(True)
        if len(replacements) == 2:
            raise OSError("simulated interrupted checkpoint replacement")
        return replace(source, target)
    monkeypatch.setattr(discover_cli.os, "replace", interrupted_replace)
    with pytest.raises(CatalogueSyncError):
        discover_cli.run(public_args(tmp_path))
    checkpoint = tmp_path / "output" / "scan-checkpoint.json"
    prefix = json.loads(checkpoint.read_bytes())
    assert [page["end_index"] for page in prefix["pages"]] == [30]
    assert json.loads((tmp_path / "output" / "scan-report.json").read_bytes())["complete"] is False
    assert not list((tmp_path / "output").glob("manifest-*.json"))
    monkeypatch.setattr(discover_cli.os, "replace", replace)
    report = discover_cli.run(public_args(tmp_path, "--resume-from", str(checkpoint), output="resumed"))
    assert report["complete"] is True
    assert report["scannedAlbums"] == 31
    # The uncommitted page can be re-read; no previous committed page is fetched again.
    assert inventory.fetched == inventory.ids + ["MPREb_030"]


def test_weekly_command_entrypoint_uses_bounded_pagination(tmp_path, monkeypatch, capsys):
    from catalog_sync import discover_cli
    inventory = PublicInventory()
    inventory.install(monkeypatch)
    cfg = tmp_path / "empty-config.json"
    cfg.write_text('{"schemaVersion":1,"channels":[],"albumGames":{}}', encoding="utf-8")
    monkeypatch.setattr(sys, "argv", ["catalog-discover", "--config", str(cfg),
        "--artist-channel-id", CHANNEL, "--origin", "https://catalogue.example", "--run-id", "weekly-test",
        "--output-dir", str(tmp_path / "weekly-output")])
    assert discover_cli.main() == 0
    assert "complete=true" in capsys.readouterr().out
    assert inventory.fetched == inventory.ids
    assert json.loads((tmp_path / "weekly-output" / "scan-report.json").read_bytes())["complete"] is True
