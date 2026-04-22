#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_EXAMPLE="$ROOT_DIR/.env.example"
ENV_FILE="$ROOT_DIR/.env"
BOOTSTRAP_SCRIPT="$ROOT_DIR/scripts/bootstrap.sh"
SERVICE_TEMPLATE="$ROOT_DIR/deploy/corretorcenter.service.example"
SERVICE_OUTPUT="$ROOT_DIR/deploy/corretorcenter.generated.service"
CADDY_OUTPUT="$ROOT_DIR/deploy/caddy.generated.conf"

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
  if ! command -v sudo >/dev/null 2>&1; then
    echo "sudo não encontrado. Instale manualmente ou rode como root."
    return 1
  fi
  if is_oracle_linux; then
    sudo dnf install -y "${packages[@]}"
  else
    sudo apt-get update
    sudo apt-get install -y "${packages[@]}"
  fi
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

  if ! command -v sudo >/dev/null 2>&1; then
    echo "sudo não encontrado. Instale o PostgreSQL manualmente ou rode como root."
    return 1
  fi

  if command -v psql >/dev/null 2>&1 && postgres_service_exists; then
    if systemctl is-active --quiet postgresql; then
      return 0
    fi
    echo
    echo "PostgreSQL encontrado, mas o serviço está parado. Tentando iniciar..."
    sudo systemctl enable --now postgresql
    return $?
  fi

  echo
  echo "PostgreSQL não encontrado por completo. O assistente precisa do servidor e do cliente locais antes da migration base."
  install_packages "${packages[@]}" || return 1

  if is_oracle_linux && command -v postgresql-setup >/dev/null 2>&1; then
    if [[ ! -f /var/lib/pgsql/data/PG_VERSION ]]; then
      sudo postgresql-setup --initdb
    fi
  fi

  sudo systemctl enable --now postgresql
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
  sudo install -m 755 "$tmpdir/caddy" /usr/local/bin/caddy || return 1
  if [[ ! -f /etc/systemd/system/caddy.service ]]; then
    sudo tee /etc/systemd/system/caddy.service >/dev/null <<'EOF'
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
EOF
    sudo mkdir -p /etc/caddy /var/lib/caddy/.config /var/lib/caddy/.local/share/caddy
    sudo chown -R root:root /var/lib/caddy
  fi
  sudo systemctl daemon-reload
  sudo systemctl enable --now caddy
}

ensure_caddy() {
  if command -v caddy >/dev/null 2>&1; then
    return 0
  fi
  echo "Caddy não encontrado. Tentando instalar automaticamente..."
  if is_oracle_linux; then
    if sudo dnf install -y caddy; then
      return 0
    fi
    echo "Pacote caddy não disponível no repositório padrão. Instalando binário oficial..."
    install_caddy_binary
    return $?
  fi
  sudo apt-get update && sudo apt-get install -y caddy
}

prepare_caddy_config() {
  local panel_domain="$1"
  local form_domain="$2"
  local gallery_domain="$3"
  local images_domain="$4"
  local files_domain="$5"
  local api_domain="$6"
  cat > "$CADDY_OUTPUT" <<EOF
${panel_domain} {
  reverse_proxy 127.0.0.1:5180
}

${form_domain} {
  reverse_proxy 127.0.0.1:5180
}

${gallery_domain} {
  reverse_proxy 127.0.0.1:5180
}

${images_domain} {
  reverse_proxy 127.0.0.1:5180
}

${files_domain} {
  reverse_proxy 127.0.0.1:5180
}

${api_domain} {
  reverse_proxy 127.0.0.1:5180
}
EOF
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
  if ! command -v sudo >/dev/null 2>&1; then
    echo "sudo não encontrado. Publicação automática do service indisponível."
    return 1
  fi
  read -r -p "Deseja publicar automaticamente o service systemd? [s/N]: " answer
  answer="${answer,,}"
  if [[ "$answer" != "s" && "$answer" != "sim" ]]; then
    echo "Publicação automática do service cancelada."
    return 1
  fi
  sudo cp "$SERVICE_OUTPUT" "$target"
  sudo systemctl daemon-reload
  sudo systemctl enable --now corretorcenter
  echo "Service systemd publicado e iniciado com sucesso."
}

validate_domain() {
  [[ "$1" =~ ^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]]
}

validate_email() {
  [[ "$1" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]
}

set_env_value() {
  local key="$1"
  local value="$2"
  local escaped
  if [[ "$value" =~ [[:space:]] ]]; then
    escaped=$(printf '%s' "$value" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')
  else
    escaped="$value"
  fi
  if grep -qE "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${escaped}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$escaped" >> "$ENV_FILE"
  fi
}

require_cmd bash
require_cmd python3

CADDY_MODE="indisponivel"

log "Assistente inicial de instalação do CorretorCenter"

OS_ID="$(get_os_id)"
OS_LIKE="$(get_os_like)"
SUPPORTED_OS="nao"
if is_supported_linux; then SUPPORTED_OS="sim"; fi

NODE_STATUS="$(check_cmd node)"
NPM_STATUS="$(check_cmd npm)"
PSQL_STATUS="$(check_cmd psql)"
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

cat <<EOF

Verificação inicial do ambiente:
- sistema: ${OS_ID}${OS_LIKE:+ (like: $OS_LIKE)}
- homologado para instalação assistida: $SUPPORTED_OS
- node: $NODE_STATUS
- npm: $NPM_STATUS
- psql: $PSQL_STATUS
- postgresql.service: $POSTGRES_SERVICE_STATUS
- systemctl: $SYSTEMCTL_STATUS
- https/caddy: $CADDY_MODE
EOF

MISSING_REQUIRED=()
[[ "$NODE_STATUS" == "FALTANDO" ]] && MISSING_REQUIRED+=(nodejs npm)
[[ "$NPM_STATUS" == "FALTANDO" && "$NODE_STATUS" != "FALTANDO" ]] && MISSING_REQUIRED+=(npm)
MISSING_OPTIONAL=()
[[ "$CADDY_MODE" == "indisponivel" ]] && MISSING_OPTIONAL+=(caddy)

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
  else
    echo "Instalação automática ainda não foi adaptada para este sistema."
    echo "Instale manualmente as dependências com $(package_manager_hint) e execute novamente."
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

if [[ "$CADDY_MODE" == "indisponivel" ]]; then
  echo
  if is_supported_linux; then
    ensure_caddy || {
      echo "Não foi possível instalar o Caddy automaticamente."
      exit 1
    }
    CADDY_MODE="$(check_caddy_mode)"
  fi
fi

if [[ ! -f "$ENV_FILE" ]]; then
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  log ".env criado a partir do .env.example"
fi

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
DEFAULT_FILES_DOMAIN="files1.${PANEL_DOMAIN#*.}"
DEFAULT_API_DOMAIN="api1.${PANEL_DOMAIN#*.}"
DEFAULT_APP_NAME="Minha Imobiliária"
DEFAULT_PANEL_TITLE="Painel Imobiliário"
DEFAULT_PANEL_ADMIN_USER="clebercorretor"
DEFAULT_PANEL_ADMIN_PASSWORD="clebercorretor"

set_env_value PANEL_DOMAIN "$PANEL_DOMAIN"
set_env_value FORM_DOMAIN "$DEFAULT_FORM_DOMAIN"
set_env_value GALLERY_DOMAIN "$DEFAULT_GALLERY_DOMAIN"
set_env_value IMAGES_DOMAIN "$DEFAULT_IMAGES_DOMAIN"
set_env_value FILES_DOMAIN "$DEFAULT_FILES_DOMAIN"
set_env_value API_DOMAIN "$DEFAULT_API_DOMAIN"
set_env_value SETUP_CONTACT_EMAIL "$SETUP_EMAIL"
set_env_value APP_NAME "${APP_NAME:-$DEFAULT_APP_NAME}"
set_env_value PANEL_TITLE "${PANEL_TITLE:-$DEFAULT_PANEL_TITLE}"

read -r -p "Usuário inicial do painel [${PANEL_ADMIN_USER:-$DEFAULT_PANEL_ADMIN_USER}]: " PANEL_ADMIN_USER_INPUT
PANEL_ADMIN_USER_INPUT="${PANEL_ADMIN_USER_INPUT:-${PANEL_ADMIN_USER:-$DEFAULT_PANEL_ADMIN_USER}}"
read -r -s -p "Senha inicial do painel [oculta, enter para usar padrão]: " PANEL_ADMIN_PASSWORD_INPUT
printf '\n'
PANEL_ADMIN_PASSWORD_INPUT="${PANEL_ADMIN_PASSWORD_INPUT:-${PANEL_ADMIN_PASSWORD:-$DEFAULT_PANEL_ADMIN_PASSWORD}}"
set_env_value PANEL_ADMIN_USER "$PANEL_ADMIN_USER_INPUT"
set_env_value PANEL_ADMIN_PASSWORD "$PANEL_ADMIN_PASSWORD_INPUT"

log "Executando bootstrap base"
"$BOOTSTRAP_SCRIPT"

prepare_service_file || true
if [[ -f "$SERVICE_OUTPUT" ]]; then
  publish_service_file || true
fi

prepare_caddy_config "$PANEL_DOMAIN" "$DEFAULT_FORM_DOMAIN" "$DEFAULT_GALLERY_DOMAIN" "$DEFAULT_IMAGES_DOMAIN" "$DEFAULT_FILES_DOMAIN" "$DEFAULT_API_DOMAIN" || true
if [[ -f "$CADDY_OUTPUT" ]]; then
  echo "Config Caddy pronta em: $CADDY_OUTPUT"
fi

cat <<EOF

Status da infraestrutura após bootstrap:
- node: $(check_cmd node)
- npm: $(check_cmd npm)
- psql: $(check_cmd psql)
- systemctl: $(check_cmd systemctl)
- https/caddy: $(check_caddy_mode)
EOF

cat <<EOF

Assistente concluído.

Resumo inicial:
- Painel: https://$PANEL_DOMAIN
- Formulário sugerido: https://$DEFAULT_FORM_DOMAIN
- Galeria sugerida: https://$DEFAULT_GALLERY_DOMAIN
- Imagens sugerido: https://$DEFAULT_IMAGES_DOMAIN
- Files sugerido: https://$DEFAULT_FILES_DOMAIN
- API sugerido: https://$DEFAULT_API_DOMAIN
- E-mail do setup: $SETUP_EMAIL
- Login inicial do painel: ${PANEL_ADMIN_USER_INPUT} / (senha definida no setup)

Próximo passo recomendado:
1. Subir a aplicação localmente
2. Publicar ou revisar o service systemd
3. Publicar ou revisar a config Caddy gerada
4. Abrir o painel web de configuração em /painel/configuracoes
5. Finalizar logo, cores, textos, credenciais e demais domínios no navegador
6. HTTPS fica por conta do Caddy, sem passo manual de certificado
7. Depois avançar para os ajustes finais de publicação por subdomínio
EOF
