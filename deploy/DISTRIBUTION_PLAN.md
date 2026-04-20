# CorretorCenter - 

## Objetivo
Criar um caminho controlado para distribuir o sistema sem depender de acesso solto ao código e sem transformar a instalação em algo confuso para cliente leigo.

## Estratégia inicial recomendada
### Fase 1
Distribuição privada e assistida.

Modelo sugerido:
- código em repositório privado
- acesso liberado por token/chave
- instalação guiada pelo `install-wizard.sh`
- manutenção guiada pelo painel e por `update-assisted.sh`

## O que controlar já nessa fase
- quem pode baixar o projeto
- qual versão foi entregue para cada cliente
- qual domínio principal foi configurado
- quando a última atualização foi aplicada
- qual `` pertence a qual cliente
- qual `` e canal comercial foram usados em cada entrega

## Estrutura mínima sugerida
### 1. Código-fonte privado
- GitHub privado ou forge privada equivalente

### 2. Entrega controlada
- token de leitura por cliente ou por operação
- revogação simples quando necessário

### 3. Identificação da instalação
Sugestão já preparada no projeto:
- ``
- ``
- ``
- ``
- ``

Esses campos já podem existir no `.env`, mesmo antes da fase completa de licenciamento.

## Fluxo recomendado de evolução
### Etapa A
Controle privado de distribuição
- repositório privado
- tag por versão
- checklist de entrega
- usar `deploy/DELIVERY_CHECKLIST.md` para padronizar cada instalação entregue

### Etapa B
Identidade da instalação
- gerar ID da instalação
- registrar cliente, VPS e domínio principal
- persistir a entrega na tabela ``

### Etapa C
Licença leve
- chave por cliente
- validação simples no painel ou no update

### Etapa D
Portal próprio
- download controlado
- versão disponível
- instruções e atualizações por cliente
- visão administrativa de instalações entregues no painel

## O que ainda não fazer agora
- DRM pesado
- ativação online obrigatória em toda execução
- auto-update cego
- bloqueios agressivos que atrapalhem suporte

## Direção de produto
Para o estágio atual, o melhor equilíbrio é:
- instalação fácil
- manutenção guiada
- distribuição privada
- licenciamento leve e rastreável

Isso mantém o produto vendável sem complicar demais a operação.
