import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Schedule } from './entities/schedule.entity';
import { SchedulesService } from './schedules.service';
import { SchedulesResolver } from './schedules.resolver';
import { Store } from '../stores/entities/store.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Schedule, Store])],
  providers: [SchedulesService, SchedulesResolver],
  exports: [SchedulesService],
})
export class SchedulesModule {}
