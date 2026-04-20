#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
BACKUP_ROOT="$ROOT_DIR/backup_cleber"
TS="$(date +%Y-%m-%d_%H-%M-%S)"
DEST="$BACKUP_ROOT/$TS"
SQL_DIR="$DEST/sql"
STORAGE_DEST="$DEST/storage"
MANIFEST_FILE="$DEST/manifest.txt"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Arquivo .env não encontrado em $ENV_FILE" >&2
  exit 1
fi

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

mkdir -p "$SQL_DIR"
mkdir -p "$STORAGE_DEST"

printf 'timestamp=%s\n' "$TS" > "$MANIFEST_FILE"
printf 'db_name=%s\n' "${DB_NAME:-}" >> "$MANIFEST_FILE"
printf 'media_root=%s\n' "${MEDIA_ROOT:-$ROOT_DIR/storage/images}" >> "$MANIFEST_FILE"
printf 'mode=full-replace\n' >> "$MANIFEST_FILE"

echo "[backup] Gerando dump SQL..."
PGPASSWORD="$DB_PASSWORD" pg_dump -h "$DB_HOST" -p "${DB_PORT:-5432}" -U "$DB_USER" -d "$DB_NAME" > "$SQL_DIR/backup.sql"

echo "[backup] Copiando storage..."
rm -rf "$STORAGE_DEST"
cp -a "$ROOT_DIR/storage" "$STORAGE_DEST"

ARCHIVE_PATH="$BACKUP_ROOT/${TS}.tar.gz"

echo "[backup] Compactando backup..."
tar -czf "$ARCHIVE_PATH" -C "$BACKUP_ROOT" "$TS"

echo "[backup] Backup criado em: $DEST"
echo "[backup] Arquivo para download: $ARCHIVE_PATH"
