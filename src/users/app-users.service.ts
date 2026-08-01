import { Injectable, ConflictException, NotFoundException, BadRequestException, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
    user.isActive = !user.isActive;
    // SEGURANCA: ao DESATIVAR, rotaciona o sessionToken para derrubar na hora
    // qualquer sessao ja aberta (o jwt.strategy compara o token da sessao).
    // Sem isto o banido continuava usando o app ate o JWT expirar.
    if (!user.isActive) {
      user.sessionToken = crypto.randomBytes(32).toString('hex');
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

    const birth = new Date(input.birthDate);
    const age = Math.floor((Date.now() - birth.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
    if (age < 18) throw new BadRequestException('Entregador deve ter pelo menos 18 anos');

    user.birthDate = input.birthDate;
    user.cnhNumber = input.cnhNumber ?? '';
    user.vehicleType = input.vehicleType;
    user.vehiclePlate = input.vehiclePlate ?? '';
    user.identityPhotoUrl = input.identityPhotoUrl ?? '';
    user.identityPhotoBackUrl = input.identityPhotoBackUrl ?? '';
    user.profilePhotoUrl = input.profilePhotoUrl ?? '';
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
    await this.appUsersRepository.save(user);
    return true;
  }
}
