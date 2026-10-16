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

## Fluxo ponta a ponta

| script | o que cobre |
|---|---|
| `e2e-fluxo-compra.mjs` | O ciclo de compra inteiro, 25 asserções. Inclui estoque restaurado exatamente uma vez e webhook tardio não cancelando pedido pago. |
| `e2e-codigos-entrega.mjs` | A garantia de entrega por códigos, 33 asserções. **Prova o não-vazamento** por três caminhos: introspecção do tipo `Order`, tentativas cruzadas de leitura entre atores, e varredura da resposta completa do pedido procurando os 3 códigos. Mais ordenação forçada, bloqueio por excesso de tentativas, GPS gravado e a prova de recebimento. |
| `testa-flag-cartao-entrega.mjs` | A flag `APP_DELIVERY_REQUIRES_CARD`. **Não defina em produção** — o padrão ligado é o estado seguro; o compose local põe `false` só para o E2E. |
| `testa-stores-f6.mjs` | Payload da listagem de lojas (18,7 → 8,7 KB). |
