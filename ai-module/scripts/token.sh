#!/usr/bin/env bash
# Print an access token for a demo account. Local demo only (password grant).
# Usage: scripts/token.sh wei.acad.sh   (or: make -s token ACCOUNT=wei.acad.sh)
set -euo pipefail

user="${1:?usage: token.sh <username>}"
port="${STARIT_KEYCLOAK_PORT:-8080}"
password="${STARIT_DEMO_PASSWORD:-demo-pass-123}"

curl -sf -X POST "http://localhost:${port}/realms/starit/protocol/openid-connect/token" \
  -d grant_type=password -d client_id=starit-web \
  -d "username=${user}" -d "password=${password}" |
  python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])'
