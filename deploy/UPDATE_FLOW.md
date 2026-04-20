# CorretorCenter - Atualização assistida

## Objetivo
Atualizar o sistema com o menor risco possível, reduzindo trabalho manual e mantendo um caminho de rollback simples.

## Fluxo recomendado
```bash
./scripts/update-assisted.sh
```

## O que o script faz
- compara arquivos relevantes com a última atualização registrada
- avisa quando detecta mudança em dependências, caddy/setup, service ou backend principal
- cria backup do projeto antes da atualização
- roda `npm install`
- roda migrations
- tenta reiniciar o service `corretorcenter` quando existir
- roda checklist pós-update

## Variáveis úteis
- `SKIP_BACKUP=1` -> pula backup
- `SKIP_NPM=1` -> pula `npm install`
- `SKIP_MIGRATE=1` -> pula migration
- `SKIP_CHECK=1` -> pula checklist final
- `SERVICE_NAME=outro-service` -> troca o nome do service
- `RESTART_SERVICE=auto|ask|never` -> controla o restart
- `BACKUP_ROOT=/caminho` -> muda a pasta dos backups

## Exemplo
```bash
RESTART_SERVICE=ask ./scripts/update-assisted.sh
```

## Observação
O script mantém um manifesto local em `.update-manifest.json` para comparar mudanças relevantes entre uma atualização e outra, mesmo quando o projeto não estiver em um repositório git.

## Rollback básico
Se a atualização falhar e o problema não for simples de corrigir:
1. parar o service
2. restaurar o backup salvo em `backups/update-AAAA-MM-DD_HH-MM-SS`
3. revisar `.env` se houve alteração local
4. subir novamente o app/service

## Validação mínima após update
- `/health`
- `/formulario`
- login do painel
- página de manutenção
- busca/cadastro de imóveis
- busca/cadastro de clientes
- galeria pública
- host de imagens
