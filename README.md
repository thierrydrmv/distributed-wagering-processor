# Distributed Wagering Processor

Processador distribuído de transações de apostas com NestJS, PostgreSQL,
MikroORM e SQS FIFO.

O projeto utiliza Bun, valores monetários representados por strings,
ledger imutável, inbox para deduplicação de mensagens e transactional outbox.

## Requisitos

- Docker com Docker Compose v2.
- Bun 1.4.4 para desenvolvimento e testes locais.

O ambiente Docker inicia três réplicas da aplicação atrás de um Nginx.

## Executar com Docker

```bash
cp .env.example .env
docker compose up -d --build
docker compose ps -a
```

Na inicialização:

1. PostgreSQL e LocalStack ficam disponíveis.
2. O serviço `migrate` aplica as migrations.
3. O serviço `setup-queues` cria as filas.
4. Três réplicas da aplicação iniciam.
5. O gateway disponibiliza a API em `http://localhost:3000`.

Os serviços `migrate` e `setup-queues` devem terminar com código zero.

```bash
curl -i http://localhost:3000/health/live
curl -i http://localhost:3000/health/ready
```

Para consultar logs:

```bash
docker compose logs --tail=100 app
docker compose logs migrate setup-queues
```

Para encerrar sem remover o volume PostgreSQL:

```bash
docker compose down
```

O LocalStack deste ambiente não tem persistência configurada. As filas são
recriadas no bootstrap, mas suas mensagens podem ser perdidas ao recriar
o container.

Após recriar ou alterar a quantidade de réplicas, reinicie o gateway:

```bash
docker compose restart gateway
```

## Desenvolvimento local

```bash
bun install --frozen-lockfile
docker compose up -d postgres localstack
docker compose stop gateway
bun run migration:up
bun run queues:setup
bun run build
bun run start:prod
```

A aplicação compilada é executada para preservar os metadados dos decorators
emitidos pelo TypeScript.

As URLs do `.env` apontam para os serviços publicados no host. No Compose,
as URLs são substituídas pelos endereços internos `postgres` e `localstack`.

## Testes

Crie o banco de administração dos testes uma vez, usando as credenciais
locais do exemplo:

```bash
docker compose exec postgres psql -U wagering -d postgres \
  -c 'CREATE DATABASE wagering_test;'
```

Se o banco já existir, não é necessário recriá-lo.

```bash
bun run build
bun run test
bun run test:integration
```

O build deve anteceder os testes de integração porque os testes com
múltiplos processos executam `dist/main.js`.

A integração utiliza PostgreSQL e LocalStack reais. As suites criam bancos
e filas temporários. O usuário PostgreSQL dos testes precisa de permissão
para criar bancos.

`TEST_DATABASE_URL` deve apontar para `wagering_test`, nunca para o banco
da aplicação.

A cobertura inclui:

- Precisão monetária e regras de domínio.
- Constraints, triggers e imutabilidade do ledger.
- Atomicidade das alterações financeiras e da outbox.
- Idempotência e concorrência.
- Referências recebidas fora de ordem.
- Consumo SQS, inbox e encaminhamento para DLQ.
- Recuperação de claims da outbox.
- Métricas de processamento.
- Requisições concorrentes entre três processos.
- Recuperação após queda abrupta.
- Queda entre commit financeiro e ACK.
- Queda entre envio de evento e confirmação na outbox.

Alguns testes injetam falhas e geram logs de erro esperados.

## API

| Método | Endpoint                                                              | Finalidade                           |
| ------ | --------------------------------------------------------------------- | ------------------------------------ |
| POST   | `/wallets`                                                            | Abrir carteira                       |
| GET    | `/wallets/:walletId`                                                  | Consultar carteira                   |
| POST   | `/wagering/transactions`                                              | Processar transação                  |
| GET    | `/wagering/transactions/:transactionId`                               | Consultar transação                  |
| GET    | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consultar pelo identificador externo |
| GET    | `/wallets/:walletId/ledger`                                           | Consultar lançamentos paginados      |
| POST   | `/wallets/:walletId/reconciliation`                                   | Comparar saldo e ledger              |
| GET    | `/health/live`                                                        | Verificar processo                   |
| GET    | `/health/ready`                                                       | Verificar PostgreSQL e filas         |
| GET    | `/metrics`                                                            | Expor métricas Prometheus            |

### Abrir carteira

```bash
curl -i -X POST http://localhost:3000/wallets \
  -H 'Content-Type: application/json' \
  -d '{
    "playerId": "11111111-1111-4111-8111-111111111111",
    "initialBalance": {
      "amount": "100.00",
      "currency": "BRL"
    }
  }'
```

Utilize o `id` retornado como `walletId` nas próximas operações.

### Processar uma aposta

Substitua `WALLET_ID` pelo identificador retornado:

```bash
curl -i -X POST http://localhost:3000/wagering/transactions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-demo:bet-001' \
  -H 'X-Correlation-Id: demo-bet-001' \
  -d '{
    "providerId": "provider-demo",
    "externalTransactionId": "bet-001",
    "playerId": "11111111-1111-4111-8111-111111111111",
    "walletId": "WALLET_ID",
    "roundId": "round-001",
    "gameId": "game-001",
    "kind": "BET",
    "money": {
      "amount": "25.00",
      "currency": "BRL"
    }
  }'
```

Repita a mesma requisição e a mesma chave para obter um replay sem
outro débito. Reutilizar a chave com outro conteúdo gera conflito.

A unicidade de `(providerId, externalTransactionId)` também é protegida:
reenviar a mesma identidade externa com outra chave gera conflito.

Respostas de processamento:

- `200`: transação processada.
- `202`: aguardando referência.
- `400`: entrada inválida.
- `404`: recurso inexistente.
- `409`: conflito de identidade ou idempotência.
- `422`: rejeição de negócio.
- `503`: falha transitória de infraestrutura reconhecida pela aplicação.
- `500`: falha interna não classificada.

Repetições não reaplicam efeitos financeiros. Para transações terminais,
a API retorna o resultado persistido, incluindo o saldo registrado no
processamento original.

Transações pendentes podem apresentar um novo status após o processamento
pelo worker de referências.

### Valores e operações

Moedas suportadas: `BRL`, `USD`, `EUR` e `GBP`.

Valores monetários devem ser strings com exatamente duas casas decimais.
O máximo suportado é `999999999999999999.99`.

Operações externas:

| Operação | Efeito                                  |
| -------- | --------------------------------------- |
| BET      | Débito                                  |
| WIN      | Crédito; zero é permitido               |
| LOSS     | Valor zero, sem movimento financeiro    |
| REFUND   | Reversão integral de BET                |
| ROLLBACK | Reversão integral de BET, WIN ou REFUND |

REFUND e ROLLBACK exigem `referenceExternalTransactionId`.

OPENING é uma operação interna criada na abertura com saldo positivo.

### Ledger e reconciliação

```bash
curl 'http://localhost:3000/wallets/WALLET_ID/ledger?limit=20'

curl -X POST \
  http://localhost:3000/wallets/WALLET_ID/reconciliation
```

O ledger usa paginação por cursor. Utilize o cursor retornado pela API
na próxima consulta.

A reconciliação detecta divergências e não corrige saldos automaticamente.

## Mensagens SQS

Filas padrão:

- `wager-transactions.fifo`: entrada.
- `wager-transactions-dlq.fifo`: mensagens inválidas ou com retries esgotados.
- `wager-events.fifo`: eventos publicados pela outbox.

Envelope de entrada:

```json
{
  "messageId": "message-001",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-10-31T12:00:00.000Z",
  "correlationId": "demo-bet-001",
  "data": {
    "idempotencyKey": "provider-demo:bet-001",
    "providerId": "provider-demo",
    "externalTransactionId": "bet-001",
    "playerId": "11111111-1111-4111-8111-111111111111",
    "walletId": "22222222-2222-4222-8222-222222222222",
    "roundId": "round-001",
    "gameId": "game-001",
    "kind": "BET",
    "money": {
      "amount": "25.00",
      "currency": "BRL"
    }
  }
}
```

O exemplo exige uma carteira existente com os identificadores informados.

O produtor deve fornecer `MessageGroupId` e `MessageDeduplicationId`
ao enviar para a fila FIFO.

A identidade de transporte não substitui a idempotência de negócio.
O consumidor confirma a mensagem somente depois do commit.

## Observabilidade

Os logs da aplicação são JSON e os eventos de negócio incluem
identificadores de correlação quando disponíveis.

`X-Correlation-Id` é aceito na entrada HTTP e devolvido na resposta.

As métricas incluem:

- Requisições HTTP e duração.
- Resultados de processamento e replays.
- Exceções de processamento.
- Retries de referência, SQS e outbox.
- Envios do consumidor para a DLQ.
- Conflitos de persistência.
- Quantidade e idade de eventos pendentes na outbox.
- Divergências de reconciliação.

Contadores em memória pertencem a cada processo e reiniciam com ele.
Um coletor deve consultar cada réplica para agregar essas métricas.
Consultar `/metrics` pelo gateway retorna apenas uma réplica por chamada.

As métricas de backlog da outbox observam o mesmo banco compartilhado
e não devem ser somadas entre réplicas.

wagering_dlq_messages_total conta confirmações de envio à DLQ realizadas
pelo consumidor. Não representa o tamanho atual da fila nem inclui
movimentações automáticas do redrive.

## Limitações e decisões

- A autenticação de provedor está representada por um guard de extensão,
  atualmente permissivo. O ambiente não implementa autenticação real.
- As mensagens SQS são tratadas como um canal interno confiável;
  identidades e regras financeiras continuam sendo validadas.
- A entrega de eventos é pelo menos uma vez. Consumidores devem
  deduplicar por `eventId`.
- A deduplicação FIFO não substitui a deduplicação persistente.
- Reversões são integrais; reversões parciais não são suportadas.
- O esgotamento de retries de infraestrutura no consumidor encaminha
  a mensagem para DLQ; isso não garante a criação de uma transação FAILED.
- O ambiente utiliza LocalStack para exercitar a integração SQS.
  Os testes não substituem uma validação em uma conta AWS real.
- O Nginx local precisa ser reiniciado após recriar ou escalar réplicas
  para atualizar os endereços resolvidos.

Veja `ARCHITECTURE.md` para as decisões de consistência e recuperação.
