# Arquitetura

## Organização

- `domain`: Money, Wallet, WagerTransaction e WalletLedgerEntry.
- `application`: casos de uso, portas, eventos, inbox e outbox.
- `infrastructure`: PostgreSQL/MikroORM, HTTP, SQS, workers e observabilidade.

O domínio não depende de NestJS, MikroORM ou AWS SDK.

HTTP e SQS executam o mesmo caso de uso financeiro.

## Precisão monetária

Money utiliza Decimal.js com precisão configurada para preservar os valores
suportados.

Na entrada e na saída, valores monetários são strings com duas casas decimais.
No PostgreSQL, utilizam numeric(20,2).

O domínio restringe a faixa suportada a 18 dígitos inteiros e duas casas
decimais. Não há conversão de valores monetários para number.

Resultados internos negativos são permitidos pelo objeto Money, mas não
por saldos de carteira ou lançamentos válidos do ledger.

## Transação financeira

Cada execução da FinancialUnitOfWork utiliza um EntityManager isolado
e uma transação PostgreSQL em READ COMMITTED.

Os repositórios recebidos pelo callback compartilham essa transação.

Quando há movimento financeiro, a operação persiste atomicamente:

1. Estado e resultado da transação de aposta.
2. Saldo e versão da carteira.
3. Lançamento do ledger.
4. Eventos na outbox.
5. Estado da inbox, quando a origem é SQS.

Uma falha no callback ou no commit desfaz essas alterações.

## Concorrência

A carteira é carregada com bloqueio pessimista antes da alteração financeira.

Isso serializa movimentos sobre a mesma carteira entre processos distintos.
Carteiras diferentes podem ser processadas em paralelo.

A identidade idempotente é consultada novamente após obter o bloqueio,
pois outra execução pode ter concluído enquanto a atual aguardava.

Constraints de unicidade são a última proteção contra inserções concorrentes.
Conflitos de unicidade podem provocar uma nova execução integral do caso
de uso, utilizando entidades novas.

A versão começa em 1 e aumenta a cada movimento financeiro posterior
à abertura. Operações sem movimento não incrementam a versão.

## Idempotência

Há proteção por:

- Chave de idempotência.
- Identidade externa `(providerId, externalTransactionId)`.
- Identidade da inbox `(consumerName, messageId)`.

O hash do payload de negócio é calculado sobre uma representação canônica.

A mesma chave com o mesmo payload retorna o resultado persistido.
A mesma chave com outro payload gera conflito.

O saldo retornado em um replay é o snapshot associado à transação original.

## Ledger e proteções no banco

O ledger contém valores positivos, direção e saldos anterior e posterior.

Constraints verificam:

- Faixa monetária.
- Moeda suportada.
- Aritmética de crédito e débito.
- Unicidade de lançamento por carteira e transação.

Triggers bloqueiam UPDATE, DELETE e TRUNCATE do ledger.
Transações terminais e os campos originais do histórico também são protegidos.

Validações adicionais relacionam o lançamento à transação financeira,
incluindo valor, moeda, carteira, direção e saldo resultante.

Constraint triggers diferidos verificam a consistência final no commit:

- Transações financeiras processadas exigem o lançamento correspondente.
- Operações sem movimento não exigem lançamento.
- Saldo e versão da carteira precisam corresponder ao histórico.

Essas proteções se aplicam às operações SQL normais. A administração
privilegiada do banco continua sendo uma fronteira operacional de confiança.

## Abertura da carteira

Uma carteira aberta com saldo positivo gera:

- Transação interna OPENING.
- Crédito inicial no ledger.
- Eventos de transação processada e saldo alterado.

Uma carteira aberta com saldo zero não gera movimento financeiro.

A unicidade de `(playerId, currency)` impede duas carteiras para o mesmo
jogador e moeda.

## Referências fora de ordem

Uma operação cuja referência ainda não está disponível permanece em
PENDING_REFERENCE sem alterar o saldo.

O worker de referências utiliza:

- Claim temporário.
- Seleção com FOR UPDATE SKIP LOCKED.
- Backoff persistido.
- Limite de tentativas e prazo de espera.

Claims expirados podem ser recuperados por outra instância.

A referência é validada por identidade, moeda, status e tipo.
REFUND e ROLLBACK exigem reversão integral.

A unicidade de reversão processada é aplicada por referência e tipo:
no máximo um REFUND e um ROLLBACK processados para a mesma referência.

## Inbox e consumo SQS

A inbox é persistida na mesma transação das alterações financeiras.

O consumidor envia DeleteMessage somente após o processador retornar
do commit.

Se o processo morrer depois do commit e antes do ACK:

1. A visibilidade expira.
2. A mensagem reaparece.
3. A inbox e a idempotência reconhecem a repetição.
4. O resultado é reutilizado sem novo movimento financeiro.

O heartbeat renova a visibilidade durante operações demoradas.
Ele é interrompido e aguardado antes do tratamento de falha reagendar
a mensagem.

Mensagens inválidas e falhas com retries esgotados são encaminhadas à DLQ.
A mensagem original só é removida após a confirmação do envio à DLQ.

## Transactional outbox

Eventos são inseridos na mesma transação das alterações de negócio.

Publishers concorrentes reservam lotes com FOR UPDATE SKIP LOCKED
e um claim com prazo de expiração.

A atualização posterior exige o mesmo claim token, evitando que um
publisher antigo confirme um trabalho já reservado por outro.

Fluxo de publicação:

1. Reservar eventos pendentes.
2. Enviar ao SQS.
3. Marcar publishedAt e liberar o claim.

Se o processo morrer entre os passos 2 e 3, o evento pode ser republicado.
O identificador permanece estável e é utilizado na deduplicação FIFO.

Após a janela de deduplicação do broker, entregas repetidas ainda podem
ocorrer. O contrato é pelo menos uma vez.

## Shutdown e recuperação

A aplicação habilita os hooks de shutdown do NestJS.

Workers interrompem novas buscas e aguardam trabalho em andamento.
O consumidor interrompe o long polling e o publisher fecha o transporte
após aguardar sua execução.

O Compose permite até 90 segundos para o encerramento antes de forçar
a parada.

SIGKILL não executa hooks. Nesse cenário, a recuperação depende dos
dados persistidos, da expiração dos claims e da visibilidade SQS.

## Reconciliação

A reconciliação compara o saldo armazenado com a soma assinada do ledger
em uma consulta SQL.

Divergências geram diagnóstico e métrica. Não há correção automática.

## Implantação local

O Compose inicia:

- PostgreSQL.
- LocalStack SQS.
- Serviço de migrations.
- Serviço de criação das filas.
- Três réplicas da aplicação.
- Nginx como ponto de entrada HTTP.

As réplicas compartilham o banco e as filas. A coordenação financeira
não depende de locks em memória do processo.

## Evidências automatizadas

Os testes exercitam PostgreSQL e SQS local, incluindo:

- Violações de integridade e rollback.
- Repetição de requisições e mensagens.
- Operações concorrentes sobre a mesma carteira.
- Referências fora de ordem.
- Publicação concorrente da outbox.
- Métricas dos fluxos.
- Três processos independentes.
- Queda depois de commit HTTP.
- Queda entre commit e ACK SQS.
- Queda entre envio ao SQS e confirmação na outbox.

Os testes de crash utilizam SIGKILL real. Alguns prazos de claim são
antecipados por SQL para reduzir o tempo da suite.
