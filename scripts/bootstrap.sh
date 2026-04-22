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

require_cmd node
require_cmd npm

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl não encontrado. O bootstrap automático do PostgreSQL exige uma VPS Linux com systemd." >&2
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
  if ! command -v sudo >/dev/null 2>&1; then
    echo "sudo não encontrado. Instale o PostgreSQL manualmente ou rode como root." >&2
    exit 1
  fi

  if is_oracle_linux; then
    sudo dnf install -y postgresql postgresql-server
    if command -v postgresql-setup >/dev/null 2>&1 && [[ ! -f /var/lib/pgsql/data/PG_VERSION ]]; then
      sudo postgresql-setup --initdb
    fi
  else
    sudo apt-get update
    sudo apt-get install -y postgresql postgresql-contrib postgresql-client
  fi

  sudo systemctl enable --now postgresql
}

ensure_postgres_ready() {
  if command -v psql >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q '^postgresql\.service'; then
    if systemctl is-active --quiet postgresql; then
      return 0
    fi
    log "PostgreSQL encontrado, mas parado. Iniciando serviço"
    sudo systemctl enable --now postgresql
    return 0
  fi

  log "PostgreSQL não encontrado por completo. Instalando automaticamente"
  install_postgres_packages
  require_cmd psql
}

ensure_postgres_ready

if [[ ! -f "$ENV_FILE" ]]; then
  log "Criando .env a partir do .env.example"
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  echo "Edite $ENV_FILE antes de subir em produção."
else
  log ".env já existe, mantendo arquivo atual"
fi

log "Instalando dependências Node"
cd "$ROOT_DIR"
PUPPETEER_SKIP_DOWNLOAD=1 npm install

log "Executando migration base"
"$ROOT_DIR/scripts/migrate.sh"

if [[ -f "$SERVICE_TEMPLATE" ]]; then
  log "Template de service disponível em $SERVICE_TEMPLATE"
  echo "Para instalar o service, copie com sudo para: $SERVICE_TARGET"
fi

cat <<EOF

Bootstrap concluído.

Próximos passos:
1. Revisar $ENV_FILE
2. Configurar domínio/Caddy/HTTPS
3. Publicar o service systemd
4. Criar categorias iniciais no painel ou via seed opcional futura
5. Subir o app com: node app/server.js
EOF
