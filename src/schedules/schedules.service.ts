import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Schedule } from './entities/schedule.entity';
import { SetScheduleInput } from './dto/set-schedule.input';
import { Store } from '../stores/entities/store.entity';

@Injectable()
export class SchedulesService {
  constructor(
    @InjectRepository(Schedule)
    private schedulesRepository: Repository<Schedule>,
    @InjectRepository(Store)
    private storesRepository: Repository<Store>,
  ) {}

  async setSchedule(input: SetScheduleInput, owner: any): Promise<Schedule[]> {
    const store = await this.storesRepository.findOne({
      where: { id: input.storeId },
      relations: ['owner'],
    });
    if (!store) throw new NotFoundException('Loja nao encontrada');
    if (store.owner?.id !== owner.id) {
      throw new BadRequestException('Voce nao tem permissao para gerenciar horarios desta loja.');
    }

    // Remove existing schedules for this store
    await this.schedulesRepository.delete({ storeId: input.storeId });

    // Create new entries
    const schedules = input.entries.map((entry) =>
      this.schedulesRepository.create({
        storeId: input.storeId,
        dayOfWeek: entry.dayOfWeek,
        startTime: entry.startTime,
        endTime: entry.endTime,
        isActive: entry.isActive,
      }),
    );

    return this.schedulesRepository.save(schedules);
  }

  async getByStore(storeId: string): Promise<Schedule[]> {
    return this.schedulesRepository.find({
      where: { storeId },
      order: { dayOfWeek: 'ASC' },
    });
  }
}
