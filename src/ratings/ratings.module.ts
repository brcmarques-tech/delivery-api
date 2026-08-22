import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ServiceRating } from './entities/service-rating.entity';
import { Appointment } from '../appointments/entities/appointment.entity';
import { AppUser } from '../users/entities/app-user.entity';
import { RatingsService } from './ratings.service';
import { RatingsResolver } from './ratings.resolver';

@Module({
  imports: [TypeOrmModule.forFeature([ServiceRating, Appointment, AppUser])],
  providers: [RatingsService, RatingsResolver],
  exports: [RatingsService],
})
export class RatingsModule {}
