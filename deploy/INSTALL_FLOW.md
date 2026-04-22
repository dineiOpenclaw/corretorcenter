# CorretorCenter - Fluxo único de instalação

## Ordem recomendada

### 1. Preparar a VPS
- instalar Node.js 20+
- instalar Git
- instalar Caddy, ou deixar o assistente baixar o binário oficial se o pacote não existir
- deixar PostgreSQL para o assistente, se quiser o fluxo automático

### 2. Clonar o projeto
Exemplo para repositório público:

```bash
git clone https://github.com/dineiOpenclaw/corretorcenter.git
cd corretorcenter
```

### 3. Criar banco e usuário
Exemplo lógico:
- banco: `corretorcenter`
- usuário: `corretorcenter`
- senha forte

O assistente agora instala e sobe o PostgreSQL automaticamente quando ele não existe na VPS.
A criação inicial do banco e do usuário continua sendo uma etapa manual, porque depende da credencial final definida para aquela instalação.

### 4. Ajustar `.env`
No diretório do projeto, já considerando os subdomínios desta VPS:

```bash
cp .env.example .env
nano .env
```

Revisar no mínimo:
- domínios, com padrão `*1.codeflowsoluctions.com` nesta VPS
- credenciais do banco
- usuário/senha do painel
- nome interno e nome público do sistema

### 5. Rodar o assistente inicial

```bash
./scripts/install-wizard.sh
```

O assistente já verifica se o ambiente tem os comandos principais antes de seguir.
Se `psql` ou `postgresql.service` estiverem faltando, ele instala PostgreSQL localmente e sobe o serviço antes da migration base.

Se preferir, ainda é possível usar diretamente:

```bash
./scripts/bootstrap.sh
```

### 6. Se quiser categorias iniciais padrão

```bash
./scripts/seed-categorias.sh
```

### 7. Testar localmente

```bash
node app/server.js
```

Validar:
- `http://127.0.0.1:5180/health`
- `http://127.0.0.1:5180/formulario`

### 8. Publicar service systemd
Usar:
- `deploy/corretorcenter.service.example`

O assistente também pode:
- gerar automaticamente `deploy/corretorcenter.generated.service`
- publicar o service quando o usuário confirmar

### 9. Publicar caddy
Usar:
- `deploy/caddy.corretorcenter.example.conf`
- `deploy/caddy.panel-setup.example.conf`
- `deploy/caddy.multi-domain-ssl.example.conf`

O assistente também pode:
- gerar automaticamente `deploy/caddy.panel-setup.generated.conf`
- gerar automaticamente `deploy/caddy.multi-domain-setup.generated.conf` com blocos separados por host, limites básicos de upload e cache para imagens
- gerar automaticamente `deploy/caddy.multi-domain-ssl.generated.conf` como base final HTTPS preenchida
- publicar a config inicial simples ou multi-domain quando caddy estiver disponível e o usuário confirmar

### 10. Emitir SSL
O assistente já prepara a próxima etapa e mostra o comando sugerido para painel, formulário, galeria, imagens, files e api, todos com sufixo 1 nesta VPS.
Quando Caddy estiver disponível, ele também pode tentar publicar o HTTPS automaticamente com confirmação do usuário.
Depois disso, usar `deploy/caddy.multi-domain-ssl.example.conf` como base final do deploy HTTPS.
Quando o SSL for emitido com sucesso no fluxo multi-domain, o wizard já pode aplicar automaticamente a versão preenchida `deploy/caddy.multi-domain-ssl.generated.conf`.

### 11. Rodar checklist final
Usar:
- `deploy/DEPLOY_CHECKLIST.md`
- `./scripts/post-deploy-check.sh`

### 12. Planejar manutenção e atualização
Usar:
- `./scripts/update-assisted.sh`
- `deploy/UPDATE_FLOW.md`

### 13. Planejar distribuição controlada
Usar:
- `deploy/DISTRIBUTION_PLAN.md`
