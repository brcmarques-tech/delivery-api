import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ServiceRating } from './entities/service-rating.entity';
import { Appointment } from '../appointments/entities/appointment.entity';
import { AppointmentStatus } from '../common/enums/appointment-status.enum';
import { CreateServiceRatingInput } from './dto/create-service-rating.input';

const RELATIONS = ['customer', 'store', 'service', 'appointment'];

@Injectable()
export class RatingsService {
  constructor(
    @InjectRepository(ServiceRating)
    private ratingsRepository: Repository<ServiceRating>,
    @InjectRepository(Appointment)
    private appointmentsRepository: Repository<Appointment>,
  ) {}

  async rateService(input: CreateServiceRatingInput, customerId: string): Promise<ServiceRating> {
    if (input.rating < 1 || input.rating > 5) {
      throw new BadRequestException('Nota deve ser entre 1 e 5');
    }

    const appointment = await this.appointmentsRepository.findOne({
      where: { id: input.appointmentId },
      relations: ['customer', 'store', 'service'],
    });
    if (!appointment) throw new NotFoundException('Agendamento nao encontrado');
    if (appointment.customerId !== customerId) {
      throw new BadRequestException('Sem permissao para avaliar este agendamento');
    }
    if (appointment.status !== AppointmentStatus.COMPLETED) {
      throw new BadRequestException('Apenas agendamentos concluidos podem ser avaliados');
    }

    const existing = await this.ratingsRepository.findOne({
      where: { appointmentId: input.appointmentId },
    });
    if (existing) {
      throw new BadRequestException('Este agendamento ja foi avaliado');
    }

    const rating = this.ratingsRepository.create({
      rating: input.rating,
      comment: input.comment,
      photoUrls: input.photoUrls,
      customerId,
      storeId: appointment.storeId,
      serviceId: appointment.serviceId,
      appointmentId: input.appointmentId,
    });

    const saved = await this.ratingsRepository.save(rating);
    return this.ratingsRepository.findOneOrFail({
      where: { id: saved.id },
      relations: RELATIONS,
    });
  }

  async serviceRatings(storeId: string): Promise<ServiceRating[]> {
    return this.ratingsRepository.find({
      where: { storeId },
      relations: RELATIONS,
      order: { createdAt: 'DESC' },
    });
  }

  async averageStoreRating(storeId: string): Promise<number> {
    const result = await this.ratingsRepository
      .createQueryBuilder('r')
      .select('AVG(r.rating)', 'avg')
      .where('r.storeId = :storeId', { storeId })
      .getRawOne();
    return result?.avg ? parseFloat(result.avg) : 0;
  }

  async totalStoreRatings(storeId: string): Promise<number> {
    return this.ratingsRepository.count({ where: { storeId } });
  }

  /**
   * KAN-262: media e total de avaliacoes de VARIAS lojas em UMA query.
   *
   * `getPublicStores` chamava `averageStoreRating` + `totalStoreRatings` por
   * loja dentro de um `Promise.all` — 2 queries por loja (N+1). Com 3 lojas
   * são 6 idas ao banco; com 300 lojas, 600. Este metodo faz um unico
   * GROUP BY e devolve um mapa por storeId.
   */
  async statsForStores(
    storeIds: string[],
  ): Promise<Map<string, { average: number; total: number }>> {
    const result = new Map<string, { average: number; total: number }>();
    if (storeIds.length === 0) return result;

    const rows = await this.ratingsRepository
      .createQueryBuilder('r')
      .select('r.storeId', 'storeId')
      .addSelect('AVG(r.rating)', 'avg')
      .addSelect('COUNT(r.id)', 'total')
      .where('r.storeId IN (:...storeIds)', { storeIds })
      .groupBy('r.storeId')
      .getRawMany();

    for (const row of rows) {
      result.set(row.storeId, {
        average: row.avg ? parseFloat(row.avg) : 0,
        total: row.total ? parseInt(row.total, 10) : 0,
      });
    }
    return result;
  }

  // KAN-225: escopa por dono — só o cliente que avaliou ou o dono da loja
  // avaliada podem ler a avaliação por appointmentId.
  async ratingForAppointment(
    appointmentId: string,
    userId: string,
  ): Promise<ServiceRating | null> {
    const rating = await this.ratingsRepository.findOne({
      where: { appointmentId },
      relations: [...RELATIONS, 'store.owner'],
    });
    if (!rating) return null;
    const isCustomer = rating.customer?.id === userId;
    const isStoreOwner = rating.store?.owner?.id === userId;
    if (!isCustomer && !isStoreOwner) {
      throw new ForbiddenException('Voce nao tem acesso a esta avaliacao');
    }
    return rating;
  }
}
