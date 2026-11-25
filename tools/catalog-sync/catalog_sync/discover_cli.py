"""catalog-discover: read-only scanner. AI and completeness stay in sidecar artifacts."""
from __future__ import annotations

import argparse
from dataclasses import asdict, fields
from hashlib import sha256
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from time import monotonic
from typing import Any

from .ai import DeterministicAdapter, ImportedJsonAdapter, build_suggestions
from .discovery import CHANNEL, RUN, DiscoveryConfig, batch_manifests, fail, identifier, keys, scan_releases, text
from .jsonio import read_json
from .normalize import CatalogueSyncError, dumps_review
from .transport import fetch_catalogue
from .ytmusic import BoundedReleases, discover_bounded_releases, merge_bounded_releases


DEFAULT_CONFIG = Path("tools/catalog-sync/discovery-config.json")


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description="Bounded unauthenticated public discovery; review artifacts only.")
    value.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    value.add_argument("--artist-channel-id", action="append", default=[], help="Explicit operator-confirmed UC channel ID; no handles or name resolution.")
    baseline = value.add_mutually_exclusive_group()
    baseline.add_argument("--catalogue", type=Path, help="Read-only local canonical array or public API envelope.")
    baseline.add_argument("--origin", help="Bare public HTTPS origin; GET /api/catalogue without credentials.")
    value.add_argument("--fixture", type=Path, help="Explicit offline fallback; never automatically used after API failures.")
    value.add_argument("--suggestions-json", type=Path, help="Strict manual agent JSON; separate review artifact only.")
    value.add_argument("--run-id", default=datetime.now(timezone.utc).strftime("discovery-%Y%m%dT%H%M%SZ"))
    value.add_argument("--output-dir", type=Path, required=True, help="New exclusive artifact directory.")
    value.add_argument("--resume-from", type=Path, help="Resume a bounded public checkpoint into a new output directory.")
    value.add_argument("--max-albums", type=int, default=100, help="Whole-scan album ceiling (pages contain at most 30).")
    value.add_argument("--page-limit", type=int, default=100)
    value.add_argument("--max-api-calls", type=int, default=80)
    value.add_argument("--max-seconds", type=int, default=240)
    value.add_argument("--max-discoveries", type=int, default=1000)
    return value


_CHECKPOINT_BYTES = 10 * 1024 * 1024
_PAGE_REASONS = {"album_limit", "request_limit", "time_limit", "release_page_limit",
                 "album_track_limit", "album_tracks_incomplete", "continuation_requires_merge"}


def _checkpoint_scope(args: argparse.Namespace, cfg: DiscoveryConfig) -> str:
    # Bind classification as well as inventory scope. Never persist operator paths or origins.
    return sha256(dumps_review({"channels": cfg.channels, "albumGames": cfg.album_games,
        "pageLimit": args.page_limit, "maxAlbums": args.max_albums})).hexdigest()


def _checkpoint_release(release: dict) -> dict:
    def selected(value, names):
        result = {}
        for name in names:
            if name not in value:
                continue
            item = value[name]
            if item is not None and type(item) not in (str, int, float, bool):
                fail("invalid checkpoint metadata")
            if isinstance(item, str) and item.strip():
                text(item, "checkpoint metadata", 16384)
            result[name] = item
        return result

    summary = selected(release.get("summary", {}), ("title", "playlistId"))
    album = selected(release["album"], ("title", "audioPlaylistId", "releaseDate", "trackCount"))
    album["tracks"] = [selected(track, ("videoId", "title", "duration", "duration_seconds", "isAvailable"))
                       for track in release["album"]["tracks"]]
    return {"artistChannelId": release["artistChannelId"], "albumBrowseId": release["albumBrowseId"],
            "summary": summary, "album": album}


def _write_checkpoint(args: argparse.Namespace, cfg: DiscoveryConfig, pages: list[BoundedReleases]) -> None:
    records = []
    for page in pages:
        # Validate raw data before projecting stable fields; no upstream secrets/media are durable.
        scan_releases(page.releases, [], cfg, incomplete_reasons=page.incomplete_reasons)
        record = asdict(page)
        record["releases"] = [_checkpoint_release(release) for release in page.releases]
        records.append(record)
    data = dumps_review({"schemaVersion": 1, "scope": _checkpoint_scope(args, cfg), "pages": records})
    if len(data) > _CHECKPOINT_BYTES:
        fail("checkpoint exceeds size limit")
    temporary = args.output_dir / "scan-checkpoint.tmp"
    with temporary.open("xb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, args.output_dir / "scan-checkpoint.json")


def _read_checkpoint(args: argparse.Namespace, cfg: DiscoveryConfig) -> list[BoundedReleases]:
    if args.resume_from is None:
        return []
    if args.fixture or args.resume_from.is_symlink():
        fail("checkpoint requires public discovery and a regular file")
    value = read_json(args.resume_from, _CHECKPOINT_BYTES)
    keys(value, {"schemaVersion", "scope", "pages"})
    if (type(value["schemaVersion"]) is not int or value["schemaVersion"] != 1
            or value["scope"] != _checkpoint_scope(args, cfg)
            or not isinstance(value["pages"], list) or not 1 <= len(value["pages"]) <= 100):
        fail("invalid or out-of-scope checkpoint")
    pages = []
    for record in value["pages"]:
        keys(record, {field.name for field in fields(BoundedReleases)})
        for name, maximum in (("inventory_size", 100), ("start_index", 100), ("end_index", 100), ("api_calls", 200)):
            if type(record[name]) is not int or not 0 <= record[name] <= maximum:
                fail("invalid checkpoint bounds")
        if (not isinstance(record["inventory_id"], str) or not re.fullmatch(r"[a-f0-9]{64}", record["inventory_id"])
                or not isinstance(record["incomplete_reasons"], list)
                or any(not isinstance(reason, str) or reason not in _PAGE_REASONS for reason in record["incomplete_reasons"])
                or len(set(record["incomplete_reasons"])) != len(record["incomplete_reasons"])
                or record["end_index"] <= record["start_index"]):
            fail("invalid checkpoint progress")
        scan_releases(record["releases"], [], cfg, incomplete_reasons=record["incomplete_reasons"])
        if record["releases"] != [_checkpoint_release(release) for release in record["releases"]]:
            fail("checkpoint contains unexpected metadata")
        pages.append(BoundedReleases(**record))
    merged = merge_bounded_releases(pages)
    if merged.next_cursor is None or merged.end_index >= args.max_albums:
        fail("checkpoint has no resumable work within the album budget")
    return pages


def _discover_pages(args: argparse.Namespace, cfg: DiscoveryConfig, pages: list[BoundedReleases]) -> BoundedReleases:
    deadline = monotonic() + args.max_seconds
    calls = 0
    position = pages[-1].end_index if pages else 0
    cursor = pages[-1].next_cursor if pages else None
    reasons: set[str] = set()
    for _ in range(100):
        if position >= args.max_albums:
            reasons.add("album_limit")
            break
        if calls >= args.max_api_calls:
            reasons.add("request_limit")
            break
        if monotonic() >= deadline:
            reasons.add("time_limit")
            break
        found = discover_bounded_releases(cfg.channels, max_albums=min(30, args.max_albums - position),
            page_limit=args.page_limit, max_api_calls=args.max_api_calls - calls,
            max_seconds=args.max_seconds, cursor=cursor, deadline=deadline)
        calls += found.api_calls
        if found.inventory_id is None:
            reasons.update(found.incomplete_reasons)
            break
        if found.next_cursor is not None and found.end_index <= position:
            reasons.update(found.incomplete_reasons)
            reasons.add("no_progress")
            break
        pages.append(found)
        merged = merge_bounded_releases(pages)
        _write_checkpoint(args, cfg, pages)
        if found.next_cursor is None:
            merged.api_calls = calls
            return merged
        position = found.end_index
        cursor = found.next_cursor
    if pages:
        merged = merge_bounded_releases(pages)
    else:
        merged = BoundedReleases([], [], calls)
    merged.api_calls = calls
    merged.incomplete_reasons = sorted(set(merged.incomplete_reasons) | reasons)
    return merged


def run(args: argparse.Namespace) -> dict[str, Any]:
    identifier(args.run_id, RUN, "runId")
    args.output_dir.mkdir(parents=True, exist_ok=False)
    try:
        bounds = ((args.max_albums, 100), (args.page_limit, 100), (args.max_api_calls, 200),
                  (args.max_seconds, 300), (args.max_discoveries, 1000))
        if any(type(value) is not int or not 1 <= value <= maximum for value, maximum in bounds):
            fail("invalid discovery limits")
        config_value = read_json(args.config, 256 * 1024)
        cfg = DiscoveryConfig.from_dict(config_value)
        for channel in args.artist_channel_id:
            identifier(channel, CHANNEL, "operator channel ID")
            cfg.channels.setdefault(channel, [])
        if not cfg.channels or len(cfg.channels) > 4:
            fail("one to four explicit public channel IDs are required")
        pages = _read_checkpoint(args, cfg)
        if args.origin:
            catalogue = fetch_catalogue(args.origin)
            baseline_source = "public-api"
        elif args.catalogue:
            catalogue = read_json(args.catalogue)
            baseline_source = "local-file"
        else:
            catalogue = []
            baseline_source = "none"
        reasons = [] if baseline_source != "none" else ["baseline_unconfigured"]
        api_calls = 0
        if args.fixture:
            fixture = read_json(args.fixture)
            keys(fixture, {"schemaVersion", "releases"})
            if type(fixture["schemaVersion"]) is not int or fixture["schemaVersion"] != 1:
                fail("unsupported fixture schemaVersion")
            releases = fixture["releases"]
            source = "fixture"
        else:
            found = _discover_pages(args, cfg, pages)
            releases = found.releases
            reasons.extend(found.incomplete_reasons)
            api_calls = found.api_calls
            source = "public-ytmusic"
        result = scan_releases(releases, catalogue, cfg, max_discoveries=args.max_discoveries,
                               incomplete_reasons=reasons)
        manifests = batch_manifests(result.discoveries, args.run_id)
        adapter = ImportedJsonAdapter(read_json(args.suggestions_json)) if args.suggestions_json else DeterministicAdapter()
        suggestions = build_suggestions(result.discoveries, adapter)
        names = [f"manifest-{index + 1:04d}.json" for index in range(len(manifests))]
        result.report.update({"runId": args.run_id, "source": source, "catalogueSource": baseline_source,
                              "apiCalls": api_calls, "manifests": names})
        result.report["limits"].update({"maxAlbums": args.max_albums, "pageLimit": args.page_limit,
            "maxApiCalls": args.max_api_calls, "maxSeconds": args.max_seconds, "maxChannels": 4,
            "maxTracksPerAlbum": 1000, "maxResponseBytes": 8 * 1024 * 1024})
        outputs = [(name, dumps_review(manifest)) for name, manifest in zip(names, manifests)]
        outputs += [("suggestions.json", dumps_review(suggestions)), ("scan-report.json", dumps_review(result.report))]
        for name, data in outputs:
            with (args.output_dir / name).open("xb") as handle:
                handle.write(data)
        return result.report
    except (Exception, KeyboardInterrupt):
        # Neither public response bodies, exception text nor operator paths reach artifacts/logs.
        failure = {"schemaVersion": 1, "complete": False, "incompleteReasons": ["scan_failed"], "manifests": []}
        report_path = args.output_dir / "scan-report.json"
        if not report_path.exists():
            report_path.write_bytes(dumps_review(failure))
        raise CatalogueSyncError("scan failed; details redacted") from None


def main() -> int:
    args = parser().parse_args()
    try:
        report = run(args)
    except Exception:
        print("catalog-discover: scan failed (details redacted)", file=__import__("sys").stderr)
        return 1
    print(f"catalog-discover: {report['discovered']} discoveries; {len(report['manifests'])} manifests; complete={str(report['complete']).lower()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
