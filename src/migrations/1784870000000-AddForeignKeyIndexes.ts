import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * KAN-261: indices nas chaves estrangeiras.
 *
 * No Postgres, criar uma FK NAO cria indice na coluna (diferente do MySQL).
 * Havia 34 FKs sem indice, incluindo `orders.storeId` e `orders.customerId`
 * — ou seja, listar os pedidos de uma loja fazia varredura sequencial na
 * tabela inteira de pedidos. Com poucos registros ninguem percebe; conforme a
 * base cresce, essas telas degradam de forma nao-linear.
 *
 * Os nomes sao exatamente os que o TypeORM gera a partir dos `@Index()` nas
 * entities, para que producao fique identica ao banco de desenvolvimento.
 *
 * `IF NOT EXISTS` deixa a migration idempotente: rodar num banco que ja tenha
 * os indices (dev, onde o synchronize ja criou) nao quebra.
 */
export class AddForeignKeyIndexes1784870000000 implements MigrationInterface {
  name = 'AddForeignKeyIndexes1784870000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_95c93a584de49f0b0e13f75363" ON "addresses" ("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_60dbcf20669c096d319e20fca8" ON "appointments" ("customerId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_be987791dec56a5566fcfd4eb4" ON "appointments" ("storeId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_f77953c373efb8ab146d98e90c" ON "appointments" ("serviceId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_25c49e1f4630d8b791a120cdc3" ON "cart_items" ("storeId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_72679d98b31c737937b8932ebe" ON "cart_items" ("productId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_e13650ee5441f2738a7ebeea82" ON "cart_items" ("customerId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_fa6ba3528de12e174b163c09fd" ON "categories" ("storeId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_1759bf86967840352d952797ed" ON "coupons" ("storeId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_5e2c4897f6f6fe0eddb9bdbada" ON "deliveries" ("delivererId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_cdb99c05982d5191ac8465ac01" ON "order_items" ("productId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_f1d359a55923bb45b057fbdab0" ON "order_items" ("orderId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_e6d7211687e7d0611124664e6d" ON "order_status_logs" ("orderId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_0f82354e5b05fd87884eff3a7b" ON "orders" ("storeId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_c26db6c65929ecfeab91073e80" ON "orders" ("couponId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_e5de51ca888d8b1f5ac25799dd" ON "orders" ("customerId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_058e5febfa582f85aca260b95a" ON "payments" ("appUserId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_78e5920fb35c3aac7c36679f1b" ON "payments" ("vendorUserId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_782da5e50e94b763eb63225d69" ON "products" ("storeId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ff56834e735fa78a15d0cf2192" ON "products" ("categoryId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_32bb72bb5f508d4aa02f215a58" ON "promotions" ("storeId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_c8147b5d9ff0dfa7e37be56c1b" ON "promotions" ("productId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_e66cfc6746ba4ab45a9fb6458c" ON "saved_cards" ("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_8ba0dbc7ec71486e5491bff6b1" ON "schedules" ("storeId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_58849e8c0ea7fd3f8892836c1d" ON "service_ratings" ("serviceId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ade087917eb023bc4516a1db7d" ON "service_ratings" ("customerId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ed55e888ef6797bbfc3bd6e396" ON "service_ratings" ("storeId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_f6b2587f79f584a1c163b6dccf" ON "service_ratings" ("appointmentId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_034b52310c2d211bc979c3cc4e" ON "services" ("categoryId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ee1c9f2a1a11b2ca0c9a24c297" ON "services" ("storeId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_f0efa141f718dec773bf42687f" ON "store_follows" ("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_fa87e4569e2cd489d5cd57d9ab" ON "store_follows" ("storeId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_a447ba082271c05997a61df26d" ON "stores" ("ownerId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_b5a470e3f438c1ebcb1bf15a78" ON "subscriptions" ("vendorUserId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_b5a470e3f438c1ebcb1bf15a78"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_a447ba082271c05997a61df26d"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_fa87e4569e2cd489d5cd57d9ab"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_f0efa141f718dec773bf42687f"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ee1c9f2a1a11b2ca0c9a24c297"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_034b52310c2d211bc979c3cc4e"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_f6b2587f79f584a1c163b6dccf"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ed55e888ef6797bbfc3bd6e396"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ade087917eb023bc4516a1db7d"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_58849e8c0ea7fd3f8892836c1d"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_8ba0dbc7ec71486e5491bff6b1"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_e66cfc6746ba4ab45a9fb6458c"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_c8147b5d9ff0dfa7e37be56c1b"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_32bb72bb5f508d4aa02f215a58"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ff56834e735fa78a15d0cf2192"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_782da5e50e94b763eb63225d69"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_78e5920fb35c3aac7c36679f1b"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_058e5febfa582f85aca260b95a"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_e5de51ca888d8b1f5ac25799dd"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_c26db6c65929ecfeab91073e80"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_0f82354e5b05fd87884eff3a7b"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_e6d7211687e7d0611124664e6d"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_f1d359a55923bb45b057fbdab0"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_cdb99c05982d5191ac8465ac01"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_5e2c4897f6f6fe0eddb9bdbada"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_1759bf86967840352d952797ed"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_fa6ba3528de12e174b163c09fd"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_e13650ee5441f2738a7ebeea82"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_72679d98b31c737937b8932ebe"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_25c49e1f4630d8b791a120cdc3"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_f77953c373efb8ab146d98e90c"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_be987791dec56a5566fcfd4eb4"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_60dbcf20669c096d319e20fca8"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_95c93a584de49f0b0e13f75363"`);
  }
}
