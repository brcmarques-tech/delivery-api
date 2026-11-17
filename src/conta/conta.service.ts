import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { peppered } from '../common/utils/pepper';
import { PaymentsService } from '../payments/payments.service';

/** Pedidos que ainda estão em andamento (não dá para excluir a conta no meio deles). */
const PEDIDO_EM_ANDAMENTO = [
  'AWAITING_PAYMENT', 'PAYMENT_REVIEW', 'PENDING', 'ACCEPTED', 'PREPARING', 'READY',
  'VENDOR_CONFIRMED_PICKUP', 'PICKED_UP', 'DELIVERING', 'DELIVERER_CONFIRMED_DELIVERY', 'DISPUTED',
];
const AGENDAMENTO_EM_ANDAMENTO = ['PENDING', 'CONFIRMED', 'QUOTE_REQUESTED', 'QUOTED', 'QUOTE_ACCEPTED'];

/**
 * KAN-326 / LGPD: exclusão de conta pelo próprio titular (cliente ou entregador).
 *
 * Nada de negócio é apagado: pedidos, agendamentos e valores continuam no
 * histórico (obrigação fiscal e da loja). O que é DADO PESSOAL é anonimizado —
 * nome, e-mail, telefone, CPF, documentos, fotos, chave PIX, endereços e o
 * endereço/observação dos pedidos — e a conta fica desativada para sempre.
 * A Google Play também exige que o app ofereça a exclusão da conta.
 */
@Injectable()
export class ContaService {
  private readonly logger = new Logger(ContaService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly paymentsService: PaymentsService,
  ) {}

  /** O que impede a exclusão agora (lista vazia = pode excluir). */
  async impedimentos(userId: string): Promise<string[]> {
    const motivos: string[] = [];
    const [pedidos] = await this.dataSource.query(
      `SELECT count(*)::int AS n FROM orders WHERE "customerId" = $1 AND status = ANY($2)`,
      [userId, PEDIDO_EM_ANDAMENTO],
    );
    if (pedidos.n > 0) motivos.push('Você tem pedido em andamento. Espere ele ser concluído ou cancelado.');

    const [entregas] = await this.dataSource.query(
      `SELECT count(*)::int AS n FROM orders o JOIN deliveries d ON d."orderId" = o.id
        WHERE d."delivererId" = $1 AND o.status = ANY($2)`,
      [userId, PEDIDO_EM_ANDAMENTO],
    );
    if (entregas.n > 0) motivos.push('Você tem entrega em andamento. Conclua a entrega antes.');

    const [agendamentos] = await this.dataSource.query(
      `SELECT count(*)::int AS n FROM appointments
        WHERE "customerId" = $1 AND status = ANY($2) AND "deletedAt" IS NULL`,
      [userId, AGENDAMENTO_EM_ANDAMENTO],
    );
    if (agendamentos.n > 0) motivos.push('Você tem agendamento em aberto. Cancele ou espere ele ser concluído.');

    // Frete a receber no pagamento de quarta: excluir agora perderia a chave PIX.
    const [aReceber] = await this.dataSource.query(
      `SELECT COALESCE(sum(o."delivererPayableCents"), 0)::int AS cents
         FROM orders o JOIN deliveries d ON d."orderId" = o.id
        WHERE d."delivererId" = $1 AND o."delivererPayableCents" > 0 AND o."delivererPayablePaidAt" IS NULL`,
      [userId],
    );
    if (aReceber.cents > 0) {
      const reais = (aReceber.cents / 100).toFixed(2).replace('.', ',');
      motivos.push(`Você ainda tem R$ ${reais} de entregas para receber na quarta. Exclua a conta depois do pagamento.`);
    }
    return motivos;
  }

  /**
   * Exclui a conta do titular. Conta com senha: confirma a senha. Conta criada
   * pelo Google (sem senha conhecida): confirma digitando EXCLUIR.
   */
  async excluirMinhaConta(userId: string, senha?: string, confirmacao?: string): Promise<boolean> {
    const [user] = await this.dataSource.query(
      `SELECT id, role, password, "googleId", "isActive", "contaExcluidaEm" FROM app_users WHERE id = $1`,
      [userId],
    );
    if (!user || user.contaExcluidaEm) throw new NotFoundException('Conta nao encontrada');

    if (user.googleId && !senha) {
      if ((confirmacao || '').trim().toUpperCase() !== 'EXCLUIR') {
        throw new BadRequestException('Digite EXCLUIR para confirmar.');
      }
    } else if (!senha || !(await bcrypt.compare(peppered(senha), user.password))) {
      throw new BadRequestException('Senha incorreta.');
    }

    const motivos = await this.impedimentos(userId);
    if (motivos.length) throw new BadRequestException(motivos.join(' '));

    // Cartões salvos: remove no Pagar.me (melhor esforço) e marca como excluído aqui.
    const cartoes: { id: string }[] = await this.dataSource.query(
      `SELECT id FROM saved_cards WHERE "userId" = $1 AND "deletedAt" IS NULL`,
      [userId],
    );
    for (const c of cartoes) {
      try {
        await this.paymentsService.deleteCard(userId, c.id);
      } catch (err: any) {
        this.logger.warn(`[CONTA] cartao ${c.id} nao removido: ${err?.message}`);
      }
    }

    const removido = user.role === 'DELIVERER' ? 'Entregador removido' : 'Cliente removido';
    const aleatorio = () => crypto.randomBytes(32).toString('hex');
    const enderecoRemovido = 'Endereço removido a pedido do titular';

    await this.dataSource.transaction(async (m) => {
      await m.query(
        `UPDATE app_users SET
            name = $2, email = $3, password = $4, phone = '', cpf = NULL, "googleId" = NULL,
            "avatarUrl" = NULL, "profilePhotoUrl" = NULL, "identityPhotoUrl" = NULL, "identityPhotoBackUrl" = NULL,
            "birthDate" = NULL, "cnhNumber" = NULL, "vehiclePlate" = NULL, "chavePix" = NULL,
            "expoPushToken" = NULL, "notificationEmail" = NULL,
            "resetPasswordToken" = NULL, "resetPasswordExpires" = NULL,
            "isActive" = false,
            "sessionToken" = $5, "sessionActive" = false, "webSessionToken" = $6, "webSessionActive" = false,
            "contaExcluidaEm" = now()
          WHERE id = $1`,
        [userId, removido, `removido-${userId}@conta-excluida.invalid`, await bcrypt.hash(aleatorio(), 10), aleatorio(), aleatorio()],
      );
      await m.query(
        `UPDATE addresses SET street = $2, number = '', complement = NULL, neighborhood = '', "zipCode" = '',
                latitude = 0, longitude = 0, "deletedAt" = COALESCE("deletedAt", now())
          WHERE "userId" = $1`,
        [userId, enderecoRemovido],
      );
      await m.query(
        `UPDATE orders SET "deliveryAddress" = CASE WHEN "deliveryAddress" IS NULL THEN NULL ELSE $2 END,
                "deliveryLatitude" = NULL, "deliveryLongitude" = NULL, notes = NULL,
                "codigoClienteLat" = NULL, "codigoClienteLng" = NULL
          WHERE "customerId" = $1`,
        [userId, enderecoRemovido],
      );
      await m.query(
        `UPDATE appointments SET address = CASE WHEN address IS NULL THEN NULL ELSE $2 END,
                latitude = NULL, longitude = NULL, notes = NULL
          WHERE "customerId" = $1`,
        [userId, enderecoRemovido],
      );
      await m.query(`DELETE FROM cart_items WHERE "customerId" = $1`, [userId]);
      await m.query(`DELETE FROM store_follows WHERE "userId" = $1`, [userId]);
    });
    this.logger.log(`[CONTA] conta ${userId} excluida e anonimizada a pedido do titular`);
    return true;
  }
}
