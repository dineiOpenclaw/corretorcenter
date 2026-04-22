#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
BACKUP_ROOT="${BACKUP_ROOT:-$ROOT_DIR/backups}"
TS="$(date +%Y-%m-%d_%H-%M-%S)"
BACKUP_DIR="$BACKUP_ROOT/update-$TS"
SKIP_BACKUP="${SKIP_BACKUP:-0}"
SKIP_NPM="${SKIP_NPM:-0}"
SKIP_MIGRATE="${SKIP_MIGRATE:-0}"
SKIP_CHECK="${SKIP_CHECK:-0}"
SERVICE_NAME="${SERVICE_NAME:-corretorcenter}"
RESTART_SERVICE="${RESTART_SERVICE:-auto}"
MANIFEST_FILE="$ROOT_DIR/.update-manifest.json"
DETECTED_CHANGES_FILE="$ROOT_DIR/.update-detected-changes.txt"
MAINTENANCE_PROGRESS_FILE="${MAINTENANCE_PROGRESS_FILE:-}"

log() {
  printf '\n[%s] %s\n' "update" "$1"
}

current_git_commit() {
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git rev-parse --short HEAD 2>/dev/null || true
  fi
}

sync_with_git_remote() {
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "Repositório git não detectado neste ambiente. Pulando sincronização com remoto."
    return 0
  fi

  local branch
  branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"
  echo "Commit local antes do update: $(current_git_commit || echo desconhecido)"
  git fetch origin "$branch"
  git pull --ff-only origin "$branch"
  echo "Commit local após sincronização: $(current_git_commit || echo desconhecido)"
}

write_progress() {
  local percent="$1"
  local label="$2"
  if [[ -n "$MAINTENANCE_PROGRESS_FILE" ]]; then
    printf '{"progressPercent":%s,"progressLabel":%s}\n' "$percent" "$(printf '%s' "$label" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" > "$MAINTENANCE_PROGRESS_FILE"
  fi
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "Comando obrigatório não encontrado: $1" >&2; exit 1; }
}

confirm() {
  local prompt="$1"
  read -r -p "$prompt [s/N]: " answer
  answer="${answer,,}"
  [[ "$answer" == "s" || "$answer" == "sim" ]]
}

maybe_restart_service() {
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "systemctl não encontrado. Reinicie o app manualmente se necessário."
    return 0
  fi

  if [[ "$RESTART_SERVICE" == "never" ]]; then
    echo "Reinício automático do service desativado."
    return 0
  fi

  if [[ "$RESTART_SERVICE" == "ask" ]]; then
    confirm "Deseja reiniciar o service ${SERVICE_NAME} agora?" || {
      echo "Reinício do service cancelado."
      return 0
    }
  fi

  if systemctl list-unit-files | grep -q "^${SERVICE_NAME}\.service"; then
    if systemctl is-enabled "$SERVICE_NAME" >/dev/null 2>&1 || systemctl is-active "$SERVICE_NAME" >/dev/null 2>&1; then
      if command -v sudo >/dev/null 2>&1; then
        sudo systemctl restart "$SERVICE_NAME"
      else
        systemctl restart "$SERVICE_NAME"
      fi
      echo "Service ${SERVICE_NAME} reiniciado."
    else
      echo "Service ${SERVICE_NAME} existe, mas não está habilitado/ativo. Nenhum restart automático foi feito."
    fi
  else
    echo "Service ${SERVICE_NAME} não encontrado. Se estiver rodando via node manual, reinicie manualmente."
  fi
}

create_backup() {
  mkdir -p "$BACKUP_DIR"
  printf '%s
' "$TS" > "$BACKUP_DIR/.backup-created-at"
  printf '%s
' "${APP_NAME:-CorretorCenter}" > "$BACKUP_DIR/.backup-project-name"
  if [[ -f "$ENV_FILE" ]]; then
    cp "$ENV_FILE" "$BACKUP_DIR/.env.backup"
  fi
  tar -czf "$BACKUP_DIR/project-files.tgz" \
    --exclude='node_modules' \
    --exclude='backups' \
    --exclude='uploads-tmp' \
    --exclude='.update-manifest.json' \
    --exclude='.update-detected-changes.txt' \
    --exclude='.maintenance-*' \
    --exclude='.last-maintenance-run.json' \
    --exclude='.maintenance-history.json' \
    --exclude='.maintenance-progress.json' \
    --exclude='.maintenance-action.lock' \
    -C "$ROOT_DIR" \
    .env.example README.md package.json app db deploy scripts
  echo "$BACKUP_DIR"
}


scan_relevant_changes() {
  python3 - "$ROOT_DIR" "$MANIFEST_FILE" "$DETECTED_CHANGES_FILE" <<'PY'
import hashlib, json, sys
from pathlib import Path
root = Path(sys.argv[1])
manifest_path = Path(sys.argv[2])
out_path = Path(sys.argv[3])
watched = [
    'package.json',
    'package-lock.json',
    'app/server.js',
    'deploy/corretorcenter.service.example',
    'deploy/caddy.example.conf',
    'scripts/install-wizard.sh',
    'scripts/update-assisted.sh',
    '.env.example',
]

def sha(path: Path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

current = {}
for rel in watched:
    p = root / rel
    current[rel] = sha(p) if p.exists() and p.is_file() else None

previous = {}
if manifest_path.exists():
    try:
        previous = json.loads(manifest_path.read_text())
    except Exception:
        previous = {}

changes = []
for rel, digest in current.items():
    if previous.get(rel) != digest:
        changes.append(rel)

out_path.write_text('\n'.join(changes))
manifest_path.write_text(json.dumps(current, indent=2, ensure_ascii=False) + '\n')
PY
}

print_change_summary() {
  if [[ ! -f "$DETECTED_CHANGES_FILE" ]]; then
    return 0
  fi

  mapfile -t changed_files < "$DETECTED_CHANGES_FILE"
  if [[ ${#changed_files[@]} -eq 0 ]]; then
    echo "Nenhuma mudança estrutural relevante detectada desde a última atualização registrada."
    return 0
  fi

  echo "Mudanças relevantes detectadas desde a última atualização registrada:"
  printf '%s
' "${changed_files[@]}" | sed 's/^/- /'

  if printf '%s
' "${changed_files[@]}" | grep -Eq '^(package.json|package-lock.json)$'; then
    echo "Aviso: houve mudança de dependências Node. npm install é especialmente importante nesta atualização."
  fi
  if printf '%s
' "${changed_files[@]}" | grep -Eq '^(deploy/.*caddy.*|scripts/install-wizard.sh|\.env.example)$'; then
    echo "Aviso: houve mudança relacionada a Caddy/setup. Revise publicação e templates antes de encerrar."
  fi
  if printf '%s
' "${changed_files[@]}" | grep -Eq '^(deploy/corretorcenter.service.example)$'; then
    echo "Aviso: houve mudança no template de service. Revise o unit file publicado se este ambiente já usa systemd."
  fi
  if printf '%s
' "${changed_files[@]}" | grep -Eq '^(app/server.js)$'; then
    echo "Aviso: houve mudança no backend principal. Valide login, painel, formulário e galerias após o update."
  fi
}

require_cmd bash
require_cmd node
require_cmd npm
require_cmd python3
require_cmd psql
require_cmd curl

cd "$ROOT_DIR"

log "Atualização assistida do CorretorCenter"
write_progress 10 "Preparando a atualização guiada do sistema."

echo "Resumo do fluxo:"
echo "- sincronização com o Git remoto quando o projeto estiver versionado"
echo "- detecção de mudanças relevantes desde a última atualização registrada"
echo "- backup opcional do projeto"
echo "- npm install"
echo "- migration"
echo "- restart opcional/automático do service"
echo "- checklist pós-update"

log "Sincronizando com o Git remoto"
write_progress 15 "Buscando a última versão publicada no GitHub."
sync_with_git_remote

log "Analisando mudanças relevantes"
write_progress 20 "Analisando as mudanças importantes antes da atualização."
scan_relevant_changes
print_change_summary

if [[ "$SKIP_BACKUP" != "1" ]]; then
  log "Criando backup de segurança"
  write_progress 35 "Criando um backup de segurança antes de continuar."
  BACKUP_PATH="$(create_backup)"
  echo "Backup criado em: $BACKUP_PATH"
else
  echo "Backup pulado por configuração (SKIP_BACKUP=1)."
fi

if [[ "$SKIP_NPM" != "1" ]]; then
  log "Instalando/atualizando dependências Node"
  write_progress 55 "Atualizando os componentes internos do sistema."
  npm install
else
  echo "npm install pulado por configuração (SKIP_NPM=1)."
fi

if [[ "$SKIP_MIGRATE" != "1" ]]; then
  log "Executando migrations"
  write_progress 75 "Atualizando a base de dados do sistema."
  "$ROOT_DIR/scripts/migrate.sh"
else
  echo "Migration pulada por configuração (SKIP_MIGRATE=1)."
fi

log "Tratando restart da aplicação"
write_progress 88 "Aplicando os ajustes finais e tratando a reinicialização do sistema."
maybe_restart_service

if [[ "$SKIP_CHECK" != "1" ]]; then
  log "Executando checklist pós-update"
  write_progress 95 "Conferindo se o sistema respondeu corretamente após a atualização."
  "$ROOT_DIR/scripts/post-deploy-check.sh"
else
  echo "Checklist pós-update pulado por configuração (SKIP_CHECK=1)."
fi

write_progress 100 "Atualização concluída com sucesso."

cat <<EOF

Atualização assistida concluída.

Próximos passos recomendados:
1. Validar login no painel
2. Validar cadastro/edição de imóvel e cliente
3. Validar formulário público
4. Validar galeria e imagens públicas
5. Se houve alteração de Caddy/HTTPS, validar também os hosts publicados
EOF
