#!/usr/bin/env bash
set -euo pipefail

exec bash scripts/secret-scan.sh dist "${1:-dist}"
