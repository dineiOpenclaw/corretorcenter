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
    if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
        value = value[1:-1]
    print(f"export {key}={shlex.quote(value)}")
PY
)"

PG_URL="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"

psql "$PG_URL" <<'SQL'
INSERT INTO categorias_imovel (slug, nome_exibicao, sigla_codigo, pasta_slug, ativa)
VALUES
  ('casa', 'Casa', 'CA', 'casas', true),
  ('apartamento', 'Apartamento', 'AP', 'apartamentos', true),
  ('terreno', 'Terreno', 'TE', 'terrenos', true),
  ('comercial', 'Comercial', 'CO', 'comerciais', true)
ON CONFLICT (slug) DO NOTHING;
SQL

echo "Seed opcional de categorias aplicada com sucesso."
