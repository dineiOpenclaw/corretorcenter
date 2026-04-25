#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_EXAMPLE="$ROOT_DIR/.env.example"
ENV_FILE="$ROOT_DIR/.env"

log() { printf '\n[env] %s\n' "$*"; }

validate_domain() {
  local d="${1,,}"
  [[ "$d" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]]
}

validate_email() {
  local email="${1}"
  [[ "$email" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]
}

set_env_value() {
  local key="$1" value="$2" file="$3"
  python3 - "$key" "$value" "$file" <<'PY'
import sys
key, value, path = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    with open(path, 'r', encoding='utf-8') as f:
        lines = f.read().splitlines()
except FileNotFoundError:
    lines = []

out=[]
found=False
prefix=key+'='
for line in lines:
    if line.startswith(prefix):
        out.append(prefix+value)
        found=True
    else:
        out.append(line)
if not found:
    out.append(prefix+value)
with open(path, 'w', encoding='utf-8') as f:
    f.write('\n'.join(out)+"\n")
PY
}

main() {
  if [[ ! -f "$ENV_FILE" ]]; then
    if [[ ! -f "$ENV_EXAMPLE" ]]; then
      echo "Arquivo .env.example não encontrado em $ENV_EXAMPLE" >&2
      exit 1
    fi
    log "Criando .env a partir do .env.example"
    cp "$ENV_EXAMPLE" "$ENV_FILE"
  else
    log "Usando .env existente (vou atualizar apenas as chaves necessárias)"
  fi

  while true; do
    read -r -p "Domínio do painel (ex.: painel.seudominio.com): " PANEL_DOMAIN
    PANEL_DOMAIN="${PANEL_DOMAIN,,}"
    validate_domain "$PANEL_DOMAIN" && break
    echo "Domínio inválido." >&2
  done

  while true; do
    read -r -p "Domínio do formulário (ex.: form.seudominio.com): " FORM_DOMAIN
    FORM_DOMAIN="${FORM_DOMAIN,,}"
    validate_domain "$FORM_DOMAIN" && break
    echo "Domínio inválido." >&2
  done

  while true; do
    read -r -p "Domínio da galeria (ex.: galeria.seudominio.com): " GALLERY_DOMAIN
    GALLERY_DOMAIN="${GALLERY_DOMAIN,,}"
    validate_domain "$GALLERY_DOMAIN" && break
    echo "Domínio inválido." >&2
  done

  while true; do
    read -r -p "Domínio das imagens (ex.: imagens.seudominio.com): " IMAGES_DOMAIN
    IMAGES_DOMAIN="${IMAGES_DOMAIN,,}"
    validate_domain "$IMAGES_DOMAIN" && break
    echo "Domínio inválido." >&2
  done

  read -r -p "Usuário do painel: " PANEL_ADMIN_USER
  PANEL_ADMIN_USER="${PANEL_ADMIN_USER:-}"
  if [[ -z "$PANEL_ADMIN_USER" ]]; then
    echo "Usuário do painel não pode ficar vazio." >&2
    exit 1
  fi

  read -r -p "Senha do painel (visível): " PANEL_ADMIN_PASSWORD
  PANEL_ADMIN_PASSWORD="${PANEL_ADMIN_PASSWORD:-}"
  if [[ -z "$PANEL_ADMIN_PASSWORD" ]]; then
    echo "Senha do painel não pode ficar vazia." >&2
    exit 1
  fi

  while true; do
    echo ""
    echo "O e-mail de recuperação é importante e deve ser um e-mail válido."
    read -r -p "E-mail para recuperação de senha: " PANEL_RECOVERY_EMAIL
    PANEL_RECOVERY_EMAIL="${PANEL_RECOVERY_EMAIL:-}"
    validate_email "$PANEL_RECOVERY_EMAIL" && break
    echo "E-mail inválido. Informe um endereço real para recuperação de acesso." >&2
  done

  log "Atualizando .env"
  set_env_value PANEL_DOMAIN "$PANEL_DOMAIN" "$ENV_FILE"
  set_env_value FORM_DOMAIN "$FORM_DOMAIN" "$ENV_FILE"
  set_env_value GALLERY_DOMAIN "$GALLERY_DOMAIN" "$ENV_FILE"
  set_env_value IMAGES_DOMAIN "$IMAGES_DOMAIN" "$ENV_FILE"
  set_env_value PANEL_ADMIN_USER "$PANEL_ADMIN_USER" "$ENV_FILE"
  set_env_value PANEL_ADMIN_PASSWORD "$PANEL_ADMIN_PASSWORD" "$ENV_FILE"
  set_env_value PANEL_RECOVERY_EMAIL "$PANEL_RECOVERY_EMAIL" "$ENV_FILE"

  log "Concluído. Próximo passo: ./scripts/install-wizard.sh"
}

main "$@"
