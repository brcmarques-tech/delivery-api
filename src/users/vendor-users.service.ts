import { Injectable, ConflictException, NotFoundException, BadRequestException, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { VendorUser } from './entities/vendor-user.entity';
import { ApprovalLog } from './entities/approval-log.entity';
import { RegisterVendorInput } from '../auth/dto/register-vendor.input';
import { UserRole, VendorPlan } from '../common/enums';
import { MailService } from '../mail/mail.service';
import { VerificationService } from '../stores/verification.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { peppered } from '../common/utils/pepper';

import { isValidCpf } from '../common/utils/cpf'; // KAN-253
import { resolvePublicUrl } from '../common/utils/public-url';
@Injectable()
export class VendorUsersService {
  constructor(
    @InjectRepository(VendorUser)
    private vendorUsersRepository: Repository<VendorUser>,
    @InjectRepository(ApprovalLog)
    private approvalLogRepository: Repository<ApprovalLog>,
    private mailService: MailService,
    @Inject(forwardRef(() => VerificationService))
    private verificationService: VerificationService,
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
        const cpfExists = await this.vendorUsersRepository.findOne({ where: { cpf } });
        if (cpfExists) {
          result.cpfError = 'CPF ja cadastrado';
          result.valid = false;
        }
      }
    }

    const emailExists = await this.vendorUsersRepository.findOne({ where: { email } });
    if (emailExists) {
      result.emailError = 'Email ja cadastrado';
      result.valid = false;
    }

    if (phone) {
      const phoneDigits = phone.replace(/\D/g, '');
      const phoneExists = await this.vendorUsersRepository.findOne({ where: { phone: phoneDigits } });
      if (phoneExists) {
        result.phoneError = 'Telefone ja cadastrado';
        result.valid = false;
      }
    }

    return result;
  }

  /**
   * KAN-231: `phoneVerified` deixou de ser literal `true` (mesmo problema do
   * cadastro de cliente) — quem chama informa se houve verificacao de fato.
   */
  async create(input: RegisterVendorInput, phoneVerified = false): Promise<VendorUser> {
    if (input.cpf) {
      if (!isValidCpf(input.cpf)) {
        throw new BadRequestException('CPF invalido');
      }
    }

    const exists = await this.vendorUsersRepository.findOne({
      where: { email: input.email },
    });
    if (exists) {
      throw new ConflictException('Email ja cadastrado');
    }

    if (input.cpf) {
      // NORMALIZA antes de checar e de gravar — mesma correcao do app-users
      // (ver comentario la): CPF com mascara furava a unicidade e gerava
      // recipient Pagar.me duplicado para o mesmo documento.
      input.cpf = input.cpf.replace(/\D/g, '');
      const cpfExists = await this.vendorUsersRepository.findOne({
        where: { cpf: input.cpf },
      });
      if (cpfExists) {
        throw new ConflictException('CPF ja cadastrado');
      }
    }

    const hashedPassword = await bcrypt.hash(peppered(input.password), 10);

    // Vendor registra como CUSTOMER com pendingRole VENDOR, aguarda aprovacao
    const user = this.vendorUsersRepository.create({
      ...input,
      password: hashedPassword,
      role: UserRole.CUSTOMER,
      pendingRole: 'VENDOR',
      phoneVerified,
      acceptedTermsAt: new Date(),
    });
    return this.vendorUsersRepository.save(user);
  }

  async findByEmail(email: string): Promise<VendorUser | null> {
    return this.vendorUsersRepository.findOne({ where: { email } });
  }

  async findByCpfWithRecipient(cpf: string): Promise<VendorUser | null> {
    return this.vendorUsersRepository
      .createQueryBuilder('u')
      .where('u.cpf = :cpf', { cpf })
      .andWhere('u.pagarmeRecipientId IS NOT NULL')
      .getOne();
  }

  async findById(id: string): Promise<VendorUser | null> {
    return this.vendorUsersRepository.findOne({
      where: { id },
    });
  }

  async findAll(): Promise<VendorUser[]> {
    return this.vendorUsersRepository.find({
      relations: ['stores'],
      order: { createdAt: 'DESC' },
    });
  }

  async findPendingApprovals(): Promise<VendorUser[]> {
    return this.vendorUsersRepository
      .createQueryBuilder('user')
      .where('user.pendingRole = :role', { role: 'VENDOR' })
      .orWhere('user.role = :vendorRole AND user.approvedAt IS NULL', {
        vendorRole: UserRole.VENDOR,
      })
      .orderBy('user.createdAt', 'ASC')
      .getMany();
  }

  async approveUser(id: string): Promise<VendorUser> {
    const user = await this.vendorUsersRepository.findOne({ where: { id } });
    if (!user) throw new NotFoundException('Usuario nao encontrado');

    if (!user.pendingRole && user.approvedAt) {
      throw new BadRequestException('Usuario ja foi aprovado');
    }

    if (user.pendingRole === 'VENDOR') {
      user.role = UserRole.VENDOR;
      user.vendorPlan = VendorPlan.FREE;
    }

    const approvedRole = user.pendingRole || user.role;
    user.approvedAt = new Date();
    user.pendingRole = null;
    user.rejectedAt = null;
    user.rejectionReason = null;
    const saved = await this.vendorUsersRepository.save(user);

    await this.approvalLogRepository.save({
      userId: user.id,
      userName: user.name,
      userEmail: user.email,
      userType: 'vendor',
      action: 'APPROVED',
      role: approvedRole,
      reason: null,
      profilePhotoUrl: null,
      identityPhotoUrl: null,
      identityPhotoBackUrl: null,
    });

    this.mailService.sendApprovalEmail(user.email, user.name, approvedRole);
    if (user.phone) {
      this.whatsAppService.notifyUserApproved(user.phone, user.name, approvedRole).catch(() => {});
    }
    return saved;
  }

  async rejectUser(id: string, reason: string): Promise<VendorUser> {
    const user = await this.vendorUsersRepository.findOne({ where: { id } });
    if (!user) throw new NotFoundException('Usuario nao encontrado');

    const rejectedRole = user.pendingRole || user.role;

    if (!user.pendingRole && user.role === UserRole.VENDOR) {
      user.role = UserRole.CUSTOMER;
    }

    user.rejectedAt = new Date();
    user.rejectionReason = reason;
    user.pendingRole = null;
    const saved = await this.vendorUsersRepository.save(user);

    await this.approvalLogRepository.save({
      userId: user.id,
      userName: user.name,
      userEmail: user.email,
      userType: 'vendor',
      action: 'REJECTED',
      role: rejectedRole,
      reason,
      profilePhotoUrl: null,
      identityPhotoUrl: null,
      identityPhotoBackUrl: null,
    });

    this.mailService.sendRejectionEmail(user.email, user.name, rejectedRole, reason);
    if (user.phone) {
      this.whatsAppService.notifyUserRejected(user.phone, user.name, rejectedRole, reason).catch(() => {});
    }
    return saved;
  }

  async toggleUserActive(id: string): Promise<VendorUser> {
    const user = await this.vendorUsersRepository.findOne({ where: { id } });
    if (!user) throw new NotFoundException('Usuario nao encontrado');
    user.isActive = !user.isActive;
    // SEGURANCA: ao DESATIVAR, rotaciona o sessionToken para derrubar na hora
    // qualquer sessao ja aberta (o jwt.strategy compara o token da sessao).
    // Sem isto o banido continuava usando o app ate o JWT expirar.
    if (!user.isActive) {
      user.sessionToken = crypto.randomBytes(32).toString('hex');
    }
    return this.vendorUsersRepository.save(user);
  }

  async totalCount(): Promise<number> {
    return this.vendorUsersRepository.count();
  }

  async pendingCount(): Promise<number> {
    return this.vendorUsersRepository.count({
      where: [{ pendingRole: 'VENDOR' }],
    });
  }

  async updateVendorPlan(
    id: string,
    plan: VendorPlan,
    durationMonths: number,
    expiresAt?: Date,
  ): Promise<VendorUser> {
    const user = await this.vendorUsersRepository.findOne({ where: { id } });
    if (!user) throw new NotFoundException('Usuario nao encontrado');
    if (user.role !== UserRole.VENDOR) {
      throw new BadRequestException('Apenas vendedores podem ter planos');
    }

    user.vendorPlan = plan;
    if (plan !== VendorPlan.FREE) {
      // Se veio uma data exata (fim do ciclo pago), usa ela. Antes, o webhook
      // convertia o período em meses via ceil(dias/30) e reaplicava com setMonth,
      // arredondando pra cima — um ciclo trimestral (~91d) virava +4 meses (~120d),
      // dando ~1 mês a mais de plano por ciclo do que foi pago.
      if (expiresAt) {
        // ...mas o fim do ciclo do Pagar.me NUNCA pode encurtar o que ja foi
        // pago. Este ramo (cartao) sobrescrevia direto, enquanto o ramo de baixo
        // (PIX) empilhava — o mesmo upgrade tirava dias por cartao e dava dias
        // por PIX. Dois casos concretos de perda: quem tinha PRO anual e subia
        // para PREMIUM mensal no meio do ciclo ficava com o vencimento do mes
        // seguinte, perdendo os meses de PRO ja pagos; e os dias de trial do
        // selo DIAMOND evaporavam na primeira renovacao. Agora vale o MAIOR
        // entre o ciclo novo e o vencimento atual.
        const atualCartao = user.planExpiresAt
          ? new Date(user.planExpiresAt)
          : null;
        user.planExpiresAt =
          atualCartao && atualCartao.getTime() > expiresAt.getTime()
            ? atualCartao
            : expiresAt;
      } else {
        // BUGFIX: a base era sempre "hoje" — uma renovacao por PIX feita antes do
        // vencimento DESTRUIA os dias restantes ja pagos (ex.: faltando 40 dias,
        // comprar +12 meses dava 12 meses a partir de hoje, perdendo os 40).
        // Agora empilha sobre o que resta: base = max(hoje, vencimento atual).
        // Continua correto para quem ja venceu (base vira hoje).
        const atual = user.planExpiresAt ? new Date(user.planExpiresAt) : null;
        const base = atual && atual.getTime() > Date.now() ? atual : new Date();
        const e = new Date(base);
        e.setMonth(e.getMonth() + durationMonths);
        // setMonth transborda quando o dia nao existe no mes de destino: renovar
        // mensal em 31/01 pedia "31 de fevereiro" e o JS normalizava para 03/03,
        // entregando 31 dias em vez de 28. Como o proximo ciclo parte dessa data
        // deslocada, o erro nunca se corrigia sozinho. Voltar para o ultimo dia
        // do mes de destino (setDate(0)) mantem o vencimento no fim do mes.
        if (e.getDate() !== base.getDate()) e.setDate(0);
        user.planExpiresAt = e;
      }
    } else {
      user.planExpiresAt = null;
    }

    const saved = await this.vendorUsersRepository.save(user);
    this.verificationService.onPlanChanged(id, plan).catch(() => {});
    return saved;
  }

  async updatePagarmeRecipient(id: string, recipientId: string): Promise<void> {
    await this.vendorUsersRepository.update(id, {
      pagarmeRecipientId: recipientId,
      paymentConnected: true,
    });
  }

  async disconnectPayment(id: string): Promise<void> {
    await this.vendorUsersRepository.update(id, {
      pagarmeRecipientId: null as any,
      paymentConnected: false,
    });
  }

  async updatePushToken(id: string, token: string): Promise<void> {
    await this.vendorUsersRepository.update(id, { expoPushToken: token });
  }

  async updateProfile(id: string, name?: string, phone?: string, currentPassword?: string, newPassword?: string, email?: string, cpf?: string): Promise<VendorUser> {
    const user = await this.vendorUsersRepository.findOne({ where: { id } });
    if (!user) throw new NotFoundException('Usuario nao encontrado');
    if (name) user.name = name;
    if (phone) user.phone = phone;
    // CPF: só pode ser PREENCHIDO quando está vazio (não permite trocar um CPF já
    // cadastrado, por integridade/anti-fraude). Necessário para pagar plano/pedido
    // com PIX. Valida formato e unicidade.
    if (cpf && !user.cpf) {
      const clean = cpf.replace(/\D/g, '');
      if (!isValidCpf(clean)) throw new BadRequestException('CPF invalido');
      const existing = await this.vendorUsersRepository.findOne({ where: { cpf: clean } });
      if (existing) throw new BadRequestException('CPF ja cadastrado');
      user.cpf = clean;
    } else if (cpf && user.cpf && cpf.replace(/\D/g, '') !== user.cpf) {
      throw new BadRequestException('O CPF ja esta cadastrado e nao pode ser alterado. Fale com o suporte.');
    }
    if (email && email !== user.email) {
      const existing = await this.vendorUsersRepository.findOne({ where: { email } });
      if (existing) throw new BadRequestException('Este email ja esta em uso');
      user.email = email;
      user.emailVerified = false;
    }
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
    return this.vendorUsersRepository.save(user);
  }

  async acceptTerms(id: string): Promise<VendorUser> {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException('Usuario nao encontrado');
    user.acceptedTermsAt = new Date();
    return this.vendorUsersRepository.save(user);
  }

  async acceptSubscriptionTerms(id: string): Promise<VendorUser> {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException('Usuario nao encontrado');
    user.acceptedSubscriptionTermsAt = new Date();
    return this.vendorUsersRepository.save(user);
  }

  async requestPasswordReset(email: string): Promise<string> {
    // KAN-226: mesma resposta para e-mail existente ou nao (anti-enumeracao).
    const genericMsg =
      'Se o e-mail estiver cadastrado, enviaremos um link de recuperacao';
    const user = await this.findByEmail(email);
    if (!user) return genericMsg;

    const token = crypto.randomBytes(32).toString('hex');
    user.resetPasswordToken = token;
    user.resetPasswordExpires = new Date(Date.now() + 60 * 60 * 1000);
    await this.vendorUsersRepository.save(user);

    // KAN-258: idem — reset de senha do lojista por e-mail/WhatsApp.
    const vendorUrl = resolvePublicUrl(this.configService, 'VENDOR_APP_URL', 'http://localhost:3001');
    const resetUrl = `${vendorUrl}/reset-password?token=${token}`;

    await this.mailService.sendPasswordResetEmail(user.email, user.name, token, resetUrl);
    if (user.phone) {
      this.whatsAppService.notifyPasswordReset(user.phone, user.name, resetUrl).catch(() => {});
    }
    return genericMsg;
  }

  async resetPassword(token: string, newPassword: string): Promise<boolean> {
    const user = await this.vendorUsersRepository.findOne({
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
    // A#2: trocar a senha derruba todas as sessões existentes (rotaciona o
    // sessionToken → JWTs pré-reset deixam de casar).
    user.sessionToken = crypto.randomBytes(32).toString('hex');
    // KAN-280: sem sessao apos o reset — senao o proximo login levava
    // ACTIVE_SESSION fantasma.
    user.sessionActive = false;
    await this.vendorUsersRepository.save(user);
    return true;
  }
}
