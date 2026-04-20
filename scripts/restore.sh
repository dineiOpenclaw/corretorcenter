#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Uso: $0 <caminho-do-backup>" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
BACKUP_INPUT="$1"
SERVICE_NAME="${SERVICE_NAME:-corretorcenter}"
TMP_RESTORE_DIR=""

if [[ -d "$BACKUP_INPUT" ]]; then
  BACKUP_DIR="$BACKUP_INPUT"
elif [[ -f "$BACKUP_INPUT" ]]; then
  TMP_RESTORE_DIR="$(mktemp -d)"
  tar -xzf "$BACKUP_INPUT" -C "$TMP_RESTORE_DIR"
  BACKUP_DIR="$(find "$TMP_RESTORE_DIR" -mindepth 1 -maxdepth 1 -type d | head -n1)"
else
  echo "Backup não encontrado: $BACKUP_INPUT" >&2
  exit 1
fi

SQL_FILE="$BACKUP_DIR/sql/backup.sql"
STORAGE_BACKUP="$BACKUP_DIR/storage"
STORAGE_TARGET="$ROOT_DIR/storage"

if [[ ! -f "$SQL_FILE" ]]; then
  echo "Arquivo SQL não encontrado: $SQL_FILE" >&2
  exit 1
fi

if [[ ! -d "$STORAGE_BACKUP" ]]; then
  echo "Pasta storage do backup não encontrada: $STORAGE_BACKUP" >&2
  exit 1
fi

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

stop_service() {
  if command -v systemctl >/dev/null 2>&1; then
    if systemctl list-unit-files | grep -q "^${SERVICE_NAME}\.service"; then
      sudo systemctl stop "$SERVICE_NAME" || systemctl stop "$SERVICE_NAME" || true
    fi
  fi
}

start_service() {
  if command -v systemctl >/dev/null 2>&1; then
    if systemctl list-unit-files | grep -q "^${SERVICE_NAME}\.service"; then
      sudo systemctl start "$SERVICE_NAME" || systemctl start "$SERVICE_NAME" || true
    fi
  fi
}

echo "[restore] Parando serviço..."
stop_service

echo "[restore] Limpando schema público atual..."
PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "${DB_PORT:-5432}" -U "$DB_USER" -d "$DB_NAME" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"

echo "[restore] Restaurando banco SQL..."
PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "${DB_PORT:-5432}" -U "$DB_USER" -d "$DB_NAME" < "$SQL_FILE"

echo "[restore] Substituindo storage atual..."
rm -rf "$STORAGE_TARGET"
cp -a "$STORAGE_BACKUP" "$STORAGE_TARGET"

echo "[restore] Subindo serviço..."
start_service

if [[ -n "$TMP_RESTORE_DIR" && -d "$TMP_RESTORE_DIR" ]]; then
  rm -rf "$TMP_RESTORE_DIR"
fi

echo "[restore] Restore concluído a partir de: $BACKUP_INPUT"
