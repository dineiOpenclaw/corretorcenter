# Deploy Checklist - CorretorCenter

## 1. Base do sistema
- [ ] projeto copiado para a VPS
- [ ] Node.js instalado
- [ ] PostgreSQL instalado
- [ ] Nginx instalado
- [ ] `psql` disponível no host

## 2. Banco
- [ ] banco criado
- [ ] usuário criado com permissão no banco
- [ ] `.env` preenchido com credenciais corretas

## 3. Bootstrap
- [ ] `./scripts/bootstrap.sh`
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

## 6. Nginx
- [ ] backup da config antes de alterar
- [ ] `deploy/nginx.corretorcenter.example.conf` adaptado para os domínios reais
- [ ] site habilitado
- [ ] `nginx -t`
- [ ] `systemctl reload nginx`

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
