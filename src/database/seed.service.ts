import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../common/enums';

@Injectable()
export class SeedService implements OnModuleInit {
  private readonly logger = new Logger(SeedService.name);

  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,
  ) {}

  async onModuleInit() {
    await this.seedUsers();
  }

  private async seedUsers() {
    const users = [
      {
        name: 'Admin',
        email: 'admin@bcmtech.com',
        password: 'admin123',
        phone: '11900000001',
        role: UserRole.ADMIN,
      },
      {
        name: 'Vendedor',
        email: 'vendor@bcmtech.com',
        password: 'vendor123',
        phone: '11900000002',
        role: UserRole.VENDOR,
      },
      {
        name: 'Cliente',
        email: 'cliente@bcmtech.com',
        password: 'cliente123',
        phone: '11900000003',
        role: UserRole.CUSTOMER,
      },
      {
        name: 'Entregador',
        email: 'entregador@bcmtech.com',
        password: 'entrega123',
        phone: '11900000004',
        role: UserRole.DELIVERER,
      },
    ];

    for (const userData of users) {
      const exists = await this.usersRepository.findOne({
        where: { email: userData.email },
      });

      if (!exists) {
        const hashedPassword = await bcrypt.hash(userData.password, 10);
        const user = this.usersRepository.create({
          ...userData,
          password: hashedPassword,
        });
        await this.usersRepository.save(user);
        this.logger.log(`Seed: usuario ${userData.email} criado (${userData.role})`);
      }
    }
  }
}
