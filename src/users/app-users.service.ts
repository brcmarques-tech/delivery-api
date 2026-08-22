import { Injectable, ConflictException, NotFoundException, BadRequestException, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { AppUser } from './entities/app-user.entity';
import { ApprovalLog } from './entities/approval-log.entity';
import { RegisterAppInput } from '../auth/dto/register-app.input';
import { RegisterDelivererInput } from './dto/register-deliverer.input';
import { UserRole } from '../common/enums';
import { MailService } from '../mail/mail.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { peppered } from '../common/utils/pepper';

import { isValidCpf } from '../common/utils/cpf'; // KAN-253
import { resolvePublicUrl } from '../common/utils/public-url';
@Injectable()
export class AppUsersService {
  constructor(
    @InjectRepository(AppUser)
    private appUsersRepository: Repository<AppUser>,
    @InjectRepository(ApprovalLog)
    private approvalLogRepository: Repository<ApprovalLog>,
    private mailService: MailService,
    private configService: ConfigService,
    private whatsAppService: WhatsAppService,
  ) {}


  async validateRegistration(email: string, cpf: string, phone: string): Promise<{ valid: boolean; emailError?: string; cpfError?: string; phoneError?: string }> {
    const result: { valid: boolean; emailError?: string; cpfError?: string; phoneError?: string } = { valid: true };

    if (cpf) {
      if (!isValidCpf(cpf)) {
        result.cpfError = 'CPF invalido';
        result.valid = false;
      } else {
        const cpfExists = await this.appUsersRepository.findOne({ where: { cpf } });
        if (cpfExists) {
          result.cpfError = 'CPF ja cadastrado';
          result.valid = false;
        }
      }
    }

    const emailExists = await this.appUsersRepository.findOne({ where: { email } });
    if (emailExists) {
      result.emailError = 'Email ja cadastrado';
      result.valid = false;
    }

    if (phone) {
      const phoneDigits = phone.replace(/\D/g, '');
      const phoneExists = await this.appUsersRepository.findOne({ where: { phone: phoneDigits } });
      if (phoneExists) {
        result.phoneError = 'Telefone ja cadastrado';
        result.valid = false;
      }
    }

    return result;
  }

  /**
   * KAN-231: `phoneVerified` deixou de ser um literal `true`.
   *
   * Antes, todo cadastro nascia com o telefone marcado como verificado,
   * independentemente de o OTP ter sido feito ou nao — o campo mentia. Agora
   * quem chama informa se houve verificacao de fato (o AuthService consome a
   * prova deixada pelo OtpService). O default `false` e o honesto: sem prova,
   * nao esta verificado.
   */
  async create(input: RegisterAppInput, phoneVerified = false): Promise<AppUser> {
    if (input.cpf) {
      if (!isValidCpf(input.cpf)) {
        throw new BadRequestException('CPF invalido');
      }
    }

    const exists = await this.appUsersRepository.findOne({
      where: { email: input.email },
    });
    if (exists) {
      throw new ConflictException('Email ja cadastrado');
    }

    if (input.cpf) {
      // NORMALIZA antes de checar E de gravar. isValidCpf ja limpava a mascara
      // so para validar, mas a busca e o save usavam a string crua: A registra
      // "11144477735", B registra "111.444.777-35" e o findOne nao casa — dois
      // usuarios com o mesmo CPF. Downstream, findByCpfWithRecipient busca pelo
      // CPF LIMPO, nunca acha quem gravou com mascara, e a plataforma criava um
      // SEGUNDO recipient Pagar.me para o mesmo CPF (fura o anti-fraude de "um
      // CPF, uma conta de recebimento"). O indice unico parcial no banco fecha
      // tambem a corrida TOCTOU de dois cadastros simultaneos.
      input.cpf = input.cpf.replace(/\D/g, '');
      const cpfExists = await this.appUsersRepository.findOne({
        where: { cpf: input.cpf },
      });
      if (cpfExists) {
        throw new ConflictException('CPF ja cadastrado');
      }
    }

    const hashedPassword = await bcrypt.hash(peppered(input.password), 10);

    const user = this.appUsersRepository.create({
      ...input,
      password: hashedPassword,
      role: UserRole.CUSTOMER,
      phoneVerified,
      acceptedTermsAt: new Date(),
    });
    return this.appUsersRepository.save(user);
  }

  async findByEmail(email: string): Promise<AppUser | null> {
    return this.appUsersRepository.findOne({ where: { email } });
  }

  async findByCpfWithRecipient(cpf: string): Promise<AppUser | null> {
    return this.appUsersRepository
      .createQueryBuilder('u')
      .where('u.cpf = :cpf', { cpf })
      .andWhere('u.pagarmeRecipientId IS NOT NULL')
      .getOne();
  }

  async findById(id: string): Promise<AppUser | null> {
    return this.appUsersRepository.findOne({
      where: { id },
      relations: ['addresses'],
    });
  }

  async findAll(): Promise<AppUser[]> {
    return this.appUsersRepository.find({
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Confirma no banco que o token de SUPERADMIN ainda vale: conta existe, e
   * SUPERADMIN, esta ativa e (se informado) o sessionToken bate. Usado pelo gate
   * de PII para nao confiar no `role` congelado do JWT (mesmo padrao do
   * RatingsService.isActiveSuperadmin).
   */
  async isActiveSuperadmin(userId: string, sessionToken?: string): Promise<boolean> {
    const user = await this.appUsersRepository.findOne({ where: { id: userId } });
    if (!user || user.role !== UserRole.SUPERADMIN) return false;
    if (user.isActive === false) return false;
    if (user.sessionToken && sessionToken !== user.sessionToken) return false;
    return true;
  }

  /**
   * KAN-245: historico de aprovacoes/rejeicoes paginado NO SERVIDOR.
   *
   * Une app_users + vendor_users (UNION ALL) para preservar a ordenacao global
   * por data entre as duas fontes, filtra pelo status (approvedAt/rejectedAt),
   * aplica busca por nome/email sem acento e devolve so a pagina pedida.
   * Antes o painel baixava as duas tabelas inteiras (com fotos) e filtrava em
   * memoria — custo linear no total de usuarios a cada abertura da aba.
   */
  async findApprovalUsers(
    status: 'approved' | 'rejected',
    search: string | null,
    limit: number,
    offset: number,
  ): Promise<{ items: any[]; total: number; hasMore: boolean }> {
    // Whitelist: a coluna vai interpolada na SQL, entao NUNCA pode vir do input
    // sem passar por aqui (o resto e parametrizado).
    const statusCol = status === 'rejected' ? 'rejectedAt' : 'approvedAt';
    const take = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const skip = Math.max(Number(offset) || 0, 0);
    const like = search && search.trim() ? `%${search.trim()}%` : null;

    const searchClause = like
      ? ' AND (unaccent(lower(name)) LIKE unaccent(lower($1)) OR unaccent(lower(email)) LIKE unaccent(lower($1)))'
      : '';

    const combined = `
      SELECT id, name, email, phone, role::text AS role, "pendingRole",
             cpf, "vehicleType", "vehiclePlate",
             "profilePhotoUrl", "identityPhotoUrl", "identityPhotoBackUrl",
             "approvedAt", "rejectedAt", "rejectionReason", "createdAt",
             'app'::text AS source
      FROM app_users
      UNION ALL
      SELECT id, name, email, phone, role::text AS role, "pendingRole",
             cpf, NULL::varchar AS "vehicleType", NULL::varchar AS "vehiclePlate",
             NULL::varchar AS "profilePhotoUrl", NULL::varchar AS "identityPhotoUrl",
             NULL::varchar AS "identityPhotoBackUrl",
             "approvedAt", "rejectedAt", "rejectionReason", "createdAt",
             'vendor'::text AS source
      FROM vendor_users
    `;

    const countSql =
      `WITH combined AS (${combined}) ` +
      `SELECT COUNT(*)::int AS total FROM combined ` +
      `WHERE "${statusCol}" IS NOT NULL${searchClause}`;
    const countParams = like ? [like] : [];
    const countRes = await this.appUsersRepository.manager.query(countSql, countParams);
    const total = countRes[0]?.total ?? 0;

    const limIdx = like ? 2 : 1;
    const offIdx = like ? 3 : 2;
    const dataSql =
      `WITH combined AS (${combined}) ` +
      `SELECT * FROM combined ` +
      `WHERE "${statusCol}" IS NOT NULL${searchClause} ` +
      `ORDER BY "${statusCol}" DESC NULLS LAST ` +
      `LIMIT $${limIdx} OFFSET $${offIdx}`;
    const dataParams = like ? [like, take, skip] : [take, skip];
    const items = await this.appUsersRepository.manager.query(dataSql, dataParams);

    return { items, total, hasMore: skip + items.length < total };
  }

  /** KAN-245: contagens leves (so COUNT) para os badges das abas. */
  async approvalCounts(): Promise<{ approved: number; rejected: number }> {
    const combined = `
      SELECT "approvedAt", "rejectedAt" FROM app_users
      UNION ALL
      SELECT "approvedAt", "rejectedAt" FROM vendor_users
    `;
    const res = await this.appUsersRepository.manager.query(
      `WITH combined AS (${combined}) SELECT ` +
        `COUNT(*) FILTER (WHERE "approvedAt" IS NOT NULL)::int AS approved, ` +
        `COUNT(*) FILTER (WHERE "rejectedAt" IS NOT NULL)::int AS rejected ` +
        `FROM combined`,
    );
    return { approved: res[0]?.approved ?? 0, rejected: res[0]?.rejected ?? 0 };
  }

  // KAN-292: usuarios do app por papel, paginado + busca (painel de Usuarios).
  // Substitui o allAppUsers (base inteira) filtrado por papel no cliente.
  async findByRolePaginated(
    role: UserRole,
    search: string | null,
    limit: number,
    offset: number,
  ): Promise<{ items: AppUser[]; total: number; hasMore: boolean }> {
    const take = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const skip = Math.max(Number(offset) || 0, 0);
    const qb = this.appUsersRepository
      .createQueryBuilder('u')
      .where('u.role = :role', { role })
      .orderBy('u.createdAt', 'DESC')
      .addOrderBy('u.id', 'DESC');
    if (search && search.trim()) {
      const like = `%${search.trim()}%`;
      qb.andWhere(
        '(u.name ILIKE :like OR u.email ILIKE :like OR u.phone ILIKE :like)',
        { like },
      );
    }
    const [items, total] = await qb.skip(skip).take(take).getManyAndCount();
    return { items, total, hasMore: skip + items.length < total };
  }

  // KAN-292: contagens por papel para os badges das abas (app_users).
  async roleCounts(): Promise<{ customers: number; deliverers: number; admins: number }> {
    const res = await this.appUsersRepository
      .createQueryBuilder('u')
      .select("COUNT(*) FILTER (WHERE u.role = 'CUSTOMER')", 'customers')
      .addSelect("COUNT(*) FILTER (WHERE u.role = 'DELIVERER')", 'deliverers')
      .addSelect("COUNT(*) FILTER (WHERE u.role = 'SUPERADMIN')", 'admins')
      .getRawOne();
    return {
      customers: Number(res?.customers ?? 0),
      deliverers: Number(res?.deliverers ?? 0),
      admins: Number(res?.admins ?? 0),
    };
  }

  async findAllDeliverers(): Promise<AppUser[]> {
    return this.appUsersRepository.find({
      where: { isDeliverer: true },
    });
  }

  async findPendingApprovals(): Promise<AppUser[]> {
    return this.appUsersRepository
      .createQueryBuilder('user')
      .where('user.pendingRole = :role', { role: 'DELIVERER' })
      .orWhere('user.role = :delivererRole AND user.approvedAt IS NULL', {
        delivererRole: UserRole.DELIVERER,
      })
      .orderBy('user.createdAt', 'ASC')
      .getMany();
  }

  async approveUser(id: string): Promise<AppUser> {
    const user = await this.appUsersRepository.findOne({ where: { id } });
    if (!user) throw new NotFoundException('Usuario nao encontrado');

    if (!user.pendingRole && user.approvedAt) {
      throw new BadRequestException('Usuario ja foi aprovado');
    }

    // KYC (3.8): defesa em profundidade — candidaturas antigas criadas antes da
    // validacao do registerAsDeliverer podem existir sem documento. Aprovar
    // entregador sem as 3 fotos nao pode ser possivel nem por engano.
    const viraEntregador = user.pendingRole === 'DELIVERER' || user.role === UserRole.DELIVERER;
    if (viraEntregador) {
      const faltando: string[] = [];
      if (!user.profilePhotoUrl?.trim()) faltando.push('foto do rosto');
      if (!user.identityPhotoUrl?.trim()) faltando.push('documento (frente)');
      if (!user.identityPhotoBackUrl?.trim()) faltando.push('documento (verso)');
      if (faltando.length > 0) {
        throw new BadRequestException(
          `Cadastro sem documentos obrigatorios (${faltando.join(', ')}). ` +
            'Rejeite a candidatura para que o entregador reenvie com os documentos.',
        );
      }
    }

    if (user.pendingRole === 'DELIVERER') {
      user.role = UserRole.DELIVERER;
      user.isDeliverer = true;
    }

    const approvedRole = user.pendingRole || user.role;
    user.approvedAt = new Date();
    user.pendingRole = null;
    user.rejectedAt = null;
    user.rejectionReason = null;
    const saved = await this.appUsersRepository.save(user);

    await this.approvalLogRepository.save({
      userId: user.id,
      userName: user.name,
      userEmail: user.email,
      userType: 'app',
      action: 'APPROVED',
      role: approvedRole,
      reason: null,
      profilePhotoUrl: user.profilePhotoUrl || null,
      identityPhotoUrl: user.identityPhotoUrl || null,
      identityPhotoBackUrl: user.identityPhotoBackUrl || null,
    });

    this.mailService.sendApprovalEmail(user.email, user.name, approvedRole);
    if (user.phone) {
      this.whatsAppService.notifyUserApproved(user.phone, user.name, approvedRole).catch(() => {});
    }
    return saved;
  }

  async rejectUser(id: string, reason: string): Promise<AppUser> {
    const user = await this.appUsersRepository.findOne({ where: { id } });
    if (!user) throw new NotFoundException('Usuario nao encontrado');

    const rejectedRole = user.pendingRole || user.role;

    if (!user.pendingRole && user.role === UserRole.DELIVERER) {
      user.role = UserRole.CUSTOMER;
      user.isDeliverer = false;
    }

    user.rejectedAt = new Date();
    user.rejectionReason = reason;
    user.pendingRole = null;
    const saved = await this.appUsersRepository.save(user);

    await this.approvalLogRepository.save({
      userId: user.id,
      userName: user.name,
      userEmail: user.email,
      userType: 'app',
      action: 'REJECTED',
      role: rejectedRole,
      reason,
      profilePhotoUrl: user.profilePhotoUrl || null,
      identityPhotoUrl: user.identityPhotoUrl || null,
      identityPhotoBackUrl: user.identityPhotoBackUrl || null,
    });

    this.mailService.sendRejectionEmail(user.email, user.name, rejectedRole, reason);
    if (user.phone) {
      this.whatsAppService.notifyUserRejected(user.phone, user.name, rejectedRole, reason).catch(() => {});
    }
    return saved;
  }

  async getApprovalLogs(): Promise<ApprovalLog[]> {
    return this.approvalLogRepository.find({ order: { createdAt: 'DESC' } });
  }

  async updateUserRole(id: string, role: UserRole): Promise<AppUser> {
    const user = await this.appUsersRepository.findOne({ where: { id } });
    if (!user) throw new NotFoundException('Usuario nao encontrado');
    user.role = role;
    user.isDeliverer = role === UserRole.DELIVERER;
    return this.appUsersRepository.save(user);
  }

  async toggleUserActive(id: string): Promise<AppUser> {
    const user = await this.appUsersRepository.findOne({ where: { id } });
    if (!user) throw new NotFoundException('Usuario nao encontrado');

    // ULTIMO SUPERADMIN: desativar rotaciona o sessionToken e derruba a sessao
    // NA HORA — se ele for o unico ativo, ninguem mais entra no painel para
    // reativar e a recuperacao vira UPDATE manual no banco. Um clique errado na
    // propria linha travava a administracao da plataforma inteira.
    if (user.isActive && user.role === UserRole.SUPERADMIN) {
      const outrosAtivos = await this.appUsersRepository.count({
        where: { role: UserRole.SUPERADMIN, isActive: true, id: Not(id) },
      });
      if (outrosAtivos === 0) {
        throw new BadRequestException(
          'Este e o ultimo superadmin ativo — desativa-lo deixaria a plataforma sem administracao. Ative outro superadmin antes.',
        );
      }
    }

    user.isActive = !user.isActive;
    // SEGURANCA: ao DESATIVAR, rotaciona o sessionToken para derrubar na hora
    // qualquer sessao ja aberta (o jwt.strategy compara o token da sessao).
    // Sem isto o banido continuava usando o app ate o JWT expirar.
    if (!user.isActive) {
      user.sessionToken = crypto.randomBytes(32).toString('hex');
      user.sessionActive = false; // KAN-280
    }
    return this.appUsersRepository.save(user);
  }

  async countByRole(): Promise<{ role: string; count: number }[]> {
    return this.appUsersRepository
      .createQueryBuilder('user')
      .select('user.role', 'role')
      .addSelect('COUNT(*)', 'count')
      .groupBy('user.role')
      .getRawMany();
  }

  async registerAsDeliverer(userId: string, input: RegisterDelivererInput): Promise<AppUser> {
    const user = await this.appUsersRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('Usuario nao encontrado');
    if (user.isDeliverer) throw new BadRequestException('Usuario ja e entregador');
    if (user.pendingRole === 'DELIVERER') throw new BadRequestException('Cadastro ja enviado, aguarde aprovacao');

    // KYC (3.8): o app exige as 3 fotos e valida cada uma, mas quem chamasse a
    // mutation direto cadastrava candidatura SEM NENHUM documento — e ela
    // chegava aprovavel no painel. A exigencia vale no servidor tambem.
    if (!input.profilePhotoUrl?.trim()) {
      throw new BadRequestException('Foto do rosto e obrigatoria');
    }
    if (!input.identityPhotoUrl?.trim() || !input.identityPhotoBackUrl?.trim()) {
      throw new BadRequestException('Fotos do documento (frente e verso) sao obrigatorias');
    }
    // Mesma regra do app: veiculo motorizado exige CNH.
    if ((input.vehicleType === 'MOTO' || input.vehicleType === 'CARRO') && !input.cnhNumber?.trim()) {
      throw new BadRequestException('CNH obrigatoria para veiculos motorizados');
    }

    // BUGFIX (espelho do app): data invalida virava NaN e `NaN < 18` e false —
    // a checagem de maioridade PASSAVA. E a divisao por 365.25 errava por um
    // dia perto do aniversario. Idade agora e por calendario.
    const birth = new Date(input.birthDate);
    if (Number.isNaN(birth.getTime())) {
      throw new BadRequestException('Data de nascimento invalida');
    }
    const hoje = new Date();
    let age = hoje.getFullYear() - birth.getFullYear();
    const mes = hoje.getMonth() - birth.getMonth();
    if (mes < 0 || (mes === 0 && hoje.getDate() < birth.getDate())) age--;
    if (age < 18) throw new BadRequestException('Entregador deve ter pelo menos 18 anos');

    user.birthDate = input.birthDate;
    user.cnhNumber = input.cnhNumber ?? '';
    user.vehicleType = input.vehicleType;
    user.vehiclePlate = input.vehiclePlate ?? '';
    user.identityPhotoUrl = input.identityPhotoUrl!;
    user.identityPhotoBackUrl = input.identityPhotoBackUrl!;
    user.profilePhotoUrl = input.profilePhotoUrl!;
    user.pendingRole = 'DELIVERER';
    user.rejectedAt = null;
    user.rejectionReason = null;
    return this.appUsersRepository.save(user);
  }

  async totalCount(): Promise<number> {
    return this.appUsersRepository.count();
  }

  async pendingCount(): Promise<number> {
    return this.appUsersRepository.count({
      where: [{ pendingRole: 'DELIVERER' }],
    });
  }

  async updatePagarmeRecipient(id: string, recipientId: string): Promise<void> {
    await this.appUsersRepository.update(id, {
      pagarmeRecipientId: recipientId,
      paymentConnected: true,
    });
  }

  async disconnectPayment(id: string): Promise<void> {
    // Desconectar no meio de uma entrega fazia o entregador perder 100% do
    // ganho: sem `pagarmeRecipientId` na hora do split, a parte dele e absorvida
    // pela plataforma, definitivamente e sem retroativo. O guard de saldo do
    // Pagar.me nao pega esse caso, porque no modelo de custodia o dinheiro so
    // chega ao entregador APOS a entrega — durante a corrida o saldo dele e
    // zero. Bloqueamos enquanto houver entrega em aberto ou pedido nao
    // liquidado.
    const pendentes = await this.appUsersRepository.manager.query(
      `SELECT COUNT(*)::int AS n
         FROM deliveries d
         JOIN orders o ON o.id = d."orderId"
        WHERE d."delivererId" = $1
          AND (d."deliveredAt" IS NULL OR o."isSettled" = false)
          AND o.status NOT IN ('CANCELLED','REJECTED','EXPIRED')`,
      [id],
    );
    if ((pendentes?.[0]?.n ?? 0) > 0) {
      throw new BadRequestException(
        'Voce tem entregas em andamento ou pagamentos ainda nao repassados. ' +
          'Conclua-as antes de desconectar sua conta de recebimento.',
      );
    }
    await this.appUsersRepository.update(id, {
      pagarmeRecipientId: null as any,
      paymentConnected: false,
    });
  }

  async updatePagarmeCustomerId(id: string, customerId: string): Promise<void> {
    await this.appUsersRepository.update(id, { pagarmeCustomerId: customerId });
  }

  async updatePushToken(id: string, token: string): Promise<void> {
    // Um token do Expo identifica o APARELHO, nao a conta. Quando o usuario B
    // loga num celular onde A ja tinha logado, o mesmo token era gravado em B
    // SEM sair de A — e todo push de A (status de pedido, pagamento, disputa)
    // continuava chegando naquele aparelho, agora nas maos de B. Antes de
    // gravar, tiramos o token de qualquer outra conta.
    await this.appUsersRepository
      .createQueryBuilder()
      .update()
      .set({ expoPushToken: null as any })
      .where('"expoPushToken" = :token AND id != :id', { token, id })
      .execute();
    await this.appUsersRepository.update(id, { expoPushToken: token });
  }

  /** Solta o token deste aparelho no logout, para o proximo usuario nao herdar os pushes. */
  async clearPushToken(id: string, token?: string): Promise<void> {
    const qb = this.appUsersRepository
      .createQueryBuilder()
      .update()
      .set({ expoPushToken: null as any });
    if (token) {
      await qb.where('"expoPushToken" = :token', { token }).execute();
    } else {
      await qb.where('id = :id', { id }).execute();
    }
  }

  async updateProfile(id: string, name?: string, phone?: string, currentPassword?: string, newPassword?: string, avatarUrl?: string): Promise<AppUser> {
    const user = await this.appUsersRepository.findOne({ where: { id } });
    if (!user) throw new NotFoundException('Usuario nao encontrado');
    if (name) user.name = name;
    if (phone) user.phone = phone;
    if (avatarUrl) user.avatarUrl = avatarUrl;
    if (newPassword) {
      if (user.googleId && !user.password) {
        // Google-only account: allow setting first password without current
        user.password = await bcrypt.hash(peppered(newPassword), 10);
      } else {
        if (!currentPassword) throw new BadRequestException('Senha atual e obrigatoria para alterar a senha');
        const valid = await bcrypt.compare(peppered(currentPassword), user.password);
        if (!valid) throw new BadRequestException('Senha atual incorreta');
        user.password = await bcrypt.hash(peppered(newPassword), 10);
      }
    }
    return this.appUsersRepository.save(user);
  }

  async createSuperadmin(input: { name: string; email: string; password: string; phone: string; permissions?: Record<string, boolean> }): Promise<AppUser> {
    const exists = await this.appUsersRepository.findOne({ where: { email: input.email } });
    if (exists) throw new ConflictException('Email ja cadastrado');

    const hashedPassword = await bcrypt.hash(peppered(input.password), 10);
    const user = this.appUsersRepository.create({
      name: input.name,
      email: input.email,
      password: hashedPassword,
      phone: input.phone,
      role: UserRole.SUPERADMIN,
      isActive: true,
      permissions: input.permissions ? JSON.stringify(input.permissions) : null,
    });
    return this.appUsersRepository.save(user);
  }

  async updateNotificationEmail(id: string, email: string): Promise<AppUser> {
    const user = await this.appUsersRepository.findOne({ where: { id } });
    if (!user) throw new NotFoundException('Usuario nao encontrado');
    user.notificationEmail = email;
    return this.appUsersRepository.save(user);
  }

  async updateSuperadminPermissions(id: string, permissions: Record<string, boolean>): Promise<AppUser> {
    const user = await this.appUsersRepository.findOne({ where: { id } });
    if (!user) throw new NotFoundException('Usuario nao encontrado');
    if (user.role !== UserRole.SUPERADMIN) throw new BadRequestException('Usuario nao e superadmin');
    user.permissions = JSON.stringify(permissions);
    return this.appUsersRepository.save(user);
  }

  async acceptTerms(id: string): Promise<AppUser> {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException('Usuario nao encontrado');
    user.acceptedTermsAt = new Date();
    return this.appUsersRepository.save(user);
  }

  async requestPasswordReset(email: string): Promise<string> {
    // KAN-226: mesma resposta para e-mail existente ou nao, evitando enumeracao
    // de contas. Antes lancava NotFoundException, revelando quais e-mails existem.
    const genericMsg =
      'Se o e-mail estiver cadastrado, enviaremos um link de recuperacao';
    const user = await this.findByEmail(email);
    if (!user) return genericMsg;

    const token = crypto.randomBytes(32).toString('hex');
    user.resetPasswordToken = token;
    user.resetPasswordExpires = new Date(Date.now() + 60 * 60 * 1000);
    await this.appUsersRepository.save(user);

    // KAN-258: link vai por e-mail E WhatsApp — localhost silencioso aqui
    // significaria reset de senha impossivel de concluir em producao.
    const apiUrl = resolvePublicUrl(this.configService, 'APP_URL', 'http://localhost:3000');
    const resetUrl = `${apiUrl}/auth/reset-password?token=${token}&type=app`;

    await this.mailService.sendPasswordResetEmail(user.email, user.name, token, resetUrl);
    if (user.phone) {
      this.whatsAppService.notifyPasswordReset(user.phone, user.name, resetUrl).catch(() => {});
    }
    return genericMsg;
  }

  async resetPassword(token: string, newPassword: string): Promise<boolean> {
    const user = await this.appUsersRepository.findOne({
      where: { resetPasswordToken: token },
    });
    if (!user) throw new BadRequestException('Token invalido');
    if (user.resetPasswordExpires < new Date()) {
      throw new BadRequestException('Token expirado. Solicite um novo link.');
    }
    if (newPassword.length < 6) {
      throw new BadRequestException('A senha deve ter pelo menos 6 caracteres');
    }

    user.password = await bcrypt.hash(peppered(newPassword), 10);
    user.resetPasswordToken = null as any;
    user.resetPasswordExpires = null as any;
    // A#2: trocar a senha deve derrubar todas as sessões existentes. Rotaciona o
    // sessionToken para um novo valor — nenhum JWT emitido antes casa mais, então
    // um atacante com um token pré-reset perde o acesso.
    user.sessionToken = crypto.randomBytes(32).toString('hex');
    // KAN-280: e marca que NAO ha sessao — sem isto o proximo login do proprio
    // dono, logo apos o reset, levava ACTIVE_SESSION de um aparelho inexistente.
    user.sessionActive = false;
    await this.appUsersRepository.save(user);
    return true;
  }
}
