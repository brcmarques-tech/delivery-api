import { Injectable, ConflictException, NotFoundException, BadRequestException, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { VendorUser } from './entities/vendor-user.entity';
import { RegisterVendorInput } from '../auth/dto/register-vendor.input';
import { UserRole, VendorPlan } from '../common/enums';
import { MailService } from '../mail/mail.service';
import { VerificationService } from '../stores/verification.service';

@Injectable()
export class VendorUsersService {
  constructor(
    @InjectRepository(VendorUser)
    private vendorUsersRepository: Repository<VendorUser>,
    private mailService: MailService,
    @Inject(forwardRef(() => VerificationService))
    private verificationService: VerificationService,
    private configService: ConfigService,
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

  async create(input: RegisterVendorInput): Promise<VendorUser> {
    if (input.cpf) {
      if (!this.validateCpf(input.cpf)) {
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
      const cpfExists = await this.vendorUsersRepository.findOne({
        where: { cpf: input.cpf },
      });
      if (cpfExists) {
        throw new ConflictException('CPF ja cadastrado');
      }
    }

    const hashedPassword = await bcrypt.hash(input.password, 10);

    // Vendor registra como CUSTOMER com pendingRole VENDOR, aguarda aprovacao
    const user = this.vendorUsersRepository.create({
      ...input,
      password: hashedPassword,
      role: UserRole.CUSTOMER,
      pendingRole: 'VENDOR',
      acceptedTermsAt: new Date(),
    });
    return this.vendorUsersRepository.save(user);
  }

  async findByEmail(email: string): Promise<VendorUser | null> {
    return this.vendorUsersRepository.findOne({ where: { email } });
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

    this.mailService.sendApprovalEmail(user.email, user.name, approvedRole);
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

    this.mailService.sendRejectionEmail(user.email, user.name, rejectedRole, reason);
    return saved;
  }

  async toggleUserActive(id: string): Promise<VendorUser> {
    const user = await this.vendorUsersRepository.findOne({ where: { id } });
    if (!user) throw new NotFoundException('Usuario nao encontrado');
    user.isActive = !user.isActive;
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

  async updateVendorPlan(id: string, plan: VendorPlan, durationMonths: number): Promise<VendorUser> {
    const user = await this.vendorUsersRepository.findOne({ where: { id } });
    if (!user) throw new NotFoundException('Usuario nao encontrado');
    if (user.role !== UserRole.VENDOR) {
      throw new BadRequestException('Apenas vendedores podem ter planos');
    }

    user.vendorPlan = plan;
    if (plan !== VendorPlan.FREE) {
      const expiresAt = new Date();
      expiresAt.setMonth(expiresAt.getMonth() + durationMonths);
      user.planExpiresAt = expiresAt;
    } else {
      user.planExpiresAt = null;
    }

    const saved = await this.vendorUsersRepository.save(user);
    this.verificationService.onPlanChanged(id, plan).catch(() => {});
    return saved;
  }

  async updateMpCustomerId(id: string, mpCustomerId: string): Promise<void> {
    await this.vendorUsersRepository.update(id, { mpCustomerId });
  }

  async updateMpCredentials(id: string, accessToken: string, refreshToken: string, mpUserId: string): Promise<void> {
    await this.vendorUsersRepository.update(id, {
      mpAccessToken: accessToken,
      mpRefreshToken: refreshToken,
      mpUserId: mpUserId,
      mpConnected: true,
    });
  }

  async updatePushToken(id: string, token: string): Promise<void> {
    await this.vendorUsersRepository.update(id, { expoPushToken: token });
  }

  async updateProfile(id: string, name?: string, phone?: string, currentPassword?: string, newPassword?: string): Promise<VendorUser> {
    const user = await this.vendorUsersRepository.findOne({ where: { id } });
    if (!user) throw new NotFoundException('Usuario nao encontrado');
    if (name) user.name = name;
    if (phone) user.phone = phone;
    if (newPassword) {
      if (!currentPassword) throw new BadRequestException('Senha atual e obrigatoria para alterar a senha');
      const valid = await bcrypt.compare(currentPassword, user.password);
      if (!valid) throw new BadRequestException('Senha atual incorreta');
      user.password = await bcrypt.hash(newPassword, 10);
    }
    return this.vendorUsersRepository.save(user);
  }

  async disconnectMp(id: string): Promise<void> {
    await this.vendorUsersRepository.update(id, {
      mpAccessToken: null as any,
      mpRefreshToken: null as any,
      mpUserId: null as any,
      mpConnected: false,
    });
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
    const user = await this.findByEmail(email);
    if (!user) throw new NotFoundException('Email nao encontrado');

    const token = crypto.randomBytes(32).toString('hex');
    user.resetPasswordToken = token;
    user.resetPasswordExpires = new Date(Date.now() + 60 * 60 * 1000);
    await this.vendorUsersRepository.save(user);

    const vendorUrl = this.configService.get('VENDOR_APP_URL', 'http://localhost:3001');
    const resetUrl = `${vendorUrl}/reset-password?token=${token}`;

    await this.mailService.sendPasswordResetEmail(user.email, user.name, token, resetUrl);
    return 'Email de recuperacao enviado';
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

    user.password = await bcrypt.hash(newPassword, 10);
    user.resetPasswordToken = null as any;
    user.resetPasswordExpires = null as any;
    await this.vendorUsersRepository.save(user);
    return true;
  }
}
