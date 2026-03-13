import { Injectable, ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { User } from './entities/user.entity';
import { RegisterInput } from '../auth/dto/register.input';
import { RegisterDelivererInput } from './dto/register-deliverer.input';
import { UserRole, VendorPlan } from '../common/enums';
import { MailService } from '../mail/mail.service';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    private mailService: MailService,
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

  private async validateCpfOnline(cpf: string): Promise<{ valid: boolean; name?: string }> {
    const digits = cpf.replace(/\D/g, '');
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`https://brasilapi.com.br/api/v1/cpf/${digits}`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) return { valid: false };
      const data = await res.json();
      return { valid: true, name: data.nome };
    } catch {
      // API fora do ar ou timeout — aceita normalmente
      return { valid: true };
    }
  }

  async create(input: RegisterInput): Promise<User> {
    if (input.cpf) {
      if (!this.validateCpf(input.cpf)) {
        throw new BadRequestException('CPF invalido');
      }
      // Tenta validar online (se a API estiver disponível)
      const online = await this.validateCpfOnline(input.cpf);
      if (!online.valid) {
        throw new BadRequestException('CPF nao encontrado na base da Receita Federal');
      }
    }

    const exists = await this.usersRepository.findOne({
      where: { email: input.email },
    });
    if (exists) {
      throw new ConflictException('Email ja cadastrado');
    }

    const hashedPassword = await bcrypt.hash(input.password, 10);

    // Se role for VENDOR, cria como CUSTOMER com pendingRole
    const isVendorRequest = input.role === UserRole.VENDOR;
    const user = this.usersRepository.create({
      ...input,
      password: hashedPassword,
      role: UserRole.CUSTOMER,
      pendingRole: isVendorRequest ? 'VENDOR' : null,
    });
    return this.usersRepository.save(user);
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { email } });
  }

  async findById(id: string): Promise<User | null> {
    return this.usersRepository.findOne({
      where: { id },
      relations: ['addresses'],
    });
  }

  async findAll(): Promise<User[]> {
    return this.usersRepository.find({
      relations: ['stores'],
      order: { createdAt: 'DESC' },
    });
  }

  async findPendingApprovals(): Promise<User[]> {
    return this.usersRepository
      .createQueryBuilder('user')
      .where('user.pendingRole IN (:...roles)', { roles: ['VENDOR', 'DELIVERER'] })
      .orWhere('user.role IN (:...activeRoles) AND user.approvedAt IS NULL', {
        activeRoles: [UserRole.VENDOR, UserRole.DELIVERER],
      })
      .orderBy('user.createdAt', 'ASC')
      .getMany();
  }

  async approveUser(id: string): Promise<User> {
    const user = await this.usersRepository.findOne({ where: { id } });
    if (!user) throw new NotFoundException('Usuario nao encontrado');

    // Contas antigas (ja tem role mas nunca foram aprovadas)
    if (!user.pendingRole && user.approvedAt) {
      throw new BadRequestException('Usuario ja foi aprovado');
    }

    if (user.pendingRole === 'DELIVERER') {
      user.role = UserRole.DELIVERER;
      user.isDeliverer = true;
    } else if (user.pendingRole === 'VENDOR') {
      user.role = UserRole.VENDOR;
      user.vendorPlan = VendorPlan.FREE;
    }
    // Contas antigas sem pendingRole: apenas marca como aprovada

    const approvedRole = user.pendingRole || user.role;
    user.approvedAt = new Date();
    user.pendingRole = null;
    user.rejectedAt = null;
    user.rejectionReason = null;
    const saved = await this.usersRepository.save(user);

    this.mailService.sendApprovalEmail(user.email, user.name, approvedRole);
    return saved;
  }

  async rejectUser(id: string, reason: string): Promise<User> {
    const user = await this.usersRepository.findOne({ where: { id } });
    if (!user) throw new NotFoundException('Usuario nao encontrado');

    const rejectedRole = user.pendingRole || user.role;

    // Conta antiga sem pendingRole: rebaixa para CUSTOMER
    if (!user.pendingRole && (user.role === UserRole.VENDOR || user.role === UserRole.DELIVERER)) {
      user.role = UserRole.CUSTOMER;
      if (user.isDeliverer) user.isDeliverer = false;
    }

    user.rejectedAt = new Date();
    user.rejectionReason = reason;
    user.pendingRole = null;
    const saved = await this.usersRepository.save(user);

    this.mailService.sendRejectionEmail(user.email, user.name, rejectedRole, reason);
    return saved;
  }

  async updateUserRole(id: string, role: UserRole): Promise<User> {
    const user = await this.usersRepository.findOne({ where: { id } });
    if (!user) throw new NotFoundException('Usuario nao encontrado');
    user.role = role;
    user.isDeliverer = role === UserRole.DELIVERER;
    return this.usersRepository.save(user);
  }

  async toggleUserActive(id: string): Promise<User> {
    const user = await this.usersRepository.findOne({ where: { id } });
    if (!user) throw new NotFoundException('Usuario nao encontrado');
    user.isActive = !user.isActive;
    return this.usersRepository.save(user);
  }

  async countByRole(): Promise<{ role: string; count: number }[]> {
    return this.usersRepository
      .createQueryBuilder('user')
      .select('user.role', 'role')
      .addSelect('COUNT(*)', 'count')
      .groupBy('user.role')
      .getRawMany();
  }

  async registerAsDeliverer(userId: string, input: RegisterDelivererInput): Promise<User> {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('Usuario nao encontrado');
    if (user.isDeliverer) throw new BadRequestException('Usuario ja e entregador');
    if (user.pendingRole === 'DELIVERER') throw new BadRequestException('Cadastro ja enviado, aguarde aprovacao');

    // Validar maioridade
    const birth = new Date(input.birthDate);
    const age = Math.floor((Date.now() - birth.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
    if (age < 18) throw new BadRequestException('Entregador deve ter pelo menos 18 anos');

    // CNH obrigatória para veículos motorizados
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
    return this.usersRepository.save(user);
  }

  async totalCount(): Promise<number> {
    return this.usersRepository.count();
  }

  async updateVendorPlan(id: string, plan: VendorPlan, durationMonths: number): Promise<User> {
    const user = await this.usersRepository.findOne({ where: { id } });
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

    return this.usersRepository.save(user);
  }

  async pendingCount(): Promise<number> {
    return this.usersRepository.count({
      where: [
        { pendingRole: 'VENDOR' },
        { pendingRole: 'DELIVERER' },
      ],
    });
  }

  async updateMpCustomerId(id: string, mpCustomerId: string): Promise<void> {
    await this.usersRepository.update(id, { mpCustomerId });
  }

  async updateMpCredentials(id: string, accessToken: string, refreshToken: string, mpUserId: string): Promise<void> {
    await this.usersRepository.update(id, {
      mpAccessToken: accessToken,
      mpRefreshToken: refreshToken,
      mpUserId: mpUserId,
      mpConnected: true,
    });
  }

  async updatePushToken(id: string, token: string): Promise<void> {
    await this.usersRepository.update(id, { expoPushToken: token });
  }

  async updateProfile(id: string, name?: string, phone?: string, currentPassword?: string, newPassword?: string): Promise<User> {
    const user = await this.usersRepository.findOne({ where: { id } });
    if (!user) throw new NotFoundException('Usuario nao encontrado');
    if (name) user.name = name;
    if (phone) user.phone = phone;
    if (newPassword) {
      if (!currentPassword) throw new BadRequestException('Senha atual e obrigatoria para alterar a senha');
      const valid = await bcrypt.compare(currentPassword, user.password);
      if (!valid) throw new BadRequestException('Senha atual incorreta');
      user.password = await bcrypt.hash(newPassword, 10);
    }
    return this.usersRepository.save(user);
  }

  async disconnectMp(id: string): Promise<void> {
    await this.usersRepository.update(id, {
      mpAccessToken: null as any,
      mpRefreshToken: null as any,
      mpUserId: null as any,
      mpConnected: false,
    });
  }

  async acceptTerms(id: string): Promise<User> {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException('Usuario nao encontrado');
    user.acceptedTermsAt = new Date();
    return this.usersRepository.save(user);
  }

  async acceptSubscriptionTerms(id: string): Promise<User> {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException('Usuario nao encontrado');
    user.acceptedSubscriptionTermsAt = new Date();
    return this.usersRepository.save(user);
  }
}
