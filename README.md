# CorretorCenter

## Instalação rápida em outra VPS

### Requisitos
- Node.js 20+
- Caddy (o assistente tenta instalar o pacote ou o binário oficial, se necessário)
- Domínio/subdomínios apontados, com sufixo 1 nesta VPS
- `git` instalado no host

### Passos
1. Instalar o Git na VPS, se ainda não existir:

Ubuntu/Debian:
```bash
sudo apt update && sudo apt install -y git
```

Oracle Linux/RHEL/Fedora:
```bash
sudo dnf install -y git
```

2. Verificar se o Git ficou disponível:

```bash
git --version
```

3. Fazer o clone do repositório na VPS:

```bash
git clone https://github.com/dineiOpenclaw/corretorcenter.git
cd corretorcenter
```

4. Rodar o assistente inicial recomendado:

```bash
./scripts/install-wizard.sh
```

5. Validar localmente:

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
- instala automaticamente PostgreSQL local quando `psql` ou `postgresql.service` estiverem faltando
- garante que o serviço `postgresql` esteja ativo antes da migration base
- pede subdomínio principal do painel e sugere form1/galeria1/imagens1
- pede e-mail válido para o setup
- recria o `.env` a partir do modelo a cada instalação, salvando backup quando já existir
- chama o bootstrap base
- gera e publica automaticamente o service systemd com o caminho real do projeto
- garante o motor wkhtmltopdf para geração de PDFs do painel
- valida automaticamente a aplicação localmente no final da instalação
- gera e publica automaticamente a config do Caddy
- valida DNS, recarrega o Caddy e testa o subdomínio final
- detecta bloqueio local de firewall nas portas 80/443 e informa o operador com mensagem objetiva
- pede confirmação para liberar 80/443 automaticamente no iptables e persistir após reinício
- quando Caddy faltar, tenta instalar pacote e faz fallback para o binário oficial
- orienta abrir o painel web para finalizar a configuração

## O que o bootstrap faz
- cria `.env` a partir do exemplo, se não existir
- instala dependências Node
- instala PostgreSQL local quando necessário, cria/alinha usuário e banco padrão e inicia o serviço
- roda migration base
- aponta próximos passos de publicação

## O que o assistente valida no final
- sobe a aplicação localmente de forma temporária
- testa `http://127.0.0.1:5180/health`
- publica o service systemd
- garante que a geração de PDF tenha wkhtmltopdf disponível no servidor
- publica e recarrega o Caddy
- valida se o domínio do painel aponta para o IP público da VPS
- testa `https://<subdomínio-do-painel>/health`
- se o HTTPS externo falhar, tenta explicar a causa real, incluindo bloqueio local de firewall em 80/443
- nesse caso, pede confirmação para abrir 80/443 automaticamente, recarrega o Caddy e aguarda mais tempo pela emissão do certificado antes de repetir o teste externo
- interrompe com log ou erro claro se alguma etapa não responder

## Verificação pós-deploy
```bash
./scripts/post-deploy-check.sh
```

## Atualização assistida
```bash
./scripts/update-assisted.sh
```

O fluxo agora também sincroniza com o Git remoto quando o projeto estiver em um repositório versionado, mostra o commit antes/depois do update e depois continua com `npm install`, migration e restart.

Referência:
- `deploy/UPDATE_FLOW.md`

## Reset completo para reinstalação limpa

Use este reset apenas em VPS dedicada ao CorretorCenter. Ele tenta remover somente o que existir no momento, então funciona mesmo quando a instalação anterior falhou no meio do caminho.

O que ele limpa:
- pasta do projeto
- serviço `corretorcenter`
- Caddy do projeto
- PostgreSQL, banco e dados
- `nodejs`, `npm` e `wkhtmltopdf` instalados para o fluxo
- persistência de firewall aberta no deploy

### Uso normal
Saia da pasta do projeto e execute:

```bash
cd ..
bash corretorcenter/scripts/reset-install.sh
```

### Uso sem confirmação interativa
```bash
cd ..
bash corretorcenter/scripts/reset-install.sh --yes
```

### Observação importante
- se você estiver dentro da pasta `corretorcenter`, o script interrompe para evitar erro na remoção
- se algum item não existir, ele apenas informa e segue
- se a instalação tiver quebrado no meio, o reset continua tentando limpar o que sobrou

## Distribuição e licenciamento

## Status do Bloco 4

## O que ainda é manual
- domínios
- caddy final
- SSL
- service definitivo no caminho da VPS
- criação manual do banco/usuário PostgreSQL quando fugir do padrão automático do instalador

## Observação
A migration base não força categorias iniciais. Isso é intencional para manter a base reaplicável.
O seed padrão agora é opcional via `./scripts/seed-categorias.sh`.
