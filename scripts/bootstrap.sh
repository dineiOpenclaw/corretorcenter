#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_EXAMPLE="$ROOT_DIR/.env.example"
ENV_FILE="$ROOT_DIR/.env"
SERVICE_TEMPLATE="$ROOT_DIR/deploy/corretorcenter.service.example"
SERVICE_TARGET="/etc/systemd/system/corretorcenter.service"

log() {
  printf '\n[%s] %s\n' "bootstrap" "$1"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "Comando obrigatório não encontrado: $1" >&2; exit 1; }
}

run_privileged() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

run_as_postgres() {
  if id postgres >/dev/null 2>&1; then
    if command -v sudo >/dev/null 2>&1; then
      sudo -u postgres "$@"
      return
    fi
    if command -v su >/dev/null 2>&1; then
      local cmd=""
      printf -v cmd '%q ' "$@"
      su - postgres -c "$cmd"
      return
    fi
  fi
  echo "Não foi possível executar comandos como usuário postgres." >&2
  return 1
}

require_cmd node
require_cmd npm
require_cmd python3
require_cmd ss

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl não encontrado. O bootstrap automático do PostgreSQL exige uma VPS Linux com systemd." >&2
  exit 1
fi

if ! command -v sudo >/dev/null 2>&1 && [[ "$(id -u)" -ne 0 ]]; then
  echo "sudo não encontrado. Rode como root ou instale sudo antes do bootstrap." >&2
  exit 1
fi

get_os_id() {
  if [[ -f /etc/os-release ]]; then
    . /etc/os-release
    echo "${ID:-unknown}"
  else
    echo "unknown"
  fi
}

is_oracle_linux() {
  [[ "$(get_os_id)" == "oraclelinux" || "$(get_os_id)" == "ol" ]]
}

install_postgres_packages() {
  if is_oracle_linux; then
    run_privileged dnf install -y postgresql postgresql-server
    if command -v postgresql-setup >/dev/null 2>&1 && [[ ! -f /var/lib/pgsql/data/PG_VERSION ]]; then
      run_privileged postgresql-setup --initdb
    fi
  else
    run_privileged apt-get update
    run_privileged apt-get install -y postgresql postgresql-contrib postgresql-client
  fi

  run_privileged systemctl enable --now postgresql
}

postgres_access_ok() {
  run_as_postgres psql -tAc 'SELECT 1' >/dev/null 2>&1
}

ensure_postgres_ready() {
  if command -v psql >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q '^postgresql\.service'; then
    if systemctl is-active --quiet postgresql; then
      postgres_access_ok && return 0
    fi
    log "PostgreSQL encontrado, mas parado. Iniciando serviço"
    run_privileged systemctl enable --now postgresql
    postgres_access_ok && return 0
  fi

  log "PostgreSQL não encontrado por completo. Instalando automaticamente"
  install_postgres_packages
  require_cmd psql
  postgres_access_ok
}

load_env_exports() {
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
}

ensure_env_db_values() {
  : "${DB_NAME:?DB_NAME não definido no .env}"
  : "${DB_USER:?DB_USER não definido no .env}"
  : "${DB_PASSWORD:?DB_PASSWORD não definido no .env}"
  : "${DB_HOST:?DB_HOST não definido no .env}"
  : "${DB_PORT:?DB_PORT não definido no .env}"
}

postgres_escape_literal() {
  printf '%s' "$1" | sed "s/'/''/g"
}

ensure_postgres_role_and_database() {
  ensure_env_db_values

  local db_name_escaped db_user_escaped db_password_escaped role_exists db_exists
  db_name_escaped="$(postgres_escape_literal "$DB_NAME")"
  db_user_escaped="$(postgres_escape_literal "$DB_USER")"
  db_password_escaped="$(postgres_escape_literal "$DB_PASSWORD")"

  role_exists="$(run_as_postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname = '$db_user_escaped'")"
  if [[ "$role_exists" != "1" ]]; then
    log "Criando usuário PostgreSQL $DB_USER"
    run_as_postgres psql -v ON_ERROR_STOP=1 -c "CREATE ROLE \"$DB_USER\" LOGIN PASSWORD '$db_password_escaped';"
  else
    log "Alinhando senha do usuário PostgreSQL $DB_USER"
    run_as_postgres psql -v ON_ERROR_STOP=1 -c "ALTER ROLE \"$DB_USER\" WITH LOGIN PASSWORD '$db_password_escaped';"
  fi

  db_exists="$(run_as_postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname = '$db_name_escaped'")"
  if [[ "$db_exists" != "1" ]]; then
    log "Criando banco PostgreSQL $DB_NAME"
    run_as_postgres psql -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$DB_NAME\" OWNER \"$DB_USER\";"
  else
    log "Garantindo ownership do banco PostgreSQL $DB_NAME"
    run_as_postgres psql -v ON_ERROR_STOP=1 -c "ALTER DATABASE \"$DB_NAME\" OWNER TO \"$DB_USER\";"
  fi
}

validate_runtime_port() {
  local app_port="${APP_PORT:-5180}"
  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "(^|:)$app_port$"; then
    echo "A porta ${app_port} já está em uso nesta VPS. Ajuste APP_PORT antes de continuar." >&2
    exit 1
  fi
}

ensure_postgres_ready

if [[ ! -f "$ENV_FILE" ]]; then
  log "Criando .env a partir do .env.example"
  cp "$ENV_EXAMPLE" "$ENV_FILE"
else
  log ".env já existe, mantendo arquivo atual"
fi

load_env_exports
validate_runtime_port
ensure_postgres_role_and_database

log "Instalando dependências Node"
cd "$ROOT_DIR"
PUPPETEER_SKIP_DOWNLOAD=1 npm install

log "Executando migration base"
"$ROOT_DIR/scripts/migrate.sh"

if [[ -f "$SERVICE_TEMPLATE" ]]; then
  log "Template de service disponível em $SERVICE_TEMPLATE"
  echo "Para instalar o service, copie com sudo para: $SERVICE_TARGET"
fi

cat <<EOS

Bootstrap concluído.

Próximos passos:
1. Revisar $ENV_FILE
2. Publicar o service systemd
3. Configurar proxy/SSL/subdomínios no Nginx Proxy Manager
4. Criar categorias iniciais no painel ou via seed opcional futura
EOS
