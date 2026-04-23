#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
APP_DIR_DEFAULT="$ROOT_DIR"
APP_DIR_FALLBACK="$(dirname "$ROOT_DIR")/corretorcenter"
APP_DIR_ALTCASE="$(dirname "$ROOT_DIR")/CorretorCenter"
SERVICE_NAME="corretorcenter"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
CADDY_FILE="/etc/caddy/Caddyfile"
FORCE=0

if [[ "${1:-}" == "--yes" ]]; then
  FORCE=1
fi

run_privileged() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

log() {
  printf '[reset] %s\n' "$*"
}

warn() {
  printf '[reset][aviso] %s\n' "$*" >&2
}

run_as_postgres() {
  if ! id postgres >/dev/null 2>&1; then
    return 1
  fi
  if [[ "$(id -u)" -eq 0 ]]; then
    su - postgres -c "$*"
  else
    sudo -u postgres bash -lc "$*"
  fi
}

exists_unit() {
  systemctl list-unit-files 2>/dev/null | awk '{print $1}' | grep -qx "$1"
}

package_installed() {
  local pkg="$1"
  if command -v dpkg >/dev/null 2>&1; then
    dpkg -s "$pkg" >/dev/null 2>&1
    return
  fi
  if command -v rpm >/dev/null 2>&1; then
    rpm -q "$pkg" >/dev/null 2>&1
    return
  fi
  return 1
}

remove_package_if_installed() {
  local pkg="$1"
  if ! package_installed "$pkg"; then
    log "Pacote $pkg não encontrado, pulando."
    return 0
  fi
  if command -v apt-get >/dev/null 2>&1; then
    run_privileged apt-get remove -y --purge "$pkg"
  elif command -v dnf >/dev/null 2>&1; then
    run_privileged dnf remove -y "$pkg"
  else
    warn "Gerenciador de pacotes não suportado para remover $pkg."
  fi
}

read_env_value() {
  local key="$1"
  local env_file="$2"
  [[ -f "$env_file" ]] || return 1
  python3 - "$key" "$env_file" <<'PY'
import sys
key, path = sys.argv[1], sys.argv[2]
try:
    with open(path, 'r', encoding='utf-8') as f:
        for line in f:
            if not line.startswith(key + '='):
                continue
            print(line.split('=', 1)[1].rstrip('\n'))
            raise SystemExit(0)
except FileNotFoundError:
    pass
raise SystemExit(1)
PY
}

cleanup_app_dir() {
  local dir="$1"
  [[ -n "$dir" ]] || return 0
  if [[ ! -e "$dir" ]]; then
    log "Pasta $dir não encontrada, pulando."
    return 0
  fi
  if [[ "$PWD" == "$dir" || "$PWD" == "$dir"/* ]]; then
    warn "Você está dentro de $dir. Saia da pasta antes de rodar este reset."
    exit 1
  fi
  log "Removendo pasta $dir"
  run_privileged rm -rf "$dir"
}

cleanup_service() {
  if exists_unit "${SERVICE_NAME}.service"; then
    log "Parando e desabilitando ${SERVICE_NAME}.service"
    run_privileged systemctl stop "${SERVICE_NAME}.service" || true
    run_privileged systemctl disable "${SERVICE_NAME}.service" || true
  else
    log "Serviço ${SERVICE_NAME}.service não encontrado, pulando."
  fi
  if [[ -f "$SERVICE_FILE" ]]; then
    log "Removendo $SERVICE_FILE"
    run_privileged rm -f "$SERVICE_FILE"
    run_privileged systemctl daemon-reload || true
  fi
}

cleanup_caddy() {
  local domains=()
  for env_file in "$APP_DIR_DEFAULT/.env" "$APP_DIR_DEFAULT/.env.example"; do
    [[ -f "$env_file" ]] || continue
    for key in PANEL_DOMAIN FORM_DOMAIN GALLERY_DOMAIN IMAGES_DOMAIN; do
      value="$(read_env_value "$key" "$env_file" 2>/dev/null || true)"
      [[ -n "${value:-}" ]] && domains+=("$value")
    done
  done

  if [[ -f "$CADDY_FILE" ]]; then
    local should_remove=0
    if grep -q 'corretorcenter' "$CADDY_FILE" 2>/dev/null; then
      should_remove=1
    else
      for domain in "${domains[@]}"; do
        if [[ -n "$domain" ]] && grep -q "$domain" "$CADDY_FILE" 2>/dev/null; then
          should_remove=1
          break
        fi
      done
    fi
    if [[ "$should_remove" -eq 1 ]]; then
      log "Removendo configuração do Caddy criada para o CorretorCenter"
      run_privileged rm -f "$CADDY_FILE"
    else
      warn "Caddyfile não parece exclusivo do CorretorCenter. Mantendo arquivo para evitar apagar outro site."
    fi
  else
    log "Caddyfile não encontrado, pulando."
  fi

  if exists_unit 'caddy.service'; then
    log 'Parando caddy'
    run_privileged systemctl stop caddy || true
    run_privileged systemctl disable caddy || true
  fi

  remove_package_if_installed caddy
  if [[ -f /etc/systemd/system/caddy.service ]]; then
    log 'Removendo unit custom do caddy'
    run_privileged rm -f /etc/systemd/system/caddy.service
    run_privileged systemctl daemon-reload || true
  fi
}

cleanup_postgres() {
  local env_file=""
  for candidate in "$APP_DIR_DEFAULT/.env" "$APP_DIR_DEFAULT/.env.example"; do
    [[ -f "$candidate" ]] || continue
    env_file="$candidate"
    break
  done
  local db_name db_user
  db_name="$(read_env_value DB_NAME "$env_file" 2>/dev/null || true)"
  db_user="$(read_env_value DB_USER "$env_file" 2>/dev/null || true)"
  [[ -z "$db_name" ]] && db_name='corretorcenter'
  [[ -z "$db_user" ]] && db_user='corretorcenter'

  if exists_unit 'postgresql.service'; then
    log 'Tentando remover banco e usuário PostgreSQL do CorretorCenter'
    run_privileged systemctl start postgresql || true
    if id postgres >/dev/null 2>&1; then
      run_as_postgres "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='${db_name}'\"" | grep -q 1 && \
        run_as_postgres "psql -d postgres -c 'DROP DATABASE IF EXISTS \"${db_name}\";'" || true
      run_as_postgres "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='${db_user}'\"" | grep -q 1 && \
        run_as_postgres "psql -d postgres -c 'DROP ROLE IF EXISTS \"${db_user}\";'" || true
    fi
    run_privileged systemctl stop postgresql || true
    run_privileged systemctl disable postgresql || true
  else
    log 'Serviço postgresql não encontrado, pulando parada do banco.'
  fi

  remove_package_if_installed postgresql
  remove_package_if_installed postgresql-contrib
  remove_package_if_installed postgresql-client
  remove_package_if_installed postgresql-client-common
  remove_package_if_installed postgresql-server

  for path in /var/lib/postgresql /var/lib/pgsql /etc/postgresql; do
    if [[ -e "$path" ]]; then
      log "Removendo dados/pastas do PostgreSQL em $path"
      run_privileged rm -rf "$path"
    fi
  done
}

cleanup_runtime_packages() {
  remove_package_if_installed wkhtmltopdf
  remove_package_if_installed nodejs
  remove_package_if_installed npm
  if package_installed iptables-persistent; then
    log 'Removendo iptables-persistent'
    if command -v apt-get >/dev/null 2>&1; then
      run_privileged env DEBIAN_FRONTEND=noninteractive apt-get remove -y --purge iptables-persistent
    fi
  else
    log 'iptables-persistent não encontrado, pulando.'
  fi
}

cleanup_listening_ports() {
  local ports=(5180 80 443)
  if command -v ss >/dev/null 2>&1; then
    for port in "${ports[@]}"; do
      local pids
      pids="$(ss -ltnp "sport = :$port" 2>/dev/null | awk 'match($0, /pid=([0-9]+)/, m) { print m[1] }' | sort -u)"
      for pid in $pids; do
        if [[ -n "$pid" ]]; then
          log "Finalizando processo $pid que está usando a porta $port"
          kill "$pid" 2>/dev/null || true
          sleep 1
          kill -9 "$pid" 2>/dev/null || true
        fi
      done
    done
  fi
  if command -v fuser >/dev/null 2>&1; then
    for port in "${ports[@]}"; do
      fuser -k "${port}/tcp" 2>/dev/null || true
    done
  fi
}

cleanup_firewall() {
  if command -v iptables >/dev/null 2>&1; then
    for port in 80 443; do
      while run_privileged iptables -C INPUT -p tcp --dport "$port" -j ACCEPT >/dev/null 2>&1; do
        log "Removendo regra iptables para porta $port"
        run_privileged iptables -D INPUT -p tcp --dport "$port" -j ACCEPT || break
      done
    done
  fi
  if [[ -f /etc/iptables/rules.v4 ]]; then
    log 'Removendo persistência de regras IPv4 em /etc/iptables/rules.v4'
    run_privileged rm -f /etc/iptables/rules.v4
  fi
  if command -v service >/dev/null 2>&1 && [[ -f /etc/sysconfig/iptables ]]; then
    log 'Limpando /etc/sysconfig/iptables'
    run_privileged rm -f /etc/sysconfig/iptables
  fi
}

cleanup_generated_files() {
  for file in \
    "$APP_DIR_DEFAULT/deploy/caddy.generated.conf" \
    "$APP_DIR_DEFAULT/deploy/caddy.multi-domain-setup.generated.conf" \
    "$APP_DIR_DEFAULT/deploy/caddy.multi-domain-ssl.generated.conf" \
    "$APP_DIR_DEFAULT/deploy/caddy.panel-setup.generated.conf" \
    "$APP_DIR_DEFAULT/deploy/corretorcenter.generated.service"; do
    [[ -f "$file" ]] || continue
    log "Removendo artefato $file"
    rm -f "$file"
  done
}

confirm() {
  cat <<MSG
ATENÇÃO: este reset remove a instalação do CorretorCenter, incluindo:
- pasta do projeto
- serviço corretorcenter
- Caddy do projeto
- PostgreSQL, banco e dados
- Node.js, npm e wkhtmltopdf instalados para este fluxo
- regras de firewall 80/443 adicionadas para o deploy

Use apenas em VPS dedicada ao CorretorCenter.
MSG
  if [[ "$FORCE" -eq 1 ]]; then
    return 0
  fi
  echo
  read -r -p "Digite RESETAR para continuar: " answer
  [[ "$answer" == "RESETAR" ]]
}

main() {
  confirm || { warn 'Reset cancelado.'; exit 1; }
  cleanup_service
  cleanup_caddy
  cleanup_postgres
  cleanup_runtime_packages
  cleanup_firewall
  cleanup_listening_ports
  cleanup_generated_files
  cleanup_app_dir "$APP_DIR_DEFAULT"
  [[ "$APP_DIR_FALLBACK" != "$APP_DIR_DEFAULT" ]] && cleanup_app_dir "$APP_DIR_FALLBACK"
  [[ "$APP_DIR_ALTCASE" != "$APP_DIR_DEFAULT" && "$APP_DIR_ALTCASE" != "$APP_DIR_FALLBACK" ]] && cleanup_app_dir "$APP_DIR_ALTCASE"
  log 'Reset concluído.'
}

main "$@"
