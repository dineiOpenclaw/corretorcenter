# Deploy Checklist - CorretorCenter

## 1. Base do sistema
- [ ] projeto clonado na VPS
- [ ] Node.js instalado
- [ ] Git instalado
- [ ] PostgreSQL instalado automaticamente pelo assistente ou manualmente
- [ ] serviço `postgresql` ativo
- [ ] Caddy instalado, por pacote ou binário oficial

## 2. Banco
- [ ] banco criado
- [ ] usuário criado com permissão no banco
- [ ] `.env` preenchido com credenciais corretas

## 3. Bootstrap
- [ ] `./scripts/install-wizard.sh` ou `./scripts/bootstrap.sh`
- [ ] migration executada com sucesso
- [ ] `./scripts/seed-categorias.sh` executado se desejar catálogo inicial

## 4. Aplicação
- [ ] app sobe localmente com `node app/server.js`
- [ ] `/health` responde OK
- [ ] autenticação do painel funciona

## 5. Service
- [ ] `deploy/corretorcenter.service.example` adaptado para o caminho real
- [ ] service copiado para `/etc/systemd/system/corretorcenter.service`
- [ ] `systemctl daemon-reload`
- [ ] `systemctl enable --now corretorcenter`

## 6. Caddy
- [ ] backup da config antes de alterar
- [ ] `deploy/caddy.corretorcenter.example.conf` adaptado para os domínios reais desta VPS
- [ ] site habilitado
- [ ] `caddy -t`
- [ ] `systemctl reload caddy`

## 7. SSL
- [ ] certificados emitidos
- [ ] painel abre com HTTPS
- [ ] formulário abre com HTTPS
- [ ] galeria abre com HTTPS

## 8. Validação final
- [ ] `/painel`
- [ ] `/formulario`
- [ ] `/painel/clientes`
- [ ] `/painel/imoveis`
- [ ] exportação
- [ ] PDF comercial
- [ ] PDF completo
