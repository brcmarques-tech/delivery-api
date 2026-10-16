# Provas

Scripts que **medem** em vez de supor. Cada um existe porque alguma afirmação
sobre o sistema precisava de evidência, e porque ler o código não bastava.

Eles viviam em `bcmTech/`, fora de qualquer repositório. Estão aqui porque:

- comentários no código já apontavam para eles (uma referência pendurada), e
- esta máquina tem histórico de reset duro, e eles eram a única prova de
  decisões que mudaram código de dinheiro.

Os originais continuam em `bcmTech/` e podem ser apagados. Atenção: as cópias
daqui derivam a raiz da API da própria localização (`../..`); as de `bcmTech/`
usam caminho absoluto. **Não são intercambiáveis.**

## Antes de rodar

Precisam, dependendo do script:

- a stack local no ar (`docker compose up -d`): `shopping-postgres`, `shopping-api`
- `shopping-api/.env` com `PAGARME_SECRET_KEY` de **sandbox** (`sk_test...`)

Os que falam com o provedor **abortam** se a chave não começar com `sk_test`.
Alguns **criam cobranças reais no sandbox** (R$ 2 a R$ 4) e as estornam ali
mesmo — estão marcados abaixo com 💳. Não são para rodar por hábito.

---

## Comportamento do provedor (Pagar.me v5)

| script | o que prova |
|---|---|
| `audita-rotas-pagarme.mjs` | Quais rotas existem de fato. Compara a **forma** do 404 de uma rota suspeita com o de uma rota inventada de propósito — 404 de corpo vazio é rota inexistente; 404 com `"Charge not found"` é rota que existe e não achou o recurso. |
| `experimento-estorno.mjs` 💳 | `POST /charges/{id}/refund` **não existe**. O estorno é `DELETE /charges/{id}` — sem corpo total, com `{amount}` parcial. E o provedor responde **HTTP 200 mesmo quando recusa o estorno**: a verdade está em `last_transaction.status`. A recusa pós-captura é **intermitente**, não uma janela fixa. |
| `experimento-void-preauth.mjs` 💳 | O void de pré-autorização não capturada responde 200 com `charge=canceled` e `last_transaction=refunded` — a mesma palavra do estorno, embora nada de dinheiro tenha se movido. Anular duas vezes, capturar cobrança anulada e recapturar respondem **412**, que lança. Isso delimita o problema do 200-mascarando-falha: é do estorno de cobrança **paga**, não de toda operação. |
| `sonda-repasse.mjs` | `POST /recipients/{id}/transfers` é um **saque** do saldo do próprio recebedor para a conta bancária dele (provado pelo prefixo `with_` do id e pela `bank_account` no registro criado). **Não existe empurrão plataforma → recebedor.** Logo: repasse automático ⟺ beneficiário no split ⟺ conhecido na criação da cobrança. |
| `testa-antecipacao.mjs` | O contrato da antecipação: `requested_amount` e `timeframe` já estavam certos; o caminho e dois campos fantasma estavam errados. A rota coletiva está atrás da **allowlist de IP** (401). |

## Auditoria do nosso código

| script | o que prova |
|---|---|
| `audita-classes-de-bug.mjs` | Varre as três classes de bug achadas em 15/10/2026: claim atômico decidido por `.length` num resultado de escrita, leitura de payload do provedor em forma aninhada, e chamada ao provedor cujo resultado ninguém inspeciona. Classifica o SQL para separar SELECT (onde `.length` está correto) de escrita com `RETURNING` (onde devolve `[linhas, contagem]`, comprimento 2 **sempre**). |
| `prova-cupom-maxuses.mjs` | O claim do cupom estava inerte: respondia "reservei" com o cupom esgotado. Só aparece em **concorrência** — no caso sequencial o pré-check não-atômico mascarava. |
| `audita-migration-codigos.mjs` | Confere a migration dos códigos contra a entidade e o banco, **lendo os textos**. Guarda no cabeçalho as três vezes em que esse método me enganou para o lado do "OK". Para prova de verdade, use o script abaixo. |
| `ensaia-migration-codigos.mjs` | **Roda** as migrations num banco descartável: clona o schema, reverte as 2 últimas pelo `down()`, reaplica pelo `up()`, e compara a assinatura das 63 colunas de `orders` entre o clone e o banco onde os testes passaram. Foi o que revelou que havia **duas** migrations pendentes, não uma. Não toca no `shopping_db`. |
| `medir-n1-createorder.mjs` | Mede o N+1 do `createOrder` contando SQL: 5 itens 20→1, 10 itens 40→1. |
| `testa-paginacao-estavel.mjs` | Exatidão da união de uma varredura completa — pega item perdido ou repetido entre páginas. |

## O que só aparece com o sistema RODANDO

Três bugs de 15/10/2026 passaram por typecheck, 118 testes unitários e quatro
suítes E2E, e mesmo assim estavam lá. Nenhuma ferramenta estática olha para o
que a aplicação faz enquanto roda — estes olham.

| script | o que pega |
|---|---|
| `audita-log-de-runtime.mjs` | Observa 130s de log (duas rodadas do scheduler) e reprova se houver `ERROR`. Achou o **auto-confirm morto**: `.andWhere('order."codigoVendedor" IS NULL')` com alias cru — `order` é palavra reservada — lançava a cada 60s, o `catch` engolia, e nenhum pedido era mais auto-confirmado. A lista de ruído benigno diz, item por item, **por que** é benigno; leia a entrada do WhatsApp, que não é benigna, é só inofensiva enquanto o WAHA está fora. |
| `valida-graphql-dos-apps.mjs` | Valida as **269 operações GraphQL** dos quatro front-ends contra o schema vivo. `tsc` passa com qualquer bobagem dentro de um `gql`, porque para ele aquilo é uma string: campo inexistente, argumento de tipo errado e mutation renomeada só quebram na tela, no celular. |
| `prova-aviso-de-bloqueio.mjs` | As 5 tentativas de código, uma por uma. Achou que o servidor dizia só "Código incorreto." e bloqueava por 15 min **sem nenhum aviso** — a pessoa estava na última chance e não sabia. Confere também que nenhuma mensagem revela o código certo. |

## Antes de subir para produção

| script | o que faz |
|---|---|
| `checa-prontidao-do-deploy.mjs` | **Somente leitura** — só executa SELECT, para poder ser apontado para produção com `DATABASE_URL=...`. Responde: quais migrations o deploy vai aplicar; se há dado duplicado que faria um `CREATE UNIQUE INDEX` **abortar o boot** (KAN-283 — migration que falha não deixa só de aplicar, derruba a subida da API); quais variáveis sensíveis estão definidas; e se o schema tem as colunas que o código exige. |
| `prova-do-checador-de-deploy.mjs` | Monta o cenário ruim num banco descartável e confere que o verificador acima **acusa** — um verificador que só sabe dizer "tudo bem" não serve. |

## Fluxo ponta a ponta

| script | o que cobre |
|---|---|
| `e2e-fluxo-compra.mjs` | O ciclo de compra inteiro, 25 asserções. Inclui estoque restaurado exatamente uma vez e webhook tardio não cancelando pedido pago. |
| `e2e-codigos-entrega.mjs` | A garantia de entrega por códigos, 33 asserções. **Prova o não-vazamento** por três caminhos: introspecção do tipo `Order`, tentativas cruzadas de leitura entre atores, e varredura da resposta completa do pedido procurando os 3 códigos. Mais ordenação forçada, bloqueio por excesso de tentativas, GPS gravado e a prova de recebimento. |
| `e2e-entrega-sem-codigo.mjs` | O desvio que libera dinheiro **sem** o código do cliente, 28 asserções. Achou que a janela de contestação era decorativa nas duas pontas: o cliente não era avisado **e** não conseguia contestar. Cobre os dois ramos da janela (contestado não libera; não contestado libera sem fabricar prova de recebimento) e a evidência que o superadmin lê para decidir. |
| `e2e-pedido-legado-sem-codigo.mjs` | O **pedido em trânsito no momento do deploy**: criado antes da migration, chega na porta do cliente sem código nenhum e só fecha pelos botões antigos. Cobre também a entrega rápida (confirmada na hora, sem esperar os 5 min do scheduler) e o auto-confirm de 10 min. |
| `testa-flag-cartao-entrega.mjs` | A flag `APP_DELIVERY_REQUIRES_CARD`. **Não defina em produção** — o padrão ligado é o estado seguro; o compose local põe `false` só para o E2E. |
| `testa-stores-f6.mjs` | Payload da listagem de lojas (18,7 → 8,7 KB). |

## Funcionalidades novas (16/10/2026)

| script | o que cobre |
|---|---|
| `prova-checkout-web-pagamento.mjs` | PIX e cartao no site (KAN-252), 35 asseroes. Inclui o anti-regressao do bug original (ON_DELIVERY cravado) e o **200 com cobranca FALHADA** do Pagar.me — o engano que fazia o cliente ver "pedido criado" numa tela sem nada para pagar. |
| `prova-sessao-do-site.mjs` | O token do cliente fora do JavaScript (KAN-248), 25 asseroes. Exige o **site rodando** (`npx next dev -p 3005` no shopping-storefront); sem ele a etapa e PULADA, nao falha. |
| `prova-frete-mostrado-x-cobrado.mjs` | O frete que a tela mostra e o que o pedido cobra sao o MESMO numero (KAN-29). Duas copias de uma conta de dinheiro divergem na primeira vez que alguem mexe numa. |
| `prova-painel-financeiro.mjs` | A aritmetica do painel do dinheiro (KAN-102), 17 asseroes, com a invariante `volume = parte das lojas + comissao + frete da plataforma`. Confere tambem que lojista e cliente **nao** acessam o painel. |
| `prova-cliente-fiel.mjs` | O programa de fidelidade (KAN-12), 20 asseroes: 10 compras de verdade ponta a ponta, o premio que **nao vaza** para quem nao comprou, pedido cancelado que nao conta e premio que nao duplica. |
| `prova-contas-de-equipe.mjs` | Contas de equipe do lojista (KAN-82), 20 asseroes. A primeira coisa que ela verifica e que um lojista **qualquer** continua sem acesso a loja alheia — a mudanca tocou 31 checagens de dono, e afrouxar uma seria pior que o problema original. |
| `prova-visual-da-loja.mjs` | A loja pinta a propria vitrine (KAN-13), 23 asseroes: a cor chega ao cliente, vitrine ilegivel e recusada, da para voltar ao padrao, e o app realmente aplica o que foi escolhido. |
| `prova-agente-n8n.mjs` | O assistente de WhatsApp (KAN-199), 21 asseroes. Inclui a checagem que faltava: **toda ferramenta do agente aponta para uma rota que o controller expoe** — JSON versionado diverge do backend em silencio. |
| `prova-busca-promocao-no-app.mjs` | A promocao casada aparece na busca (KAN-297), 17 asseroes, conferindo **campo por campo** que a query entrega o que a tela le. |
| `ensaia-baseline-do-schema.mjs` | Banco VAZIO + `migration:run` = o schema de producao (KAN-283), 20 asseroes e 430 colunas conferidas contra o que as entidades produzem. Mais a deduplicacao de cupom, que evitava o boot abortar. |
