"""Optional workflow sidecar. Only this explicit command can attempt ingestion."""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from .transport import ingest_manifests


def main() -> int:
    parser = argparse.ArgumentParser(description="Explicitly opt into discovery review ingestion; no publication.")
    parser.add_argument("--origin", required=True)
    parser.add_argument("--artifact-dir", type=Path, required=True)
    parser.add_argument("--enable-ingest", action="store_true")
    args = parser.parse_args()
    try:
        count = ingest_manifests(args.origin, args.artifact_dir,
                                 os.environ.get("DISCOVERY_INGEST_TOKEN", ""), enabled=args.enable_ingest)
    except Exception:
        print("catalog-discover: ingestion stopped; details redacted; no retry attempted", file=sys.stderr)
        return 1
    print(f"catalog-discover: {count} review manifests accepted")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
