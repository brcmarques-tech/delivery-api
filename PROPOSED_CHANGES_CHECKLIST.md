# Checklist de alterações propostas

Este arquivo lista mudanças recomendadas, priorizadas e com instruções acionáveis.

## Instruções
- Rode `node scripts/show-checklist.js` para ver a checklist no terminal.
- Crie uma branch por área: `git checkout -b fix/<area>-<short>` e abra PR.

---

## Prioridade Alta (Segurança / Correção)
- [x] ~~Corrigir unidade de tempo do Throttler~~ — FALSO POSITIVO (verificado 2026-08-22).
  - O projeto usa `@nestjs/throttler@6`, onde `ttl` e em MILISSEGUNDOS. O atual
    `{ ttl: 60_000, limit: 120 }` = 60s esta CORRETO. NAO trocar para `{ ttl: 60 }`
    (viraria 60ms e desligaria na pratica o rate limit de login/OTP).

- [x] Validar presença de `JWT_SECRET` em produção e falha segura em boot — FEITO 2026-08-22 (`src/main.ts`: aborta o boot em producao sem JWT_SECRET).

- [ ] Revisar handshake WebSocket e política `REQUIRE_WS_AUTH` antes de ativar em produção: [src/app.module.ts](src/app.module.ts)

- [ ] Garantir que `RESEND_API_KEY` e outras chaves sensíveis NÃO estão no repo e que deploy usa secrets seguros (ver `docker-compose.prod.yml`).

## Banco de Dados / Migrations
- [ ] Confirmar que todas as mudanças de schema têm migrations em `src/migrations/` e que `data-source.ts` está alinhado: [src/data-source.ts](src/data-source.ts)
- [ ] Executar `npm run migration:generate` e revisar antes de `migration:run` em produção.

## Performance / Queries
- [x] `serviceRatings` sem paginacao — FEITO 2026-08-22 (teto 100/200 + limit/offset opcionais). Obs: os @ResolveField de ratings/users NAO sao N+1 (leem campos do @Parent ja carregado). Paineis admin (allOrders/allDeliveries/usuarios/aprovacoes) paginados no servidor em KAN-245/292.
- [ ] Revisar índices faltantes (alguns já têm @Index) e adicionar onde necessário (ex.: colunas FK críticas). Veja entidades em `src/**/entities/*.entity.ts`.

## Concurrency / Correctness
- [ ] Confirmar uso correto de transações e locks onde há incremento sequencial (`lastAppointmentNumber`). Ver: [src/appointments/appointments.service.ts](src/appointments/appointments.service.ts). (O race do `cart` ja foi corrigido — increment atomico.)

## Observabilidade / Operações
- [ ] Garantir que Sentry está recebendo erros no bootstrap (ver `src/main.ts`) e que DSN/ENV estão configurados em produção.
- [ ] Revisar retenção e limpeza de logs sensíveis (NotificationLog contém PII) — considerar mascaramento.

## Tests / CI
- [ ] Executar `yarn test` e `yarn test:e2e` localmente; adicionar/atualizar testes para cobrir regressões apontadas.
- [ ] Atualizar pipelines para não executar deploys automáticos sem `DEPLOY_ENABLED` (já documentado em `.gitlab-ci.yml`).

## Sugestões de PRs (pequenas e fáceis)
- [ ] PR: Corrigir `ThrottlerModule` ttl units + testes (branch `fix/throttler-ttl`)
- [ ] PR: Adicionar checagem de `JWT_SECRET` em boot (branch `fix/jwt-secret-check`)
- [ ] PR: Documentar `REQUIRE_WS_AUTH` e criar flag de migração segura (branch `chore/ws-auth-doc`)

---

## Comandos úteis
```bash
# mostrar checklist
node scripts/show-checklist.js

# rodar testes
yarn test
yarn test:e2e

# criar branch para correção crítica
git checkout -b fix/throttler-ttl
```

---

Atualize as caixas conforme for avançando.
