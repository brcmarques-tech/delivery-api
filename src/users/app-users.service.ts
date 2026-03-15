import { Injectable, ConflictException, NotFoundException, BadRequestException, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { AppUser } from './entities/app-user.entity';
import { RegisterAppInput } from '../auth/dto/register-app.input';
import { RegisterDelivererInput } from './dto/register-deliverer.input';
import { UserRole } from '../common/enums';
import { MailService } from '../mail/mail.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';

@Injectable()
export class AppUsersService {
  constructor(
    @InjectRepository(AppUser)
    private appUsersRepository: Repository<AppUser>,
    private mailService: MailService,
    private configService: ConfigService,
    private whatsAppService: WhatsAppService,
  ) {}

  private validateCpf(cpf: string): boolean {
    const digits = cpf.replace(/\D/g, '');
    if (digits.length !== 11) return false;
    if (/^(\d)\1{10}$/.test(digits)) return false;

    let sum = 0;
    for (let i = 0; i < 9; i++) sum += parseInt(digits[i]) * (10 - i);
    let check = 11 - (sum % 11);
    if (check >= 10) check = 0;
    if (parseInt(digits[9]) !== check) return false;

    sum = 0;
    for (let i = 0; i < 10; i++) sum += parseInt(digits[i]) * (11 - i);
    check = 11 - (sum % 11);
    if (check >= 10) check = 0;
    if (parseInt(digits[10]) !== check) return false;

    return true;
  }

  async create(input: RegisterAppInput): Promise<AppUser> {
    if (input.cpf) {
      if (!this.validateCpf(input.cpf)) {
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

    const hashedPassword = await bcrypt.hash(input.password, 10);

    const user = this.appUsersRepository.create({
      ...input,
      password: hashedPassword,
      role: UserRole.CUSTOMER,
      acceptedTermsAt: new Date(),
    });
    return this.appUsersRepository.save(user);
  }

  async findByEmail(email: string): Promise<AppUser | null> {
    return this.appUsersRepository.findOne({ where: { email } });
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

    this.mailService.sendRejectionEmail(user.email, user.name, rejectedRole, reason);
    if (user.phone) {
      this.whatsAppService.notifyUserRejected(user.phone, user.name, rejectedRole, reason).catch(() => {});
    }
    return saved;
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

    if ((input.vehicleType === 'MOTO' || input.vehicleType === 'CARRO') && !input.cnhNumber) {
      throw new BadRequestException('CNH obrigatoria para veiculos motorizados');
    }

    user.birthDate = input.birthDate;
    user.cnhNumber = input.cnhNumber ?? '';
    user.vehicleType = input.vehicleType;
    user.vehiclePlate = input.vehiclePlate ?? '';
    user.identityPhotoUrl = input.identityPhotoUrl ?? '';
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

  async updateMpCustomerId(id: string, mpCustomerId: string): Promise<void> {
    await this.appUsersRepository.update(id, { mpCustomerId });
  }

  async updateMpCredentials(id: string, accessToken: string, refreshToken: string, mpUserId: string): Promise<void> {
    await this.appUsersRepository.update(id, {
      mpAccessToken: accessToken,
      mpRefreshToken: refreshToken,
      mpUserId: mpUserId,
      mpConnected: true,
    });
  }

  async updatePushToken(id: string, token: string): Promise<void> {
    await this.appUsersRepository.update(id, { expoPushToken: token });
  }

  async updateProfile(id: string, name?: string, phone?: string, currentPassword?: string, newPassword?: string): Promise<AppUser> {
    const user = await this.appUsersRepository.findOne({ where: { id } });
    if (!user) throw new NotFoundException('Usuario nao encontrado');
    if (name) user.name = name;
    if (phone) user.phone = phone;
    if (newPassword) {
      if (!currentPassword) throw new BadRequestException('Senha atual e obrigatoria para alterar a senha');
      const valid = await bcrypt.compare(currentPassword, user.password);
      if (!valid) throw new BadRequestException('Senha atual incorreta');
      user.password = await bcrypt.hash(newPassword, 10);
    }
    return this.appUsersRepository.save(user);
  }

  async disconnectMp(id: string): Promise<void> {
    await this.appUsersRepository.update(id, {
      mpAccessToken: null as any,
      mpRefreshToken: null as any,
      mpUserId: null as any,
      mpConnected: false,
    });
  }

  async createSuperadmin(input: { name: string; email: string; password: string; phone: string; permissions?: Record<string, boolean> }): Promise<AppUser> {
    const exists = await this.appUsersRepository.findOne({ where: { email: input.email } });
    if (exists) throw new ConflictException('Email ja cadastrado');

    const hashedPassword = await bcrypt.hash(input.password, 10);
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
    const user = await this.findByEmail(email);
    if (!user) throw new NotFoundException('Email nao encontrado');

    const token = crypto.randomBytes(32).toString('hex');
    user.resetPasswordToken = token;
    user.resetPasswordExpires = new Date(Date.now() + 60 * 60 * 1000);
    await this.appUsersRepository.save(user);

    const apiUrl = this.configService.get('APP_URL', 'http://localhost:3000');
    const resetUrl = `${apiUrl}/auth/reset-password?token=${token}&type=app`;

    await this.mailService.sendPasswordResetEmail(user.email, user.name, token, resetUrl);
    if (user.phone) {
      this.whatsAppService.notifyPasswordReset(user.phone, user.name, resetUrl).catch(() => {});
    }
    return 'Email de recuperacao enviado';
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

    user.password = await bcrypt.hash(newPassword, 10);
    user.resetPasswordToken = null as any;
    user.resetPasswordExpires = null as any;
    await this.appUsersRepository.save(user);
    return true;
  }
}
