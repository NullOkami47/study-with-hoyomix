"""Command-line entry point for public catalogue review discovery."""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .normalize import CatalogueSyncError, build_review, dumps_review, normalize_discovery
from .ytmusic import DiscoveryError, discover_artist_releases


_TIMESTAMP = re.compile(r"^[0-9]{8}T[0-9]{6}Z$")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Discover unauthenticated public YouTube Music metadata into a review diff."
    )
    parser.add_argument(
        "--artist-channel-id",
        action="append",
        required=True,
        help="Public HOYO-MiX artist/channel browse ID; repeat for each channel.",
    )
    parser.add_argument(
        "--catalogue",
        type=Path,
        default=Path("src/features/catalog/catalog.sample.json"),
        help="Approved canonical catalogue JSON to read (never written).",
    )
    parser.add_argument(
        "--review-dir",
        type=Path,
        default=Path("data/catalog/review"),
        help="Directory for timestamped review JSON.",
    )
    parser.add_argument(
        "--timestamp",
        help="Optional reproducible UTC filename timestamp in YYYYMMDDTHHMMSSZ form.",
    )
    return parser


def _read_catalogue(path: Path) -> list[dict[str, Any]]:
    with path.open("r", encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, list) or any(not isinstance(track, dict) for track in value):
        raise CatalogueSyncError("approved catalogue must be a JSON array of objects")
    return value


def run(args: argparse.Namespace) -> Path:
    approved_path = args.catalogue.resolve()
    approved = _read_catalogue(approved_path)
    releases = discover_artist_releases(args.artist_channel_id)
    review = build_review(normalize_discovery(releases), approved)
    output = dumps_review(review)

    timestamp = args.timestamp or datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    if not _TIMESTAMP.fullmatch(timestamp):
        raise CatalogueSyncError("timestamp must use YYYYMMDDTHHMMSSZ")
    args.review_dir.mkdir(parents=True, exist_ok=True)
    output_path = (args.review_dir / f"{timestamp}.json").resolve()
    if output_path == approved_path:
        raise CatalogueSyncError("review output cannot overwrite the approved catalogue")
    with output_path.open("xb") as handle:
        handle.write(output)
    return output_path


def main() -> int:
    parser = _parser()
    try:
        output = run(parser.parse_args())
    except (CatalogueSyncError, DiscoveryError, json.JSONDecodeError, OSError) as error:
        parser.exit(1, f"catalog-sync: {error}\n")
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
