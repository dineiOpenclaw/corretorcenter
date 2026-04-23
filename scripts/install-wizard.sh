#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_EXAMPLE="$ROOT_DIR/.env.example"
ENV_FILE="$ROOT_DIR/.env"
BOOTSTRAP_SCRIPT="$ROOT_DIR/scripts/bootstrap.sh"
SERVICE_TEMPLATE="$ROOT_DIR/deploy/corretorcenter.service.example"
SERVICE_OUTPUT="$ROOT_DIR/deploy/corretorcenter.generated.service"
CADDY_OUTPUT="$ROOT_DIR/deploy/caddy.generated.conf"
DEFAULT_APP_PORT="5180"

log() {
  printf '\n[%s] %s\n' "wizard" "$1"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "Comando obrigatório não encontrado: $1" >&2; exit 1; }
}

check_cmd() {
  local cmd="$1"
  if command -v "$cmd" >/dev/null 2>&1; then
    echo "OK"
  else
    echo "FALTANDO"
  fi
}

check_caddy_mode() {
  if command -v caddy >/dev/null 2>&1; then
    echo "caddy"
  else
    echo "indisponivel"
  fi
}

check_pdf_engine() {
  if command -v wkhtmltopdf >/dev/null 2>&1; then
    echo "OK"
  else
    echo "FALTANDO"
  fi
}

get_os_id() {
  if [[ -f /etc/os-release ]]; then
    . /etc/os-release
    echo "${ID:-unknown}"
  else
    echo "unknown"
  fi
}

get_os_like() {
  if [[ -f /etc/os-release ]]; then
    . /etc/os-release
    echo "${ID_LIKE:-}"
  else
    echo ""
  fi
}

is_supported_linux() {
  local os_id os_like
  os_id="$(get_os_id)"
  os_like="$(get_os_like)"
  [[ "$os_id" == "ubuntu" || "$os_id" == "debian" || "$os_id" == "oraclelinux" || "$os_like" == *debian* || "$os_like" == *rhel* || "$os_like" == *fedora* ]]
}

is_oracle_linux() {
  [[ "$(get_os_id)" == "oraclelinux" || "$(get_os_id)" == "ol" ]]
}

package_manager_hint() {
  if is_oracle_linux; then
    echo "dnf"
  else
    echo "apt"
  fi
}

install_packages() {
  local packages=("$@")
  echo
  echo "Pacotes sugeridos para instalação: ${packages[*]}"
  read -r -p "Deseja tentar instalar automaticamente agora? [s/N]: " answer
  answer="${answer,,}"
  if [[ "$answer" != "s" && "$answer" != "sim" ]]; then
    echo "Instalação automática cancelada."
    return 1
  fi
  if ! command -v sudo >/dev/null 2>&1 && [[ "$(id -u)" -ne 0 ]]; then
    echo "sudo não encontrado. Instale manualmente ou rode como root."
    return 1
  fi
  if is_oracle_linux; then
    run_privileged dnf install -y "${packages[@]}"
  else
    run_privileged apt-get update
    run_privileged apt-get install -y "${packages[@]}"
  fi
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

ensure_pdf_engine() {
  if [[ "$(check_pdf_engine)" == "OK" ]]; then
    return 0
  fi
  echo
  echo "Motor de PDF wkhtmltopdf não encontrado."
  read -r -p "Deseja tentar instalar automaticamente agora? [s/N]: " answer
  answer="${answer,,}"
  if [[ "$answer" != "s" && "$answer" != "sim" ]]; then
    echo "Instalação automática do wkhtmltopdf cancelada."
    return 1
  fi
  if is_oracle_linux; then
    run_privileged dnf install -y wkhtmltopdf
  else
    run_privileged apt-get update
    run_privileged apt-get install -y wkhtmltopdf
  fi
}

postgres_access_ok() {
  run_as_postgres psql -tAc 'SELECT 1' >/dev/null 2>&1
}

postgres_packages() {
  if is_oracle_linux; then
    echo "postgresql postgresql-server"
  else
    echo "postgresql postgresql-contrib postgresql-client"
  fi
}

postgres_service_exists() {
  systemctl list-unit-files 2>/dev/null | grep -q '^postgresql\.service'
}

ensure_postgres() {
  local packages=()
  read -r -a packages <<<"$(postgres_packages)"

  if ! command -v sudo >/dev/null 2>&1 && [[ "$(id -u)" -ne 0 ]]; then
    echo "sudo não encontrado. Instale o PostgreSQL manualmente ou rode como root."
    return 1
  fi

  if command -v psql >/dev/null 2>&1 && postgres_service_exists; then
    if systemctl is-active --quiet postgresql; then
      postgres_access_ok && return 0
    fi
    echo
    echo "PostgreSQL encontrado, mas o serviço está parado. Tentando iniciar..."
    run_privileged systemctl enable --now postgresql
    postgres_access_ok && return 0
  fi

  echo
  echo "PostgreSQL não encontrado por completo. O assistente precisa do servidor e do cliente locais antes da migration base."
  install_packages "${packages[@]}" || return 1

  if is_oracle_linux && command -v postgresql-setup >/dev/null 2>&1; then
    if [[ ! -f /var/lib/pgsql/data/PG_VERSION ]]; then
      run_privileged postgresql-setup --initdb
    fi
  fi

  run_privileged systemctl enable --now postgresql
  postgres_access_ok
}

install_caddy_binary() {
  local arch
  case "$(uname -m)" in
    x86_64) arch="amd64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) echo "Arquitetura $(uname -m) ainda não suportada para instalação automática do Caddy."; return 1 ;;
  esac
  local version url
  version="$(curl -fsSL https://api.github.com/repos/caddyserver/caddy/releases/latest | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)"
  if [[ -z "$version" ]]; then
    echo "Não foi possível descobrir a versão mais recente do Caddy."
    return 1
  fi
  url="https://github.com/caddyserver/caddy/releases/download/${version}/caddy_${version#v}_linux_${arch}.tar.gz"
  local tmpdir
  tmpdir="$(mktemp -d)"
  curl -fsSL "$url" -o "$tmpdir/caddy.tgz" || return 1
  tar -xzf "$tmpdir/caddy.tgz" -C "$tmpdir" || return 1
  run_privileged install -m 755 "$tmpdir/caddy" /usr/local/bin/caddy || return 1
  if [[ ! -f /etc/systemd/system/caddy.service ]]; then
    run_privileged tee /etc/systemd/system/caddy.service >/dev/null <<'EOS'
[Unit]
Description=Caddy web server
After=network.target

[Service]
ExecStart=/usr/local/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile
Restart=on-failure
User=root
Group=root
Environment=HOME=/var/lib/caddy
Environment=XDG_CONFIG_HOME=/var/lib/caddy/.config
Environment=XDG_DATA_HOME=/var/lib/caddy/.local/share
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOS
    run_privileged mkdir -p /etc/caddy /var/lib/caddy/.config /var/lib/caddy/.local/share/caddy
    run_privileged chown -R root:root /var/lib/caddy
  fi
  run_privileged systemctl daemon-reload
  run_privileged systemctl enable --now caddy
}

ensure_caddy() {
  if command -v caddy >/dev/null 2>&1; then
    return 0
  fi
  echo "Caddy não encontrado. Tentando instalar automaticamente..."
  if is_oracle_linux; then
    if run_privileged dnf install -y caddy; then
      return 0
    fi
    echo "Pacote caddy não disponível no repositório padrão. Instalando binário oficial..."
    install_caddy_binary
    return $?
  fi
  if run_privileged apt-get update && run_privileged apt-get install -y caddy; then
    return 0
  fi
  echo "Pacote caddy não disponível no apt atual. Instalando binário oficial..."
  install_caddy_binary
}

port_in_use() {
  local port="$1"
  ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "(^|:)$port$"
}

validate_runtime_ports() {
  local failed=0
  if port_in_use "$DEFAULT_APP_PORT"; then
    echo "A porta ${DEFAULT_APP_PORT} já está em uso nesta VPS. Ajuste APP_PORT antes de continuar." >&2
    failed=1
  fi
  return $failed
}

warn_caddy_ports() {
  local warned=0
  if port_in_use 80; then
    echo "Aviso: a porta 80 já está em uso. A publicação do Caddy/HTTP pode falhar." >&2
    warned=1
  fi
  if port_in_use 443; then
    echo "Aviso: a porta 443 já está em uso. A publicação do Caddy/HTTPS pode falhar." >&2
    warned=1
  fi
  return $warned
}

validate_local_app() {
  local app_port="${APP_PORT:-$DEFAULT_APP_PORT}"
  local log_file="$ROOT_DIR/.install-app-check.log"
  local app_pid=""

  if port_in_use "$app_port"; then
    echo "Validação local pulada: a porta ${app_port} já está em uso." >&2
    return 1
  fi

  echo "Iniciando aplicação localmente para validação final..."
  node "$ROOT_DIR/app/server.js" >"$log_file" 2>&1 &
  app_pid=$!

  cleanup_app_check() {
    if [[ -n "$app_pid" ]] && kill -0 "$app_pid" 2>/dev/null; then
      kill "$app_pid" 2>/dev/null || true
      wait "$app_pid" 2>/dev/null || true
    fi
  }
  trap cleanup_app_check RETURN

  local attempt=0
  while (( attempt < 15 )); do
    if curl -fsS "http://127.0.0.1:${app_port}/health" >/dev/null 2>&1; then
      echo "Validação local concluída com sucesso em http://127.0.0.1:${app_port}/health"
      trap - RETURN
      cleanup_app_check
      return 0
    fi
    sleep 1
    attempt=$((attempt + 1))
  done

  echo "Falha ao validar a aplicação localmente. Últimas linhas do log:" >&2
  tail -n 40 "$log_file" >&2 || true
  trap - RETURN
  cleanup_app_check
  return 1
}

prepare_caddy_config() {
  local panel_domain="$1"
  local form_domain="$2"
  local gallery_domain="$3"
  local images_domain="$4"
  local files_domain="$5"
  local api_domain="$6"
  local app_port="$7"
  cat > "$CADDY_OUTPUT" <<EOC
${panel_domain} {
  reverse_proxy 127.0.0.1:${app_port}
}

${form_domain} {
  reverse_proxy 127.0.0.1:${app_port}
}

${gallery_domain} {
  reverse_proxy 127.0.0.1:${app_port}
}

${images_domain} {
  reverse_proxy 127.0.0.1:${app_port}
}

${files_domain} {
  reverse_proxy 127.0.0.1:${app_port}
}

${api_domain} {
  reverse_proxy 127.0.0.1:${app_port}
}
EOC
  echo "Config Caddy gerada em: $CADDY_OUTPUT"
}

prepare_service_file() {
  if [[ ! -f "$SERVICE_TEMPLATE" ]]; then
    echo "Template de service não encontrado: $SERVICE_TEMPLATE"
    return 1
  fi
  sed \
    -e "s|/opt/corretorcenter|$ROOT_DIR|g" \
    -e "s|User=www-data|User=${SUDO_USER:-$USER}|g" \
    -e "s|Group=www-data|Group=$(id -gn)|g" \
    "$SERVICE_TEMPLATE" > "$SERVICE_OUTPUT"
  echo
  echo "Service systemd gerado em: $SERVICE_OUTPUT"
}

publish_service_file() {
  local target="/etc/systemd/system/corretorcenter.service"
  if ! command -v sudo >/dev/null 2>&1 && [[ "$(id -u)" -ne 0 ]]; then
    echo "sudo não encontrado. Publicação automática do service indisponível."
    return 1
  fi
  run_privileged cp "$SERVICE_OUTPUT" "$target"
  run_privileged systemctl daemon-reload
  run_privileged systemctl enable --now corretorcenter
  if ! run_privileged systemctl is-active --quiet corretorcenter; then
    echo "O service corretorcenter não permaneceu ativo após a publicação." >&2
    run_privileged systemctl status corretorcenter --no-pager >&2 || true
    return 1
  fi
  echo "Service systemd publicado e iniciado com sucesso."
}

validate_domain() {
  [[ "$1" =~ ^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]]
}

validate_email() {
  [[ "$1" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]
}

get_public_ip() {
  curl -4 -fsS ifconfig.me 2>/dev/null || curl -4 -fsS https://ifconfig.me 2>/dev/null
}

domain_points_to_current_vps() {
  local domain="$1"
  local public_ip="$2"
  getent ahostsv4 "$domain" 2>/dev/null | awk '{print $1}' | sort -u | grep -Fxq "$public_ip"
}

publish_caddy_file() {
  local target="/etc/caddy/Caddyfile"
  run_privileged mkdir -p /etc/caddy
  run_privileged cp "$CADDY_OUTPUT" "$target"
  run_privileged caddy validate --config "$target"
  run_privileged systemctl enable --now caddy
  run_privileged systemctl reload caddy
}

test_url_with_retries() {
  local url="$1"
  local attempts="${2:-20}"
  local sleep_seconds="${3:-3}"
  local i=0
  while (( i < attempts )); do
    if curl -k -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$sleep_seconds"
    i=$((i + 1))
  done
  return 1
}

host_firewall_blocks_web_ports() {
  if command -v iptables >/dev/null 2>&1; then
    local rules
    rules="$(run_privileged iptables -S INPUT 2>/dev/null || true)"
    if grep -q -- '-A INPUT -j REJECT' <<<"$rules" || grep -q -- '-A INPUT -j DROP' <<<"$rules"; then
      if ! grep -q -- '--dport 80 -j ACCEPT' <<<"$rules" || ! grep -q -- '--dport 443 -j ACCEPT' <<<"$rules"; then
        return 0
      fi
    fi
  fi
  return 1
}

ensure_iptables_persistence() {
  if is_oracle_linux; then
    if command -v service >/dev/null 2>&1; then
      run_privileged service iptables save || return 1
      return 0
    fi
    return 1
  fi

  if command -v apt-get >/dev/null 2>&1; then
    run_privileged env DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent >/dev/null || true
    run_privileged mkdir -p /etc/iptables
    run_privileged sh -c 'iptables-save > /etc/iptables/rules.v4'
    return 0
  fi

  return 1
}

open_web_ports_in_firewall() {
  if ! command -v iptables >/dev/null 2>&1; then
    echo "iptables não encontrado. Não foi possível liberar 80/443 automaticamente." >&2
    return 1
  fi

  run_privileged iptables -C INPUT -p tcp --dport 80 -j ACCEPT 2>/dev/null || run_privileged iptables -I INPUT 1 -p tcp --dport 80 -j ACCEPT
  run_privileged iptables -C INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null || run_privileged iptables -I INPUT 1 -p tcp --dport 443 -j ACCEPT
  ensure_iptables_persistence || {
    echo "As portas 80/443 foram liberadas no iptables atual, mas não consegui persistir automaticamente após reboot." >&2
    return 1
  }
  echo "Portas 80 e 443 liberadas no firewall e persistidas para reinício."
}

handle_blocked_web_ports() {
  local panel_domain="$1"
  local public_ip="$2"
  echo "HTTPS externo falhou porque esta VPS está bloqueando as portas 80/443 no firewall local." >&2
  echo "IP público: ${public_ip}" >&2
  echo "Domínio validado: ${panel_domain}" >&2
  run_privileged iptables -S INPUT >&2 || true
  read -r -p "Deseja liberar automaticamente as portas 80 e 443 no firewall desta VPS e persistir após reinício? [s/N]: " FIREWALL_ANSWER
  FIREWALL_ANSWER="${FIREWALL_ANSWER,,}"
  if [[ "$FIREWALL_ANSWER" == "s" || "$FIREWALL_ANSWER" == "sim" ]]; then
    open_web_ports_in_firewall || return 1
    run_privileged systemctl reload caddy || true
    echo "Aguardando nova tentativa de emissão/validação HTTPS após liberar o firewall..."
    return 0
  fi
  echo "Instalação encerrada: sem liberar 80/443 o subdomínio final não ficará acessível externamente." >&2
  return 1
}

explain_external_https_failure() {
  local panel_domain="$1"
  local public_ip="$2"
  if host_firewall_blocks_web_ports; then
    handle_blocked_web_ports "$panel_domain" "$public_ip" || return 1
    return 0
  fi
  echo "O subdomínio final ainda não respondeu em https://${panel_domain}/health após publicar o Caddy." >&2
  echo "Verifique portas públicas 80/443, firewall do provedor e emissão do certificado." >&2
  run_privileged journalctl -u caddy -n 40 --no-pager >&2 || true
  return 1
}

set_env_value() {
  local key="$1"
  local value="$2"
  local tmp
  tmp="$(mktemp)"
  ENV_FILE="$ENV_FILE" KEY="$key" VALUE="$value" TMP_FILE="$tmp" python3 - <<'PY'
from pathlib import Path
import os

env_file = Path(os.environ['ENV_FILE'])
key = os.environ['KEY']
value = os.environ['VALUE']
tmp_file = Path(os.environ['TMP_FILE'])
lines = env_file.read_text().splitlines() if env_file.exists() else []
out = []
found = False
for line in lines:
    if line.startswith(f"{key}="):
        out.append(f"{key}={value}")
        found = True
    else:
        out.append(line)
if not found:
    out.append(f"{key}={value}")
tmp_file.write_text("\n".join(out) + "\n")
PY
  mv "$tmp" "$ENV_FILE"
}

backup_existing_env() {
  if [[ -f "$ENV_FILE" ]]; then
    local backup="$ROOT_DIR/.env.backup.$(date +%Y%m%d-%H%M%S)"
    cp "$ENV_FILE" "$backup"
    log ".env existente salvo em $backup e recriado do zero para evitar sujeira de tentativas anteriores"
  fi
  cp "$ENV_EXAMPLE" "$ENV_FILE"
}

prompt_panel_password() {
  while true; do
    read -r -p "Senha inicial do painel [visível, enter para usar padrão]: " PANEL_ADMIN_PASSWORD_INPUT
    PANEL_ADMIN_PASSWORD_INPUT="${PANEL_ADMIN_PASSWORD_INPUT:-${PANEL_ADMIN_PASSWORD:-$DEFAULT_PANEL_ADMIN_PASSWORD}}"
    read -r -p "Confirme a senha inicial do painel [visível]: " PANEL_ADMIN_PASSWORD_CONFIRM
    PANEL_ADMIN_PASSWORD_CONFIRM="${PANEL_ADMIN_PASSWORD_CONFIRM:-${PANEL_ADMIN_PASSWORD:-$DEFAULT_PANEL_ADMIN_PASSWORD}}"
    if [[ "$PANEL_ADMIN_PASSWORD_INPUT" == "$PANEL_ADMIN_PASSWORD_CONFIRM" ]]; then
      printf '%s' "$PANEL_ADMIN_PASSWORD_INPUT"
      return 0
    fi
    echo "As senhas não conferem. Tente novamente."
  done
}

require_cmd bash
require_cmd python3
require_cmd ss

CADDY_MODE="indisponivel"

log "Assistente inicial de instalação do CorretorCenter"

OS_ID="$(get_os_id)"
OS_LIKE="$(get_os_like)"
SUPPORTED_OS="nao"
if is_supported_linux; then SUPPORTED_OS="sim"; fi

NODE_STATUS="$(check_cmd node)"
NPM_STATUS="$(check_cmd npm)"
PSQL_STATUS="$(check_cmd psql)"
PDF_BROWSER_STATUS="$(check_pdf_engine)"
POSTGRES_SERVICE_STATUS="NAO_VERIFICADO"
if command -v systemctl >/dev/null 2>&1 && postgres_service_exists; then
  if systemctl is-active --quiet postgresql; then
    POSTGRES_SERVICE_STATUS="ATIVO"
  else
    POSTGRES_SERVICE_STATUS="PARADO"
  fi
elif command -v systemctl >/dev/null 2>&1; then
  POSTGRES_SERVICE_STATUS="FALTANDO"
fi
SYSTEMCTL_STATUS="$(check_cmd systemctl)"
CADDY_MODE="$(check_caddy_mode)"

cat <<EOV

Verificação inicial do ambiente:
- sistema: ${OS_ID}${OS_LIKE:+ (like: $OS_LIKE)}
- homologado para instalação assistida: $SUPPORTED_OS
- node: $NODE_STATUS
- npm: $NPM_STATUS
- psql: $PSQL_STATUS
- motor de PDF (wkhtmltopdf): $PDF_BROWSER_STATUS
- postgresql.service: $POSTGRES_SERVICE_STATUS
- systemctl: $SYSTEMCTL_STATUS
- https/caddy: $CADDY_MODE
EOV

validate_runtime_ports || exit 1

MISSING_REQUIRED=()
[[ "$NODE_STATUS" == "FALTANDO" ]] && MISSING_REQUIRED+=(nodejs npm)
[[ "$NPM_STATUS" == "FALTANDO" && "$NODE_STATUS" != "FALTANDO" ]] && MISSING_REQUIRED+=(npm)

if ((${#MISSING_REQUIRED[@]} > 0)); then
  echo
  echo "Dependências obrigatórias faltando: ${MISSING_REQUIRED[*]}"
  if is_supported_linux; then
    install_packages "${MISSING_REQUIRED[@]}" || {
      echo "Não foi possível concluir a instalação automática das dependências obrigatórias."
      exit 1
    }
    NODE_STATUS="$(check_cmd node)"
    NPM_STATUS="$(check_cmd npm)"
    PSQL_STATUS="$(check_cmd psql)"
    PDF_BROWSER_STATUS="$(check_pdf_engine)"
  else
    echo "Instalação automática ainda não foi adaptada para este sistema."
    echo "Instale manualmente as dependências com $(package_manager_hint) e execute novamente."
    exit 1
  fi
fi

if [[ "$PDF_BROWSER_STATUS" == "FALTANDO" ]]; then
  if is_supported_linux; then
    ensure_pdf_engine || {
      echo "Não foi possível garantir a instalação do motor de PDF."
      exit 1
    }
    PDF_BROWSER_STATUS="$(check_pdf_engine)"
  else
    echo "Instalação automática do motor de PDF ainda não foi adaptada para este sistema."
    exit 1
  fi
fi

if [[ "$SYSTEMCTL_STATUS" == "OK" ]]; then
  if is_supported_linux; then
    ensure_postgres || {
      echo "Não foi possível garantir a instalação e ativação do PostgreSQL."
      exit 1
    }
    PSQL_STATUS="$(check_cmd psql)"
    if postgres_service_exists && systemctl is-active --quiet postgresql; then
      POSTGRES_SERVICE_STATUS="ATIVO"
    elif postgres_service_exists; then
      POSTGRES_SERVICE_STATUS="PARADO"
    else
      POSTGRES_SERVICE_STATUS="FALTANDO"
    fi
  else
    echo "Instalação automática do PostgreSQL ainda não foi adaptada para este sistema."
    echo "Instale manualmente o servidor e o cliente PostgreSQL e execute novamente."
    exit 1
  fi
fi

backup_existing_env

while true; do
  read -r -p "Informe o subdomínio principal do painel (ex.: painel.seudominio.com): " PANEL_DOMAIN
  PANEL_DOMAIN="${PANEL_DOMAIN,,}"
  if validate_domain "$PANEL_DOMAIN"; then
    break
  fi
  echo "Subdomínio inválido. Use algo como painel.seudominio.com"
done

while true; do
  read -r -p "Informe um e-mail válido para o setup inicial: " SETUP_EMAIL
  SETUP_EMAIL="${SETUP_EMAIL,,}"
  if validate_email "$SETUP_EMAIL"; then
    break
  fi
  echo "E-mail inválido. Tente novamente."
done

DEFAULT_FORM_DOMAIN="form1.${PANEL_DOMAIN#*.}"
DEFAULT_GALLERY_DOMAIN="galeria1.${PANEL_DOMAIN#*.}"
DEFAULT_IMAGES_DOMAIN="imagens1.${PANEL_DOMAIN#*.}"
DEFAULT_APP_NAME="Minha Imobiliária"
DEFAULT_PANEL_TITLE="Painel Imobiliário"
DEFAULT_PANEL_ADMIN_USER="clebercorretor"
DEFAULT_PANEL_ADMIN_PASSWORD="clebercorretor"

set_env_value PANEL_DOMAIN "$PANEL_DOMAIN"
set_env_value FORM_DOMAIN "$DEFAULT_FORM_DOMAIN"
set_env_value GALLERY_DOMAIN "$DEFAULT_GALLERY_DOMAIN"
set_env_value IMAGES_DOMAIN "$DEFAULT_IMAGES_DOMAIN"
set_env_value SETUP_CONTACT_EMAIL "$SETUP_EMAIL"
set_env_value APP_NAME "${APP_NAME:-$DEFAULT_APP_NAME}"
set_env_value PANEL_TITLE "${PANEL_TITLE:-$DEFAULT_PANEL_TITLE}"
APP_PORT_VALUE="${APP_PORT:-$DEFAULT_APP_PORT}"
set_env_value APP_PORT "$APP_PORT_VALUE"

read -r -p "Usuário inicial do painel [${PANEL_ADMIN_USER:-$DEFAULT_PANEL_ADMIN_USER}]: " PANEL_ADMIN_USER_INPUT
PANEL_ADMIN_USER_INPUT="${PANEL_ADMIN_USER_INPUT:-${PANEL_ADMIN_USER:-$DEFAULT_PANEL_ADMIN_USER}}"
PANEL_ADMIN_PASSWORD_INPUT="$(prompt_panel_password)"
set_env_value PANEL_ADMIN_USER "$PANEL_ADMIN_USER_INPUT"
set_env_value PANEL_ADMIN_PASSWORD "$PANEL_ADMIN_PASSWORD_INPUT"

log "Executando bootstrap base"
"$BOOTSTRAP_SCRIPT"

validate_local_app || exit 1

prepare_service_file || true
if [[ -f "$SERVICE_OUTPUT" ]]; then
  publish_service_file || exit 1
fi

warn_caddy_ports || true
if [[ "$CADDY_MODE" == "indisponivel" ]]; then
  if is_supported_linux; then
    ensure_caddy || {
      echo "Não foi possível instalar o Caddy automaticamente."
      exit 1
    }
    CADDY_MODE="$(check_caddy_mode)"
  fi
fi
prepare_caddy_config "$PANEL_DOMAIN" "$DEFAULT_FORM_DOMAIN" "$DEFAULT_GALLERY_DOMAIN" "$DEFAULT_IMAGES_DOMAIN" "$DEFAULT_APP_PORT" || true
if [[ -f "$CADDY_OUTPUT" ]]; then
  echo "Config Caddy pronta em: $CADDY_OUTPUT"
  publish_caddy_file || exit 1
fi

PUBLIC_IP="$(get_public_ip || true)"
if [[ -z "$PUBLIC_IP" ]]; then
  echo "Não foi possível descobrir o IP público da VPS para validar o domínio final." >&2
  exit 1
fi

if ! domain_points_to_current_vps "$PANEL_DOMAIN" "$PUBLIC_IP"; then
  echo "O domínio $PANEL_DOMAIN não aponta para este IP público ($PUBLIC_IP). Ajuste o DNS antes de concluir a instalação." >&2
  exit 1
fi

if ! test_url_with_retries "http://127.0.0.1:${APP_PORT_VALUE}/health" 10 2; then
  echo "A aplicação não respondeu localmente após a publicação do service." >&2
  exit 1
fi

if ! test_url_with_retries "https://${PANEL_DOMAIN}/health" 20 3; then
  explain_external_https_failure "$PANEL_DOMAIN" "$PUBLIC_IP" || exit 1
  if ! test_url_with_retries "https://${PANEL_DOMAIN}/health" 60 3; then
    echo "O subdomínio final ainda não respondeu em https://${PANEL_DOMAIN}/health mesmo após ajustar o firewall local e aguardar nova emissão do certificado." >&2
    run_privileged journalctl -u caddy -n 60 --no-pager >&2 || true
    exit 1
  fi
fi

cat <<EOS

Status da infraestrutura após bootstrap:
- node: $(check_cmd node)
- npm: $(check_cmd npm)
- psql: $(check_cmd psql)
- systemctl: $(check_cmd systemctl)
- https/caddy: $(check_caddy_mode)

Assistente concluído.

Resumo final:
- Painel publicado em: https://$PANEL_DOMAIN
- Formulário sugerido: https://$DEFAULT_FORM_DOMAIN
- Galeria sugerida: https://$DEFAULT_GALLERY_DOMAIN
- Imagens sugerido: https://$DEFAULT_IMAGES_DOMAIN
- E-mail do setup: $SETUP_EMAIL
- Login inicial do painel: ${PANEL_ADMIN_USER_INPUT} / ${PANEL_ADMIN_PASSWORD_INPUT}
- IP público validado: $PUBLIC_IP

O painel está acessível no subdomínio informado.

Próximos ajustes no navegador:
1. Abrir o painel web de configuração em /painel/configuracoes
2. Finalizar logo, cores, textos, credenciais e demais domínios no navegador
3. Depois avançar para os ajustes finais de publicação por subdomínio
EOS
