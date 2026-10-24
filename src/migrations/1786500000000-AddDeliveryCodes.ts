import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Garantia de entrega por CÓDIGOS, substituindo os botões de confirmação.
 *
 * Por que a mudança: um botão prova apenas que alguém logado naquela conta
 * tocou na tela. Isso é fraco como prova — e o auto-confirm por GPS que existia
 * como saída era pior: a auditoria encontrou GPS forjado disparando
 * `completeOrderWithPayment`, ou seja, liberando repasse de pedido nunca
 * entregue. Um código, ao contrário, só chega às mãos de quem esteve
 * fisicamente na frente da outra pessoa.
 *
 * São três, um por parte, e o pickup é uma troca MÚTUA:
 *
 *   - `codigoVendedor`   — fica visível só para o LOJISTA; o ENTREGADOR digita
 *                          na coleta. Prova que ele esteve na loja.
 *   - `codigoEntregador` — fica visível só para o ENTREGADOR; o LOJISTA digita
 *                          na coleta. Prova que a loja entregou o pedido à
 *                          pessoa certa (fecha o golpe do falso entregador).
 *   - `codigoCliente`    — fica visível só para o CLIENTE; o ENTREGADOR digita
 *                          na porta. Prova a entrega, e é o que LIBERA o
 *                          dinheiro.
 *
 * A ordem é obrigatória: o código do cliente só é aceito depois do par da
 * coleta. Não existe entregar antes de coletar.
 *
 * Só pedidos com ENTREGA POR ENTREGADOR DO APP recebem códigos. Retirada e
 * frota própria não têm entregador do app e seguem o fluxo antigo; a presença
 * dos códigos é o que chaveia um fluxo ou outro, então pedido em andamento na
 * hora do deploy não quebra.
 *
 * As colunas de latitude/longitude guardam onde o entregador estava no instante
 * de cada registro. Não é vigilância: é a evidência que sustenta a contestação
 * de chargeback (ver KAN-303, onde a recuperação de repasse é impossível e a
 * defesa é justamente a prova de entrega).
 */
export class AddDeliveryCodes1786500000000 implements MigrationInterface {
  name = 'AddDeliveryCodes1786500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── os três códigos ──────────────────────────────────────────────────
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "codigoVendedor" VARCHAR(6)`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "codigoEntregador" VARCHAR(6)`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "codigoCliente" VARCHAR(6)`,
    );

    // ── quando cada um foi registrado (e por consequência, por quem) ─────
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "codigoVendedorUsadoEm" TIMESTAMP`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "codigoEntregadorUsadoEm" TIMESTAMP`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "codigoClienteUsadoEm" TIMESTAMP`,
    );

    // ── evidência: onde o entregador estava em cada registro ─────────────
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "codigoVendedorLat" NUMERIC(10,7)`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "codigoVendedorLng" NUMERIC(10,7)`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "codigoClienteLat" NUMERIC(10,7)`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "codigoClienteLng" NUMERIC(10,7)`,
    );

    // ── anti-força-bruta ────────────────────────────────────────────────
    // 6 dígitos são 1 milhão de combinações; com tentativa ilimitada o
    // entregador poderia adivinhar o código do cliente, porque ele conhece o
    // pedido. O contador é POR PEDIDO, compartilhado pelas três entradas: é
    // mais simples e, como as três acontecem no mesmo pedido, um excesso de
    // tentativas é sinal de problema NAQUELE pedido, qualquer que seja o ator.
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "codigoTentativas" INTEGER NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "codigoBloqueadoAte" TIMESTAMP`,
    );

    // Registro de entrega SEM o código do cliente (cliente ausente, dormindo,
    // ou que se recusa a informar). Abre janela de contestação em vez de travar
    // o pagamento do entregador na boa vontade do cliente — ver a saída de
    // disputa no serviço de códigos.
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "entregaSemCodigoEm" TIMESTAMP`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "entregaSemCodigoMotivo" VARCHAR(300)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const coluna of [
      'entregaSemCodigoMotivo',
      'entregaSemCodigoEm',
      'codigoBloqueadoAte',
      'codigoTentativas',
      'codigoClienteLng',
      'codigoClienteLat',
      'codigoVendedorLng',
      'codigoVendedorLat',
      'codigoClienteUsadoEm',
      'codigoEntregadorUsadoEm',
      'codigoVendedorUsadoEm',
      'codigoCliente',
      'codigoEntregador',
      'codigoVendedor',
    ]) {
      await queryRunner.query(
        `ALTER TABLE "orders" DROP COLUMN IF EXISTS "${coluna}"`,
      );
    }
  }
}
