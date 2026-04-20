# CorretorCenter - Fluxo único de instalação

## Ordem recomendada

### 1. Preparar a VPS
- instalar Node.js 20+
- instalar PostgreSQL 14+
- instalar Nginx
- garantir `psql` disponível

### 2. Copiar o projeto
Exemplo:

```bash
scp -r CorretorCenter usuario@vps:/opt/corretorcenter
```

### 3. Criar banco e usuário
Exemplo lógico:
- banco: `corretorcenter`
- usuário: `corretorcenter`
- senha forte

### 4. Ajustar `.env`
No diretório do projeto:

```bash
cp .env.example .env
nano .env
```

Revisar no mínimo:
- domínios
- credenciais do banco
- usuário/senha do painel
- nome interno e nome público do sistema

### 5. Rodar o assistente inicial

```bash
./scripts/install-wizard.sh
```

O assistente já verifica se o ambiente tem os comandos principais antes de seguir.

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

### 9. Publicar nginx
Usar:
- `deploy/nginx.corretorcenter.example.conf`
- `deploy/nginx.panel-setup.example.conf`
- `deploy/nginx.multi-domain-ssl.example.conf`

O assistente também pode:
- gerar automaticamente `deploy/nginx.panel-setup.generated.conf`
- gerar automaticamente `deploy/nginx.multi-domain-setup.generated.conf` com blocos separados por host, limites básicos de upload e cache para imagens
- gerar automaticamente `deploy/nginx.multi-domain-ssl.generated.conf` como base final HTTPS preenchida
- publicar a config inicial simples ou multi-domain quando nginx estiver disponível e o usuário confirmar

### 10. Emitir SSL
O assistente já prepara a próxima etapa e mostra o comando sugerido para painel, formulário, galeria e imagens.
Quando nginx e certbot estiverem disponíveis, ele também pode tentar emitir o SSL automaticamente com confirmação do usuário, considerando se a config publicada foi a simples ou a multi-domain.
Depois disso, usar `deploy/nginx.multi-domain-ssl.example.conf` como base final do deploy HTTPS.
Quando o SSL for emitido com sucesso no fluxo multi-domain, o wizard já pode aplicar automaticamente a versão preenchida `deploy/nginx.multi-domain-ssl.generated.conf`.

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
