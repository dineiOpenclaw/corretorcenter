# CorretorCenter

## Instalação rápida em outra VPS

### Requisitos
- Node.js 20+
- PostgreSQL 14+
- Caddy (o assistente tenta instalar o pacote ou o binário oficial, se necessário)
- Domínio/subdomínios apontados, com sufixo 1 nesta VPS
- `psql` disponível no host

### Passos
1. Fazer o clone do repositório na VPS
2. Rodar o assistente inicial recomendado:

```bash
./scripts/install-wizard.sh
```

Se preferir o fluxo técnico direto, ainda existe:

```bash
./scripts/bootstrap.sh
```

3. Validar localmente:

```bash
node app/server.js
```

4. Publicar service systemd usando:
- `deploy/corretorcenter.service.example`

5. Configurar Caddy/HTTPS usando:
- `deploy/caddy.corretorcenter.example.conf`
- `deploy/DEPLOY_CHECKLIST.md`
- `deploy/INSTALL_FLOW.md`

6. Se quiser categorias iniciais padrão:

```bash
./scripts/seed-categorias.sh
```

## O que o assistente inicial faz
- verifica o ambiente antes de começar
- mostra dependências principais encontradas ou faltando
- pede subdomínio principal do painel e sugere form1/galeria1/imagens1/files1/api1
- pede e-mail válido para o setup
- cria/preenche `.env` durante a instalação
- chama o bootstrap base
- gera arquivo base do service systemd com o caminho real do projeto
- pode publicar o service automaticamente quando o usuário confirmar
- gera config base do Caddy para os hostnames da VPS
- publica o HTTPS automaticamente quando o Caddy estiver disponível
- quando o Caddy não estiver disponível, tenta instalar pacote ou binário oficial
- orienta abrir o painel web para finalizar a configuração

## O que o bootstrap faz
- cria `.env` a partir do exemplo, se não existir
- instala dependências Node
- roda migration base
- aponta próximos passos de publicação

## Verificação pós-deploy
```bash
./scripts/post-deploy-check.sh
```

## Atualização assistida
```bash
./scripts/update-assisted.sh
```

O fluxo também detecta mudanças relevantes desde a última atualização registrada, mesmo sem git.

Referência:
- `deploy/UPDATE_FLOW.md`

## Distribuição e licenciamento

## Status do Bloco 4

## O que ainda é manual
- domínios
- caddy final
- SSL
- service definitivo no caminho da VPS
- criação inicial do banco/usuário PostgreSQL

## Observação
A migration base não força categorias iniciais. Isso é intencional para manter a base reaplicável.
O seed padrão agora é opcional via `./scripts/seed-categorias.sh`.
