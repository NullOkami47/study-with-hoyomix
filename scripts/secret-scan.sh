#!/usr/bin/env bash
set -euo pipefail

mode=${1:-}
root=${2:-dist}

names=(
  private-key-block github-token google-api-key openai-key aws-access-key
  bearer-authorization session-cookie chksz-api-key lx-request-key
  provider-request-key-header netease-login-cookie oauth-client-secret
  worker-secret-name cloudflare-api-token-name
)
patterns=(
  '-----BEGIN (RSA|EC|DSA|OPENSSH) PRIVATE KEY-----'
  'gh[pousr]_[A-Za-z0-9_]{30,}'
  'AIza[0-9A-Za-z_-]{35}'
  'sk-[A-Za-z0-9_-]{20,}'
  '(AKIA|ASIA)[0-9A-Z]{16}'
  'Authorization[=:][[:space:]]*Bearer[[:space:]]+[A-Za-z0-9._~+/-]{20,}'
  '__Host-session=[A-Za-z0-9_-]{43}'
  'CHKSZ_API_KEY'
  'LX_(HUIBQ|IKUN)_REQUEST_KEY'
  'x-request-key'
  'MUSIC_U'
  '(GOOGLE|GITHUB|LINUXDO)_CLIENT_SECRET'
  '(SESSION_HMAC_SECRET|OAUTH_STATE_SECRET)'
  'CLOUDFLARE_API_TOKEN'
)

scan_dist() {
  test -d "$root"
  local failed=0
  local index
  for index in "${!patterns[@]}"; do
    while IFS= read -r match; do
      test -n "$match" || continue
      echo "dist secret scan: ${names[$index]} matched in ${match}" >&2
      failed=1
    done < <(grep -rIlE -- "${patterns[$index]}" "$root" || true)
  done
  if [ "$failed" -ne 0 ]; then
    echo 'Operator-only material must never reach the built browser bundle.' >&2
    return 1
  fi
  echo 'dist secret scan: clean'
}

scan_tracked() {
  local failed=0
  local index
  for index in 0 1 2 3 4 5 6; do
    while IFS= read -r match; do
      test -n "$match" || continue
      echo "tracked secret scan: ${names[$index]} matched in ${match}" >&2
      failed=1
    done < <(git grep -IlE -e "${patterns[$index]}" -- \
      ':!package-lock.json' \
      ':!.github/workflows/ci.yml' \
      ':!scripts/secret-scan.sh' \
      ':!scripts/test-secret-scan.sh' \
      ':!*.example' \
      ':!*.example.*' || true)
  done
  if [ "$failed" -ne 0 ]; then
    echo 'High-confidence secret-like material was found in tracked files.' >&2
    return 1
  fi
  echo 'tracked secret scan: clean'
}

case "$mode" in
  dist) scan_dist ;;
  tracked) scan_tracked ;;
  *) echo 'usage: scripts/secret-scan.sh <dist|tracked> [dist-directory]' >&2; exit 2 ;;
esac
