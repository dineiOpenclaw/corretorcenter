# CorretorCenter

## Instalação rápida em outra VPS

### Requisitos
- Node.js 20+
- PostgreSQL 14+
- Caddy (o assistente tenta instalar o pacote ou o binário oficial, se necessário)
- Domínio/subdomínios apontados, com sufixo 1 nesta VPS
- `psql` disponível no host

### Passos
1. Copiar o projeto para a VPS
2. Criar o banco e usuário PostgreSQL
3. Ajustar `.env` a partir de `.env.example`
4. Rodar o assistente inicial recomendado:

```bash
./scripts/install-wizard.sh
```

Se preferir o fluxo técnico direto, ainda existe:

```bash
./scripts/bootstrap.sh
```

5. Validar localmente:

```bash
node app/server.js
```

6. Publicar service systemd usando:
- `deploy/corretorcenter.service.example`

7. Configurar Caddy/HTTPS usando:
- `deploy/caddy.corretorcenter.example.conf`
- `deploy/DEPLOY_CHECKLIST.md`
- `deploy/INSTALL_FLOW.md`

8. Se quiser categorias iniciais padrão:

```bash
./scripts/seed-categorias.sh
```

## O que o assistente inicial faz
- verifica o ambiente antes de começar
- mostra dependências principais encontradas ou faltando
- pede subdomínio principal do painel e sugere form1/galeria1/imagens1/files1/api1
- pede e-mail válido para o setup
- cria/preenche `.env` com domínios iniciais sugeridos desta VPS
- chama o bootstrap base
- gera arquivo base do service systemd com o caminho real do projeto
- pode publicar o service automaticamente quando o usuário confirmar
- gera config base do caddy para o domínio principal e os demais hostnames da VPS
- inclui template final multi-domain com SSL para painel, formulário, galeria e imagens
- o wizard também gera a versão preenchida desse template SSL final
- gera também uma config inicial multi-domain com comportamento separado para painel, formulário, galeria e imagens, incluindo limites de upload e cache básico para imagens
- quando caddy estiver disponível, pode publicar automaticamente a config simples ou a multi-domain
- o fluxo de SSL passa a considerar qual versão do caddy foi publicada
- após emissão bem-sucedida do SSL no modo multi-domain, o wizard já pode trocar para a config final HTTPS
- prepara a próxima etapa de SSL com instruções baseadas no ambiente
- monta o comando inicial de SSL para painel, formulário, galeria e imagens
- quando Caddy estiver disponível, pode tentar emitir o SSL automaticamente
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
