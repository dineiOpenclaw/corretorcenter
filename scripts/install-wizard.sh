#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_EXAMPLE="$ROOT_DIR/.env.example"
ENV_FILE="$ROOT_DIR/.env"
BOOTSTRAP_SCRIPT="$ROOT_DIR/scripts/bootstrap.sh"
NGINX_TEMPLATE="$ROOT_DIR/deploy/nginx.panel-setup.example.conf"
NGINX_OUTPUT="$ROOT_DIR/deploy/nginx.panel-setup.generated.conf"
NGINX_MULTI_TEMPLATE="$ROOT_DIR/deploy/nginx.multi-domain-setup.example.conf"
NGINX_MULTI_OUTPUT="$ROOT_DIR/deploy/nginx.multi-domain-setup.generated.conf"
NGINX_SSL_TEMPLATE="$ROOT_DIR/deploy/nginx.multi-domain-ssl.example.conf"
NGINX_SSL_OUTPUT="$ROOT_DIR/deploy/nginx.multi-domain-ssl.generated.conf"
SERVICE_TEMPLATE="$ROOT_DIR/deploy/corretorcenter.service.example"
SERVICE_OUTPUT="$ROOT_DIR/deploy/corretorcenter.generated.service"

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

check_certbot_mode() {
  if command -v certbot >/dev/null 2>&1; then
    echo "certbot"
  elif command -v snap >/dev/null 2>&1; then
    echo "snap-disponivel"
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
  [[ "$os_id" == "ubuntu" || "$os_id" == "debian" || "$os_like" == *debian* ]]
}

install_with_apt() {
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
  sudo apt-get update
  sudo apt-get install -y "${packages[@]}"
}

prepare_nginx_config() {
  local panel_domain="$1"
  if [[ ! -f "$NGINX_TEMPLATE" ]]; then
    echo "Template nginx não encontrado: $NGINX_TEMPLATE"
    return 1
  fi
  sed "s|__PANEL_DOMAIN__|$panel_domain|g" "$NGINX_TEMPLATE" > "$NGINX_OUTPUT"
  echo
  echo "Config base do nginx gerada em: $NGINX_OUTPUT"
}

prepare_multi_domain_nginx_config() {
  local panel_domain="$1"
  local form_domain="$2"
  local gallery_domain="$3"
  local images_domain="$4"
  if [[ ! -f "$NGINX_MULTI_TEMPLATE" ]]; then
    echo "Template nginx multi-domain não encontrado: $NGINX_MULTI_TEMPLATE"
    return 1
  fi
  sed \
    -e "s|__PANEL_DOMAIN__|$panel_domain|g" \
    -e "s|__FORM_DOMAIN__|$form_domain|g" \
    -e "s|__GALLERY_DOMAIN__|$gallery_domain|g" \
    -e "s|__IMAGES_DOMAIN__|$images_domain|g" \
    "$NGINX_MULTI_TEMPLATE" > "$NGINX_MULTI_OUTPUT"
  echo "Config nginx multi-domain gerada em: $NGINX_MULTI_OUTPUT"
}

prepare_multi_domain_ssl_config() {
  local panel_domain="$1"
  local form_domain="$2"
  local gallery_domain="$3"
  local images_domain="$4"
  if [[ ! -f "$NGINX_SSL_TEMPLATE" ]]; then
    echo "Template nginx SSL não encontrado: $NGINX_SSL_TEMPLATE"
    return 1
  fi
  sed \
    -e "s|__PANEL_DOMAIN__|$panel_domain|g" \
    -e "s|__FORM_DOMAIN__|$form_domain|g" \
    -e "s|__GALLERY_DOMAIN__|$gallery_domain|g" \
    -e "s|__IMAGES_DOMAIN__|$images_domain|g" \
    "$NGINX_SSL_TEMPLATE" > "$NGINX_SSL_OUTPUT"
  echo "Config nginx multi-domain com SSL gerada em: $NGINX_SSL_OUTPUT"
}

publish_nginx_config() {
  local source_file="$1"
  local target_name="$2"
  if ! command -v sudo >/dev/null 2>&1; then
    echo "sudo não encontrado. Publicação automática do nginx indisponível."
    return 1
  fi
  local target_available="/etc/nginx/sites-available/${target_name}"
  local target_enabled="/etc/nginx/sites-enabled/${target_name}"
  sudo cp "$source_file" "$target_available"
  sudo ln -sfn "$target_available" "$target_enabled"
  sudo nginx -t
  sudo systemctl reload nginx
  echo "Config do nginx publicada com sucesso: $target_name"
}

switch_to_ssl_nginx_config() {
  local target_name="$1"
  if [[ ! -f "$NGINX_SSL_OUTPUT" ]]; then
    echo "Config SSL final não encontrada: $NGINX_SSL_OUTPUT"
    return 1
  fi
  echo "Aplicando config final HTTPS do nginx..."
  publish_nginx_config "$NGINX_SSL_OUTPUT" "$target_name"
}

maybe_publish_nginx_configs() {
  PUBLISHED_NGINX_MODE="none"
  if [[ ! -f "$NGINX_OUTPUT" ]]; then
    return 0
  fi
  read -r -p "Deseja publicar automaticamente a config inicial do nginx? [s/N]: " answer
  answer="${answer,,}"
  if [[ "$answer" != "s" && "$answer" != "sim" ]]; then
    echo "Publicação automática do nginx cancelada."
    return 1
  fi
  if [[ -f "$NGINX_MULTI_OUTPUT" ]]; then
    read -r -p "Publicar a versão multi-domain em vez da versão simples? [s/N]: " multi_answer
    multi_answer="${multi_answer,,}"
    if [[ "$multi_answer" == "s" || "$multi_answer" == "sim" ]]; then
      if publish_nginx_config "$NGINX_MULTI_OUTPUT" "corretorcenter-multi-domain-setup.conf"; then
        PUBLISHED_NGINX_MODE="multi"
        return 0
      fi
      return 1
    fi
  fi
  if publish_nginx_config "$NGINX_OUTPUT" "corretorcenter-panel-setup.conf"; then
    PUBLISHED_NGINX_MODE="simple"
    return 0
  fi
  return 1
}

prepare_ssl_step() {
  local panel_domain="$1"
  local form_domain="$2"
  local gallery_domain="$3"
  local images_domain="$4"
  local setup_email="$5"
  local certbot_mode="$6"
  local nginx_status="$7"
  local published_nginx_mode="$8"
  local certbot_cmd="sudo certbot --nginx -d $panel_domain -d $form_domain -d $gallery_domain -d $images_domain -m $setup_email --agree-tos --redirect --no-eff-email"
  echo
  echo "Preparação de SSL:"
  case "$certbot_mode" in
    certbot)
      echo "- certbot encontrado no sistema"
      echo "- comando sugerido para emitir SSL inicial dos subdomínios:"
      echo "  $certbot_cmd"
      if [[ "$nginx_status" == "OK" ]]; then
        if [[ "$published_nginx_mode" == "simple" ]]; then
          echo "- aviso: a config publicada foi a simples; para SSL multi-domain, prefira publicar a versão multi-domain antes"
        fi
        read -r -p "Deseja tentar emitir o SSL automaticamente agora? [s/N]: " ssl_answer
        ssl_answer="${ssl_answer,,}"
        if [[ "$ssl_answer" == "s" || "$ssl_answer" == "sim" ]]; then
          if command -v sudo >/dev/null 2>&1; then
            if sudo certbot --nginx -d "$panel_domain" -d "$form_domain" -d "$gallery_domain" -d "$images_domain" -m "$setup_email" --agree-tos --redirect --no-eff-email; then
              if [[ "$published_nginx_mode" == "multi" ]]; then
                switch_to_ssl_nginx_config "corretorcenter-multi-domain-setup.conf" || true
              fi
            else
              echo "Falha ao emitir SSL automaticamente. Revise DNS/nginx e tente depois."
            fi
          else
            echo "sudo não encontrado. Emissão automática do SSL indisponível."
          fi
        else
          echo "Emissão automática do SSL cancelada."
        fi
      else
        echo "- publique o nginx primeiro para permitir emissão automática do SSL"
      fi
      ;;
    snap-disponivel)
      echo "- certbot não encontrado, mas snap está disponível"
      echo "- próximo passo sugerido: instalar certbot e emitir SSL"
      echo "  sudo snap install --classic certbot"
      echo "  sudo ln -s /snap/bin/certbot /usr/bin/certbot"
      echo "  $certbot_cmd"
      ;;
    *)
      echo "- certbot não encontrado neste ambiente"
      echo "- após instalar certbot, use:"
      echo "  $certbot_cmd"
      ;;
  esac
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

PUBLISHED_NGINX_MODE="none"

log "Assistente inicial de instalação do CorretorCenter"

OS_ID="$(get_os_id)"
OS_LIKE="$(get_os_like)"
SUPPORTED_OS="nao"
if is_supported_linux; then SUPPORTED_OS="sim"; fi

NODE_STATUS="$(check_cmd node)"
NPM_STATUS="$(check_cmd npm)"
PSQL_STATUS="$(check_cmd psql)"
NGINX_STATUS="$(check_cmd nginx)"
SYSTEMCTL_STATUS="$(check_cmd systemctl)"
CERTBOT_MODE="$(check_certbot_mode)"

cat <<EOF

Verificação inicial do ambiente:
- sistema: ${OS_ID}${OS_LIKE:+ (like: $OS_LIKE)}
- homologado para instalação assistida: $SUPPORTED_OS
- node: $NODE_STATUS
- npm: $NPM_STATUS
- psql: $PSQL_STATUS
- nginx: $NGINX_STATUS
- systemctl: $SYSTEMCTL_STATUS
- ssl/certbot: $CERTBOT_MODE
EOF

MISSING_REQUIRED=()
[[ "$NODE_STATUS" == "FALTANDO" ]] && MISSING_REQUIRED+=(nodejs npm)
[[ "$NPM_STATUS" == "FALTANDO" && "$NODE_STATUS" != "FALTANDO" ]] && MISSING_REQUIRED+=(npm)
[[ "$PSQL_STATUS" == "FALTANDO" ]] && MISSING_REQUIRED+=(postgresql-client)
MISSING_OPTIONAL=()
[[ "$NGINX_STATUS" == "FALTANDO" ]] && MISSING_OPTIONAL+=(nginx)

if ((${#MISSING_REQUIRED[@]} > 0)); then
  echo
  echo "Dependências obrigatórias faltando: ${MISSING_REQUIRED[*]}"
  if is_supported_linux; then
    install_with_apt "${MISSING_REQUIRED[@]}" || {
      echo "Não foi possível concluir a instalação automática das dependências obrigatórias."
      exit 1
    }
    NODE_STATUS="$(check_cmd node)"
    NPM_STATUS="$(check_cmd npm)"
    PSQL_STATUS="$(check_cmd psql)"
  else
    echo "Instalação automática só está homologada para Ubuntu/Debian neste momento."
    exit 1
  fi
fi

if ((${#MISSING_OPTIONAL[@]} > 0)) && is_supported_linux; then
  echo
  echo "Dependências opcionais úteis ainda faltando: ${MISSING_OPTIONAL[*]}"
  install_with_apt "${MISSING_OPTIONAL[@]}" || true
  NGINX_STATUS="$(check_cmd nginx)"
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

DEFAULT_FORM_DOMAIN="form.${PANEL_DOMAIN#*.}"
DEFAULT_GALLERY_DOMAIN="galeria.${PANEL_DOMAIN#*.}"
DEFAULT_IMAGES_DOMAIN="imagens.${PANEL_DOMAIN#*.}"
DEFAULT_APP_NAME="Minha Imobiliária"
DEFAULT_PANEL_TITLE="Painel Imobiliário"

set_env_value PANEL_DOMAIN "$PANEL_DOMAIN"
set_env_value FORM_DOMAIN "$DEFAULT_FORM_DOMAIN"
set_env_value GALLERY_DOMAIN "$DEFAULT_GALLERY_DOMAIN"
set_env_value IMAGES_DOMAIN "$DEFAULT_IMAGES_DOMAIN"
set_env_value SETUP_CONTACT_EMAIL "$SETUP_EMAIL"
set_env_value APP_NAME "${APP_NAME:-$DEFAULT_APP_NAME}"
set_env_value PANEL_TITLE "${PANEL_TITLE:-$DEFAULT_PANEL_TITLE}"

log "Executando bootstrap base"
"$BOOTSTRAP_SCRIPT"

prepare_service_file || true
if [[ -f "$SERVICE_OUTPUT" ]]; then
  publish_service_file || true
fi

prepare_nginx_config "$PANEL_DOMAIN" || true
prepare_multi_domain_nginx_config "$PANEL_DOMAIN" "$DEFAULT_FORM_DOMAIN" "$DEFAULT_GALLERY_DOMAIN" "$DEFAULT_IMAGES_DOMAIN" || true
prepare_multi_domain_ssl_config "$PANEL_DOMAIN" "$DEFAULT_FORM_DOMAIN" "$DEFAULT_GALLERY_DOMAIN" "$DEFAULT_IMAGES_DOMAIN" || true
if [[ "$NGINX_STATUS" == "OK" && -f "$NGINX_OUTPUT" ]]; then
  maybe_publish_nginx_configs || true
else
  echo "Se quiser publicar depois, use a config gerada em: $NGINX_OUTPUT"
fi
if [[ -f "$NGINX_MULTI_OUTPUT" ]]; then
  echo "Config multi-domain pronta para próxima fase em: $NGINX_MULTI_OUTPUT"
fi
if [[ -f "$NGINX_SSL_OUTPUT" ]]; then
  echo "Config final multi-domain com SSL pronta em: $NGINX_SSL_OUTPUT"
fi

prepare_ssl_step "$PANEL_DOMAIN" "$DEFAULT_FORM_DOMAIN" "$DEFAULT_GALLERY_DOMAIN" "$DEFAULT_IMAGES_DOMAIN" "$SETUP_EMAIL" "$CERTBOT_MODE" "$NGINX_STATUS" "$PUBLISHED_NGINX_MODE"

cat <<EOF

Status da infraestrutura após bootstrap:
- node: $(check_cmd node)
- npm: $(check_cmd npm)
- psql: $(check_cmd psql)
- nginx: $(check_cmd nginx)
- systemctl: $(check_cmd systemctl)
- ssl/certbot: $(check_certbot_mode)
EOF

cat <<EOF

Assistente concluído.

Resumo inicial:
- Painel: https://$PANEL_DOMAIN
- Formulário sugerido: https://$DEFAULT_FORM_DOMAIN
- Galeria sugerida: https://$DEFAULT_GALLERY_DOMAIN
- Imagens sugerido: https://$DEFAULT_IMAGES_DOMAIN
- E-mail do setup: $SETUP_EMAIL

Próximo passo recomendado:
1. Subir a aplicação localmente
2. Publicar ou revisar o service systemd
3. Publicar ou revisar a config base do nginx para o domínio do painel
4. Abrir o painel web de configuração em /painel/configuracoes
5. Finalizar logo, cores, textos, credenciais e demais domínios no navegador
6. Emitir SSL inicial para painel, formulário, galeria e imagens
7. Depois avançar para os ajustes finais de publicação por subdomínio
EOF
