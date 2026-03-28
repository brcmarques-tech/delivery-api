import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { AppUser } from '../users/entities/app-user.entity';
import { VendorUser } from '../users/entities/vendor-user.entity';
import { UserRole } from '../common/enums';

@Injectable()
export class SeedService implements OnModuleInit {
  private readonly logger = new Logger(SeedService.name);

  constructor(
    @InjectRepository(AppUser) private appUsersRepository: Repository<AppUser>,
    @InjectRepository(VendorUser) private vendorUsersRepository: Repository<VendorUser>,
  ) {}

  async onModuleInit() {
    await this.seedUsers();
  }

  private async seedUsers() {
    // App users (SUPERADMIN, CUSTOMER, DELIVERER)
    const appUsers = [
      { name: 'Super Admin', email: 'superadmin@bcmtech.com', password: 'teste123', phone: '11900000000', role: UserRole.SUPERADMIN },
      { name: 'Cliente', email: 'cliente@bcmtech.com', password: 'teste123', phone: '11900000003', role: UserRole.CUSTOMER },
      { name: 'Entregador', email: 'entregador@bcmtech.com', password: 'teste123', phone: '11900000004', role: UserRole.DELIVERER },
    ];

    for (const userData of appUsers) {
      const exists = await this.appUsersRepository.findOne({ where: { email: userData.email } });
      if (!exists) {
        const hashedPassword = await bcrypt.hash(userData.password, 10);
        const user = this.appUsersRepository.create({ ...userData, password: hashedPassword });
        await this.appUsersRepository.save(user);
        this.logger.log(`Seed: app user ${userData.email} criado (${userData.role})`);
      }
    }

    // Vendor users
    const vendorUsers = [
      { name: 'Admin', email: 'admin@bcmtech.com', password: 'teste123', phone: '11900000001' },
      { name: 'Vendedor', email: 'vendor@bcmtech.com', password: 'teste123', phone: '11900000002' },
    ];

    for (const userData of vendorUsers) {
      const exists = await this.vendorUsersRepository.findOne({ where: { email: userData.email } });
      if (!exists) {
        const hashedPassword = await bcrypt.hash(userData.password, 10);
        const user = this.vendorUsersRepository.create({
          ...userData,
          password: hashedPassword,
          role: UserRole.VENDOR,
        });
        await this.vendorUsersRepository.save(user);
        this.logger.log(`Seed: vendor user ${userData.email} criado (VENDOR)`);
      }
    }
  }
}
