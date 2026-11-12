#!/usr/bin/env bash
set -euo pipefail

scanner=${1:-scripts/secret-scan.sh}
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT

mkdir -p "$temporary/dist"
printf '%s\n' 'ordinary browser output' > "$temporary/dist/app.js"
bash "$scanner" dist "$temporary/dist" >/dev/null

names=(
  private-key-block github-token google-api-key openai-key aws-access-key
  bearer-authorization session-cookie chksz-api-key lx-request-key
  provider-request-key-header netease-login-cookie oauth-client-secret
  worker-secret-name cloudflare-api-token-name
)
fixtures=(
  '-----BEGIN RSA PRIVATE KEY-----'
  'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  'AIzaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  'sk-AAAAAAAAAAAAAAAAAAAA'
  'AKIAAAAAAAAAAAAAAAAA'
  'Authorization: Bearer abcdefghijklmnopqrst'
  '__Host-session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  'CHKSZ_API_KEY'
  'LX_HUIBQ_REQUEST_KEY'
  'x-request-key'
  'MUSIC_U'
  'GOOGLE_CLIENT_SECRET'
  'SESSION_HMAC_SECRET'
  'CLOUDFLARE_API_TOKEN'
)

for index in "${!fixtures[@]}"; do
  fixture=${fixtures[$index]}
  file="$temporary/dist/${names[$index]}.js"
  output="$temporary/output"
  printf '%s\n' "$fixture" > "$file"
  if bash "$scanner" dist "$temporary/dist" >"$output" 2>&1; then
    echo "secret scan self-test: ${names[$index]} was not rejected" >&2
    exit 1
  fi
  grep -Fq "${names[$index]} matched in" "$output"
  if grep -Fq -- "$fixture" "$output"; then
    echo "secret scan self-test: ${names[$index]} leaked its value" >&2
    exit 1
  fi
  rm "$file"
done

echo "secret scan self-test: ${#fixtures[@]} injected signatures rejected without value disclosure"
