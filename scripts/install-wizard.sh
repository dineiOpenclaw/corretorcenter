#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_EXAMPLE="$ROOT_DIR/.env.example"
ENV_FILE="$ROOT_DIR/.env"
BOOTSTRAP_SCRIPT="$ROOT_DIR/scripts/bootstrap.sh"
SERVICE_TEMPLATE="$ROOT_DIR/deploy/corretorcenter.service.example"
SERVICE_OUTPUT="$ROOT_DIR/deploy/corretorcenter.generated.service"
DEFAULT_APP_PORT="5180"

log() { printf '\n[wizard] %s\n' "$*"; }
warn() { printf '\n[wizard][aviso] %s\n' "$*" >&2; }

run_privileged() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

is_oracle_linux() {
  [[ -f /etc/os-release ]] || return 1
  . /etc/os-release
  [[ "${ID:-}" == "oraclelinux" || "${ID:-}" == "ol" || "${ID_LIKE:-}" == *rhel* ]]
}

install_packages() {
  local packages=("$@")
  if ! command -v sudo >/dev/null 2>&1 && [[ "$(id -u)" -ne 0 ]]; then
    echo "sudo não encontrado. Instale manualmente: ${packages[*]}" >&2
    return 1
  fi
  if is_oracle_linux; then
    run_privileged dnf install -y "${packages[@]}"
  else
    run_privileged apt-get update
    run_privileged apt-get install -y "${packages[@]}"
  fi
}

ensure_cmd() {
  local cmd="$1"; shift
  if command -v "$cmd" >/dev/null 2>&1; then
    return 0
  fi
  log "Dependência faltando: $cmd"
  install_packages "$@"
  command -v "$cmd" >/dev/null 2>&1
}

ensure_systemctl() {
  command -v systemctl >/dev/null 2>&1 || {
    echo "systemctl não encontrado. Este instalador requer systemd." >&2
    exit 1
  }
}

ensure_postgres() {
  if command -v psql >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q '^postgresql\.service'; then
    run_privileged systemctl enable --now postgresql || true
    return 0
  fi

  log "Instalando PostgreSQL local"
  if is_oracle_linux; then
    install_packages postgresql postgresql-server
    if command -v postgresql-setup >/dev/null 2>&1 && [[ ! -f /var/lib/pgsql/data/PG_VERSION ]]; then
      run_privileged postgresql-setup --initdb
    fi
  else
    install_packages postgresql postgresql-contrib postgresql-client
  fi

  run_privileged systemctl enable --now postgresql
}

ensure_pdf_engine() {
  if command -v wkhtmltopdf >/dev/null 2>&1; then
    return 0
  fi
  log "Instalando wkhtmltopdf (motor de PDF)"
  install_packages wkhtmltopdf
}

read_env_value() {
  local key="$1" file="$2"
  [[ -f "$file" ]] || return 1
  python3 - "$key" "$file" <<'PY'
import sys
key, path = sys.argv[1], sys.argv[2]
with open(path, 'r', encoding='utf-8') as f:
    for line in f:
        if line.startswith(key + '='):
            print(line.split('=', 1)[1].rstrip('\n'))
            raise SystemExit(0)
raise SystemExit(1)
PY
}

require_env_keys() {
  local missing=()
  for k in "$@"; do
    local v
    v="$(read_env_value "$k" "$ENV_FILE" 2>/dev/null || true)"
    [[ -n "${v:-}" ]] || missing+=("$k")
  done
  if (( ${#missing[@]} )); then
    echo "Faltam variáveis no .env: ${missing[*]}" >&2
    echo "Rode: ./scripts/configure-env.sh" >&2
    exit 1
  fi
}

fail_if_placeholder_env() {
  local key="$1" current="$2" placeholder="$3"
  if [[ "$current" == "$placeholder" ]]; then
    echo "A variável $key ainda está com valor de exemplo no .env. Ajuste antes de continuar." >&2
    echo "Rode: ./scripts/configure-env.sh" >&2
    exit 1
  fi
}

prepare_service_file() {
  [[ -f "$SERVICE_TEMPLATE" ]] || return 1
  local workdir="$ROOT_DIR"
  local node_bin run_user run_group
  node_bin="$(command -v node)"
  [[ -n "$node_bin" ]] || return 1
  run_user="${SUDO_USER:-$(id -un)}"
  run_group="$(id -gn "$run_user")"

  sed \
    -e "s|__WORKDIR__|$workdir|g" \
    -e "s|__NODE_BIN__|$node_bin|g" \
    -e "s|__RUN_USER__|$run_user|g" \
    -e "s|__RUN_GROUP__|$run_group|g" \
    "$SERVICE_TEMPLATE" > "$SERVICE_OUTPUT"
}

publish_service_file() {
  local target="/etc/systemd/system/corretorcenter.service"
  run_privileged cp "$SERVICE_OUTPUT" "$target"
  run_privileged systemctl daemon-reload
  run_privileged systemctl enable --now corretorcenter
}

validate_local_health() {
  local port="$1"
  for _ in $(seq 1 20); do
    if curl -fsS "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

main() {
  ensure_systemctl

  log "Verificando .env"
  if [[ ! -f "$ENV_FILE" ]]; then
    warn ".env não encontrado"
    if [[ -f "$ENV_EXAMPLE" ]]; then
      warn "Crie o .env com: ./scripts/configure-env.sh"
    fi
    exit 1
  fi

  require_env_keys PANEL_DOMAIN FORM_DOMAIN GALLERY_DOMAIN IMAGES_DOMAIN PANEL_ADMIN_USER PANEL_ADMIN_PASSWORD PANEL_RECOVERY_EMAIL SMTP_HOST SMTP_PORT SMTP_SECURE SMTP_USER SMTP_PASSWORD SMTP_FROM

  fail_if_placeholder_env SMTP_HOST "$(read_env_value SMTP_HOST "$ENV_FILE" 2>/dev/null || true)" "smtp.seudominio.com"
  fail_if_placeholder_env SMTP_PASSWORD "$(read_env_value SMTP_PASSWORD "$ENV_FILE" 2>/dev/null || true)" "senha-do-smtp"
  fail_if_placeholder_env PANEL_RECOVERY_EMAIL "$(read_env_value PANEL_RECOVERY_EMAIL "$ENV_FILE" 2>/dev/null || true)" "recuperacao@seudominio.com"

  log "Garantindo dependências"
  ensure_cmd git git >/dev/null 2>&1 || true
  ensure_cmd curl curl >/dev/null 2>&1
  ensure_cmd node nodejs >/dev/null 2>&1
  ensure_cmd npm npm >/dev/null 2>&1
  ensure_pdf_engine

  log "Executando bootstrap base"
  "$BOOTSTRAP_SCRIPT"

  log "Gerando e publicando service"
  prepare_service_file || true
  if [[ -f "$SERVICE_OUTPUT" ]]; then
    if ! publish_service_file; then
      echo "Falha ao publicar/iniciar corretorcenter.service" >&2
      run_privileged systemctl status corretorcenter --no-pager >&2 || true
      run_privileged journalctl -u corretorcenter -n 60 --no-pager >&2 || true
      exit 1
    fi
  else
    warn "Não consegui gerar o service automaticamente. Você pode publicar manualmente via deploy/corretorcenter.service.example"
  fi

  local app_port
  app_port="$(read_env_value APP_PORT "$ENV_FILE" 2>/dev/null || true)"
  app_port="${app_port:-$DEFAULT_APP_PORT}"

  log "Validando aplicação localmente"
  if ! validate_local_health "$app_port"; then
    echo "A aplicação não respondeu em http://127.0.0.1:${app_port}/health" >&2
    run_privileged journalctl -u corretorcenter -n 60 --no-pager >&2 || true
    exit 1
  fi

  cat <<EOF

Assistente concluído.

- App local: http://127.0.0.1:${app_port}
- Health:    http://127.0.0.1:${app_port}/health

Proxy/SSL/subdomínios: configure no Nginx Proxy Manager (fora do instalador).
EOF
}

main "$@"
