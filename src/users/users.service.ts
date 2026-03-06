import { Injectable, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { User } from './entities/user.entity';
import { RegisterInput } from '../auth/dto/register.input';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,
  ) {}

  async create(input: RegisterInput): Promise<User> {
    const exists = await this.usersRepository.findOne({
      where: [{ email: input.email }, { phone: input.phone }],
    });
    if (exists) {
      throw new ConflictException('Email ou telefone ja cadastrado');
    }

    const hashedPassword = await bcrypt.hash(input.password, 10);
    const user = this.usersRepository.create({
      ...input,
      password: hashedPassword,
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
    return this.usersRepository.find();
  }
}
