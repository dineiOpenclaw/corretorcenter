#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"

eval "$(ENV_FILE="$ENV_FILE" python3 - <<'PY'
from pathlib import Path
import os, shlex
env_file = Path(os.environ['ENV_FILE'])
for line in env_file.read_text().splitlines():
    line = line.strip()
    if not line or line.startswith('#') or '=' not in line:
        continue
    key, value = line.split('=', 1)
    key = key.strip()
    value = value.strip()
    if not key or not key.replace('_', '').isalnum() or key[0].isdigit():
        continue
    if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
        value = value[1:-1]
    print(f"export {key}={shlex.quote(value)}")
PY
)"

: "${DB_HOST:?DB_HOST não definido no .env}"
: "${DB_PORT:?DB_PORT não definido no .env}"
: "${DB_NAME:?DB_NAME não definido no .env}"
: "${DB_USER:?DB_USER não definido no .env}"
: "${DB_PASSWORD:?DB_PASSWORD não definido no .env}"

if ! PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c 'SELECT 1' >/dev/null 2>&1; then
  echo "Falha ao validar conexão com PostgreSQL usando DB_HOST/DB_PORT/DB_NAME/DB_USER do .env." >&2
  echo "Revise as credenciais e o provisionamento do banco antes da migration." >&2
  exit 1
fi

for migration in "$ROOT_DIR"/db/migrations/*.sql; do
  [ -f "$migration" ] || continue
  echo "Aplicando migration: $(basename "$migration")"
  PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -f "$migration"
done
