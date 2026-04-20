#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-http://127.0.0.1:5180}"

echo "[check] base: $BASE_URL"

check_url() {
  local url="$1"
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' "$url")"
  echo "[check] $url -> $code"
}

check_url "$BASE_URL/health"
check_url "$BASE_URL/formulario"
check_url "$BASE_URL/"

echo "\nSe o painel exigir auth, valide manualmente também:"
echo "- /painel"
echo "- /painel/imoveis"
echo "- /painel/clientes"
