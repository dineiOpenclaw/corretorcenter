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
require_cmd psql

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
2. Configurar domínio/nginx/SSL
3. Publicar o service systemd
4. Criar categorias iniciais no painel ou via seed opcional futura
5. Subir o app com: node app/server.js
EOF
