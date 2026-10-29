## Migrations e constraints

As alterações do banco são aplicadas exclusivamente por migrations
versionadas e reversíveis, sem sincronização automática de schema.

No MikroORM 6.6.17, identificamos diferenças recorrentes entre a
representação de três CHECK constraints no mapeamento e a expressão
normalizada pelo PostgreSQL. O diff propõe recriá-las mesmo mantendo
as mesmas regras.

Por isso, migrations geradas são revisadas, e constraints financeiras
complexas são mantidas por SQL explícito. A validação das garantias
será feita por testes de integração contra PostgreSQL real.