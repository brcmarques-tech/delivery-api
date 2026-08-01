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

    // BUGFIX: o delete e o save rodavam FORA de transacao e a entrada nao era
    // validada. Com dois registros para o mesmo dia (trivial numa UI que permite
    // adicionar linhas), o delete passava, o insert violava a constraint unica
    // (storeId, dayOfWeek), a mutation dava 500 — e a loja ficava com ZERO
    // horarios. Efeito: availableSlots devolvia [] para todos os dias e a loja
    // parava de aceitar agendamentos em silencio.
    const dias = new Set<number>();
    for (const entry of input.entries) {
      if (!Number.isInteger(entry.dayOfWeek) || entry.dayOfWeek < 0 || entry.dayOfWeek > 6) {
        throw new BadRequestException('Dia da semana invalido (use 0 a 6).');
      }
      if (dias.has(entry.dayOfWeek)) {
        throw new BadRequestException('Ha mais de um horario para o mesmo dia da semana.');
      }
      dias.add(entry.dayOfWeek);
      if (!/^\d{2}:\d{2}$/.test(entry.startTime) || !/^\d{2}:\d{2}$/.test(entry.endTime)) {
        throw new BadRequestException('Horario invalido. Use o formato HH:MM.');
      }
      if (entry.startTime >= entry.endTime) {
        throw new BadRequestException('O horario de inicio deve ser antes do fim.');
      }
    }

    // Tudo ou nada: se o insert falhar, os horarios antigos permanecem.
    return this.schedulesRepository.manager.transaction(async (manager) => {
      await manager.delete(Schedule, { storeId: input.storeId });
      const schedules = input.entries.map((entry) =>
        manager.create(Schedule, {
          storeId: input.storeId,
          dayOfWeek: entry.dayOfWeek,
          startTime: entry.startTime,
          endTime: entry.endTime,
          isActive: entry.isActive,
        }),
      );
      return manager.save(schedules);
    });
  }

  async getByStore(storeId: string): Promise<Schedule[]> {
    return this.schedulesRepository.find({
      where: { storeId },
      order: { dayOfWeek: 'ASC' },
    });
  }
}
