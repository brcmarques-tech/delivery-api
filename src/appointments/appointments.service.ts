import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not, In, IsNull, Between, LessThanOrEqual } from 'typeorm';
import { Appointment } from './entities/appointment.entity';
import { Store } from '../stores/entities/store.entity';
import { Service } from '../services/entities/service.entity';
import { Schedule } from '../schedules/entities/schedule.entity';
import { AppUser } from '../users/entities/app-user.entity';
import { AppointmentStatus } from '../common/enums/appointment-status.enum';
import { businessMinutes, businessToday, businessTodayDate } from '../common/utils/business-time';
import { StoreType } from '../common/enums/store-type.enum';
import { CreateAppointmentInput } from './dto/create-appointment.input';
import { RequestQuoteInput } from './dto/request-quote.input';
import { NotificationsService } from '../notifications/notifications.service';
import { PaymentsService } from '../payments/payments.service';
import { PlatformConfigService } from '../config/platform-config.service';

const RELATIONS = ['customer', 'store', 'store.owner', 'service', 'service.category'];

const STATUS_TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  [AppointmentStatus.PENDING]: [AppointmentStatus.CONFIRMED, AppointmentStatus.CANCELLED],
  [AppointmentStatus.CONFIRMED]: [AppointmentStatus.COMPLETED, AppointmentStatus.CANCELLED, AppointmentStatus.NO_SHOW],
  [AppointmentStatus.CANCELLED]: [],
  [AppointmentStatus.COMPLETED]: [],
  [AppointmentStatus.NO_SHOW]: [],
  [AppointmentStatus.QUOTE_REQUESTED]: [AppointmentStatus.QUOTED, AppointmentStatus.CANCELLED],
  [AppointmentStatus.QUOTED]: [AppointmentStatus.QUOTE_ACCEPTED, AppointmentStatus.QUOTE_REJECTED],
  [AppointmentStatus.QUOTE_ACCEPTED]: [AppointmentStatus.PENDING, AppointmentStatus.CANCELLED],
  [AppointmentStatus.QUOTE_REJECTED]: [],
};

@Injectable()
export class AppointmentsService {
  private readonly logger = new Logger(AppointmentsService.name);

  constructor(
    @InjectRepository(Appointment)
    private appointmentsRepository: Repository<Appointment>,
    @InjectRepository(Store)
    private storesRepository: Repository<Store>,
    @InjectRepository(Service)
    private servicesRepository: Repository<Service>,
    @InjectRepository(Schedule)
    private schedulesRepository: Repository<Schedule>,
    private notificationsService: NotificationsService,
    @Inject(forwardRef(() => PaymentsService))
    private paymentsService: PaymentsService,
    private platformConfigService: PlatformConfigService,
  ) {}

  // ─── Available Slots ────────────────────────────────────

  async availableSlots(storeId: string, serviceId: string, date: string): Promise<string[]> {
    const dateObj = new Date(date + 'T00:00:00');
    if (isNaN(dateObj.getTime())) throw new BadRequestException('Data invalida');

    // BUGFIX: `new Date()` + setHours usava o fuso do PROCESSO, que em producao
    // e UTC. Depois das 21:00 BRT a data UTC ja e o dia seguinte, entao "hoje"
    // era tratado como passado e a agenda do proprio dia retornava vazia. E o
    // nowMinutes em UTC descartava ~3h de horarios ainda validos (a manha
    // inteira sumia da grade). Agora tudo no fuso do negocio.
    const today = businessTodayDate();
    const dateOnly = new Date(date + 'T00:00:00.000Z');
    if (dateOnly < today) return [];

    // BL#2: se a data é HOJE, não oferecer horários que já passaram. Antes só a
    // data era comparada (à meia-noite), então marcar hoje às 09:00 às 15:00 era
    // aceito.
    const isToday = dateOnly.getTime() === today.getTime();
    const nowMinutes = isToday ? businessMinutes() : -1;

    const dayOfWeek = dateObj.getDay();

    const schedule = await this.schedulesRepository.findOne({
      where: { storeId, dayOfWeek, isActive: true },
    });
    if (!schedule) return [];

    const service = await this.servicesRepository.findOne({ where: { id: serviceId } });
    if (!service) throw new NotFoundException('Servico nao encontrado');

    const duration = service.estimatedDuration;

    // Generate all possible slots
    const [startH, startM] = schedule.startTime.split(':').map(Number);
    const [endH, endM] = schedule.endTime.split(':').map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    const slots: string[] = [];
    for (let m = startMinutes; m + duration <= endMinutes; m += duration) {
      const h = Math.floor(m / 60);
      const min = m % 60;
      slots.push(`${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`);
    }

    // Get existing appointments for this date
    const existing = await this.appointmentsRepository.find({
      where: {
        storeId,
        scheduledDate: date,
        status: Not(In([
          AppointmentStatus.CANCELLED,
          AppointmentStatus.NO_SHOW,
          AppointmentStatus.QUOTE_REJECTED,
        ])),
        deletedAt: IsNull(),
      },
    });

    // Filter out overlapping slots
    return slots.filter((slot) => {
      const [slotH, slotM] = slot.split(':').map(Number);
      const slotStart = slotH * 60 + slotM;
      // BL#2: descarta horários já passados quando a data é hoje.
      if (isToday && slotStart < nowMinutes) return false;
      const slotEnd = slotStart + duration;

      return !existing.some((apt) => {
        const [aptH, aptM] = apt.scheduledTime.split(':').map(Number);
        const aptStart = aptH * 60 + aptM;
        const [aptEH, aptEM] = apt.endTime.split(':').map(Number);
        const aptEnd = aptEH * 60 + aptEM;
        return slotStart < aptEnd && slotEnd > aptStart;
      });
    });
  }

  // ─── Create Appointment ─────────────────────────────────

  async create(input: CreateAppointmentInput, customer: AppUser): Promise<Appointment> {
    const store = await this.storesRepository.findOne({
      where: { id: input.storeId },
      relations: ['owner'],
    });
    if (!store) throw new NotFoundException('Loja nao encontrada');
    // A loja desativada pelo superadmin some da vitrine, mas o storeId continua
    // valido: quem tinha o id salvo (historico, deep link, cache do app) seguia
    // criando agendamento normalmente — inclusive gerando cobranca PIX/cartao e
    // notificando um lojista banido. Desativar precisa impedir a entrada de
    // dinheiro e de compromissos novos, nao so esconder a loja.
    if (!store.isActive) {
      throw new BadRequestException('Esta loja nao esta disponivel no momento.');
    }
    if (store.storeType !== StoreType.SERVICES) {
      throw new BadRequestException('Esta loja nao aceita agendamentos');
    }

    const service = await this.servicesRepository.findOne({
      where: { id: input.serviceId, storeId: input.storeId },
    });
    if (!service) throw new NotFoundException('Servico nao encontrado nesta loja');
    if (!service.isAvailable || !service.isActive) {
      throw new BadRequestException('Servico indisponivel');
    }
    if (service.requiresQuote) {
      throw new BadRequestException('Este servico requer orcamento. Use requestQuote.');
    }

    // Validate date
    const dateObj = new Date(input.scheduledDate + 'T00:00:00');
    if (isNaN(dateObj.getTime())) throw new BadRequestException('Data invalida');

    // BUGFIX: idem availableSlots — comparacao de data no fuso do negocio.
    // Em UTC, depois das 21:00 BRT o proprio dia virava "passado".
    const today = businessTodayDate();
    const dateOnlyUtc = new Date(input.scheduledDate + 'T00:00:00.000Z');
    if (dateOnlyUtc < today) throw new BadRequestException('Data nao pode ser no passado');

    const maxDate = new Date();
    maxDate.setDate(maxDate.getDate() + 30);
    if (dateObj > maxDate) throw new BadRequestException('Agendamento maximo de 30 dias');

    // Check slot availability
    const slots = await this.availableSlots(input.storeId, input.serviceId, input.scheduledDate);
    if (!slots.includes(input.scheduledTime)) {
      throw new BadRequestException('Horario indisponivel');
    }

    // Compute endTime
    const [h, m] = input.scheduledTime.split(':').map(Number);
    const endMinutes = h * 60 + m + service.estimatedDuration;
    const endTime = `${String(Math.floor(endMinutes / 60)).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`;

    // Determine payment method
    const paymentMethod = input.paymentMethod || 'ON_SERVICE';
    const isOnlinePayment = paymentMethod === 'PIX' || paymentMethod === 'CREDIT_CARD';

    if (isOnlinePayment && !customer.cpf) {
      throw new BadRequestException('CPF obrigatorio para pagamento online');
    }

    // Compute commission
    let commissionAmount = 0;
    if (isOnlinePayment) {
      const planConfig = await this.platformConfigService.getPlanConfig(store.owner?.vendorPlan as any);
      // `?? 5` (não `|| 5`): PREMIUM/ENTERPRISE/CUSTOM têm commissionPercent 0 —
      // com `||`, o 0 (falsy) virava 5, cobrando 5% de comissão de quem tem 0%
      // contratado. Só usa o default 5 quando o valor é realmente ausente.
      const commissionPercent = planConfig?.commissionPercent ?? 5;
      commissionAmount = Math.round(Number(service.price) * commissionPercent) / 100;
    }

    // Transaction to prevent race condition
    const saved = await this.appointmentsRepository.manager.transaction(async (manager) => {
      const lockedStore = await manager
        .getRepository(Store)
        .createQueryBuilder('store')
        .setLock('pessimistic_write')
        .where('store.id = :id', { id: input.storeId })
        .getOne();

      if (!lockedStore) throw new NotFoundException('Loja nao encontrada');

      // BL#3: re-checagem de conflito dentro da transação por SOBREPOSIÇÃO, não
      // só por horário idêntico. A checagem anterior contava apenas
      // `scheduledTime = X`; serviços de durações diferentes colidiam (ex.: um de
      // 60min às 10:00 [10:00–11:00] e um de 30min às 10:30 [10:30–11:00]) e ambos
      // passavam. `scheduledTime`/`endTime` são 'HH:MM' → comparação lexicográfica
      // equivale à cronológica. Sobrepõe se: existente.início < novo.fim E
      // existente.fim > novo.início.
      const conflict = await manager
        .getRepository(Appointment)
        .createQueryBuilder('apt')
        .where('apt.storeId = :storeId', { storeId: input.storeId })
        .andWhere('apt.scheduledDate = :date', { date: input.scheduledDate })
        .andWhere('apt.deletedAt IS NULL')
        .andWhere('apt.status NOT IN (:...excluded)', {
          excluded: [
            AppointmentStatus.CANCELLED,
            AppointmentStatus.NO_SHOW,
            AppointmentStatus.QUOTE_REJECTED,
          ],
        })
        .andWhere('apt.scheduledTime < :endTime', { endTime })
        .andWhere('apt.endTime > :startTime', { startTime: input.scheduledTime })
        .getCount();
      if (conflict > 0) {
        throw new BadRequestException('Horario ja foi reservado. Escolha outro.');
      }

      lockedStore.lastAppointmentNumber = (lockedStore.lastAppointmentNumber || 0) + 1;
      await manager.getRepository(Store).save(lockedStore);

      const appointmentData: Partial<Appointment> = {
        appointmentNumber: `APT-${String(lockedStore.lastAppointmentNumber).padStart(3, '0')}`,
        customerId: customer.id,
        storeId: input.storeId,
        serviceId: input.serviceId,
        scheduledDate: input.scheduledDate,
        scheduledTime: input.scheduledTime,
        endTime,
        status: AppointmentStatus.PENDING,
        price: service.price,
        notes: input.notes,
        address: input.address,
        latitude: input.latitude,
        longitude: input.longitude,
        paymentMethod,
        paymentStatus: isOnlinePayment ? 'AWAITING_PAYMENT' : 'PENDING',
      };
      if (isOnlinePayment) appointmentData.commissionAmount = commissionAmount;

      const appointment = manager.getRepository(Appointment).create(appointmentData);
      return manager.getRepository(Appointment).save(appointment);
    });

    // Process online payment
    if (isOnlinePayment) {
      const apt = await this.findByIdWithRelations(saved.id);
      try {
        if (paymentMethod === 'PIX') {
          const pixResult = await this.paymentsService.createAppointmentPix(apt, customer);
          await this.appointmentsRepository.update(saved.id, {
            checkoutUrl: pixResult.checkoutUrl,
            pagarmeOrderId: pixResult.preferenceId,
            pixQrCode: pixResult.qrCode,
            pixQrCodeBase64: pixResult.qrCodeUrl,
          });
        } else if (paymentMethod === 'CREDIT_CARD') {
          if (input.cardId || input.cardToken) {
            const chargeResult = await this.paymentsService.createAppointmentDirectCharge(apt, customer, input.cardId, input.cardToken);
            await this.appointmentsRepository.update(saved.id, {
              pagarmeOrderId: chargeResult.pagarmeOrderId,
              preAuthChargeId: chargeResult.chargeId,
              paymentStatus: chargeResult.status === 'pre_authorized' ? 'AWAITING_PAYMENT' : 'PENDING',
            });
          } else {
            const checkoutResult = await this.paymentsService.createAppointmentCheckout(apt, customer);
            await this.appointmentsRepository.update(saved.id, {
              checkoutUrl: checkoutResult.checkoutUrl,
              pagarmeOrderId: checkoutResult.preferenceId,
            });
          }
        }
      } catch (err: any) {
        this.logger.error(`Payment creation failed for appointment ${saved.id}: ${err.message}`);
        // Don't fail the appointment — it stays as AWAITING_PAYMENT
      }
    }

    // Notify vendor (fire-and-forget)
    this.notificationsService.sendToVendorUser(
      store.owner.id,
      'Novo agendamento!',
      `${service.name} em ${input.scheduledDate} as ${input.scheduledTime}`,
      { type: 'APPOINTMENT', appointmentId: saved.id },
    ).catch(() => {});

    return this.findByIdWithRelations(saved.id);
  }

  // ─── Request Quote ──────────────────────────────────────

  async requestQuote(input: RequestQuoteInput, customer: AppUser): Promise<Appointment> {
    const store = await this.storesRepository.findOne({
      where: { id: input.storeId },
      relations: ['owner'],
    });
    if (!store) throw new NotFoundException('Loja nao encontrada');
    // A loja desativada pelo superadmin some da vitrine, mas o storeId continua
    // valido: quem tinha o id salvo (historico, deep link, cache do app) seguia
    // criando agendamento normalmente — inclusive gerando cobranca PIX/cartao e
    // notificando um lojista banido. Desativar precisa impedir a entrada de
    // dinheiro e de compromissos novos, nao so esconder a loja.
    if (!store.isActive) {
      throw new BadRequestException('Esta loja nao esta disponivel no momento.');
    }
    if (store.storeType !== StoreType.SERVICES) {
      throw new BadRequestException('Esta loja nao aceita agendamentos');
    }

    const service = await this.servicesRepository.findOne({
      where: { id: input.serviceId, storeId: input.storeId },
    });
    if (!service) throw new NotFoundException('Servico nao encontrado nesta loja');
    if (!service.requiresQuote) {
      throw new BadRequestException('Este servico nao requer orcamento. Use createAppointment.');
    }

    // Transaction for appointment number
    const saved = await this.appointmentsRepository.manager.transaction(async (manager) => {
      const lockedStore = await manager
        .getRepository(Store)
        .createQueryBuilder('store')
        .setLock('pessimistic_write')
        .where('store.id = :id', { id: input.storeId })
        .getOne();

      if (!lockedStore) throw new NotFoundException('Loja nao encontrada');
      lockedStore.lastAppointmentNumber = (lockedStore.lastAppointmentNumber || 0) + 1;
      await manager.getRepository(Store).save(lockedStore);

      const appointment = manager.getRepository(Appointment).create({
        appointmentNumber: `APT-${String(lockedStore.lastAppointmentNumber).padStart(3, '0')}`,
        customerId: customer.id,
        storeId: input.storeId,
        serviceId: input.serviceId,
        scheduledDate: '',
        scheduledTime: '',
        endTime: '',
        status: AppointmentStatus.QUOTE_REQUESTED,
        quoteDescription: input.description,
        address: input.address,
        latitude: input.latitude,
        longitude: input.longitude,
        paymentMethod: 'ON_SERVICE',
      });

      return manager.getRepository(Appointment).save(appointment);
    });

    // Notify vendor
    this.notificationsService.sendToVendorUser(
      store.owner.id,
      'Novo pedido de orcamento!',
      `${service.name} — "${input.description.substring(0, 50)}"`,
      { type: 'APPOINTMENT', appointmentId: saved.id },
    ).catch(() => {});

    return this.findByIdWithRelations(saved.id);
  }

  // ─── Respond Quote (Vendor) ─────────────────────────────

  async respondQuote(id: string, price: number, response: string, vendorId: string): Promise<Appointment> {
    const appointment = await this.findByIdWithRelations(id);
    this.validateStoreOwner(appointment, vendorId);
    this.validateTransition(appointment.status, AppointmentStatus.QUOTED);

    appointment.price = price;
    appointment.quoteResponse = response;
    appointment.status = AppointmentStatus.QUOTED;
    await this.appointmentsRepository.save(appointment);

    this.notificationsService.sendToAppUser(
      appointment.customerId,
      'Orcamento recebido!',
      `${appointment.service.name} — R$ ${Number(price).toFixed(2)}`,
      { type: 'APPOINTMENT', appointmentId: id },
    ).catch(() => {});

    return appointment;
  }

  // ─── Accept Quote (Customer) ────────────────────────────

  async acceptQuote(
    id: string,
    scheduledDate: string,
    scheduledTime: string,
    customerId: string,
  ): Promise<Appointment> {
    const appointment = await this.findByIdWithRelations(id);
    this.validateCustomer(appointment, customerId);
    this.validateTransition(appointment.status, AppointmentStatus.QUOTE_ACCEPTED);

    // BUGFIX: o create() bloqueia loja desativada e teto de 30 dias, mas o
    // acceptQuote nao — depois de o superadmin banir a loja, o cliente ainda
    // conseguia aceitar o orcamento e entrar um compromisso numa loja banida; e
    // sem o teto dava para aceitar um orcamento para centenas de dias a frente.
    const dateObj = new Date(scheduledDate + 'T00:00:00');
    if (isNaN(dateObj.getTime())) throw new BadRequestException('Data invalida');
    const maxDate = new Date();
    maxDate.setDate(maxDate.getDate() + 30);
    if (dateObj > maxDate) throw new BadRequestException('Agendamento maximo de 30 dias');

    const slots = await this.availableSlots(appointment.storeId, appointment.serviceId, scheduledDate);
    if (!slots.includes(scheduledTime)) {
      throw new BadRequestException('Horario indisponivel');
    }

    const [h, m] = scheduledTime.split(':').map(Number);
    const endMinutes = h * 60 + m + appointment.service.estimatedDuration;
    const endTime = `${String(Math.floor(endMinutes / 60)).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`;

    // A checagem acima e um classico check-then-act: `availableSlots` e o `save`
    // ficavam fora de qualquer transacao, sem lock. Dois clientes com orcamento
    // na mesma loja aceitando o mesmo horario viam ambos o slot livre e ambos
    // gravavam. Pior: o lock de `create()` nao protegia nada contra este
    // caminho, porque este escritor nao o respeitava — dava para `create` e
    // `acceptQuote` gravarem o mesmo horario um por cima do outro. Agora usamos
    // a mesma transacao: lock na loja e re-checagem por SOBREPOSICAO (nao so por
    // horario identico, para cobrir duracoes diferentes).
    await this.appointmentsRepository.manager.transaction(async (manager) => {
      const lockedStore = await manager
        .getRepository(Store)
        .createQueryBuilder('store')
        .setLock('pessimistic_write')
        .where('store.id = :id', { id: appointment.storeId })
        .getOne();
      if (!lockedStore) throw new NotFoundException('Loja nao encontrada');
      // BUGFIX: loja banida/desativada nao pode receber compromisso novo (mesma
      // regra do create). Checado aqui, com a loja ja travada na transacao.
      if (!lockedStore.isActive) {
        throw new BadRequestException('Esta loja nao esta disponivel no momento.');
      }

      const conflict = await manager
        .getRepository(Appointment)
        .createQueryBuilder('apt')
        .where('apt.storeId = :storeId', { storeId: appointment.storeId })
        .andWhere('apt.id != :selfId', { selfId: appointment.id })
        .andWhere('apt.scheduledDate = :date', { date: scheduledDate })
        .andWhere('apt.deletedAt IS NULL')
        .andWhere('apt.status NOT IN (:...excluded)', {
          excluded: [
            AppointmentStatus.CANCELLED,
            AppointmentStatus.NO_SHOW,
            AppointmentStatus.QUOTE_REJECTED,
          ],
        })
        .andWhere('apt.scheduledTime < :endTime', { endTime })
        .andWhere('apt.endTime > :startTime', { startTime: scheduledTime })
        .getCount();
      if (conflict > 0) {
        throw new BadRequestException('Horario ja foi reservado. Escolha outro.');
      }

      appointment.scheduledDate = scheduledDate;
      appointment.scheduledTime = scheduledTime;
      appointment.endTime = endTime;
      appointment.status = AppointmentStatus.PENDING;
      await manager.getRepository(Appointment).save(appointment);
    });

    this.notificationsService.sendToVendorUser(
      appointment.store.owner.id,
      'Orcamento aceito!',
      `${appointment.service.name} em ${scheduledDate} as ${scheduledTime}`,
      { type: 'APPOINTMENT', appointmentId: id },
    ).catch(() => {});

    return appointment;
  }

  // ─── Reject Quote (Customer) ────────────────────────────

  async rejectQuote(id: string, customerId: string): Promise<Appointment> {
    const appointment = await this.findByIdWithRelations(id);
    this.validateCustomer(appointment, customerId);
    this.validateTransition(appointment.status, AppointmentStatus.QUOTE_REJECTED);

    appointment.status = AppointmentStatus.QUOTE_REJECTED;
    await this.appointmentsRepository.save(appointment);

    this.notificationsService.sendToVendorUser(
      appointment.store.owner.id,
      'Orcamento recusado',
      `${appointment.service.name} — ${appointment.appointmentNumber}`,
      { type: 'APPOINTMENT', appointmentId: id },
    ).catch(() => {});

    return appointment;
  }

  // ─── Status Transitions ─────────────────────────────────

  async confirmAppointment(id: string, vendorId: string): Promise<Appointment> {
    const appointment = await this.findByIdWithRelations(id);
    this.validateStoreOwner(appointment, vendorId);
    this.validateTransition(appointment.status, AppointmentStatus.CONFIRMED);

    appointment.status = AppointmentStatus.CONFIRMED;
    await this.appointmentsRepository.save(appointment);

    this.notificationsService.sendToAppUser(
      appointment.customerId,
      'Agendamento confirmado!',
      `${appointment.service.name} em ${appointment.scheduledDate} as ${appointment.scheduledTime}`,
      { type: 'APPOINTMENT', appointmentId: id },
    ).catch(() => {});

    return appointment;
  }

  async cancelAppointment(id: string, customerId: string): Promise<Appointment> {
    const appointment = await this.findByIdWithRelations(id);
    this.validateCustomer(appointment, customerId);
    this.validateTransition(appointment.status, AppointmentStatus.CANCELLED);

    appointment.status = AppointmentStatus.CANCELLED;
    await this.appointmentsRepository.save(appointment);

    // O cancelamento nao mexia no dinheiro: no cartao os R$ ficavam bloqueados
    // no limite do cliente ate a pre-autorizacao caducar sozinha, e no PIX (ja
    // pago de verdade) o valor ficava parado na plataforma sem nenhum caminho de
    // devolucao. Nao bloqueia o cancelamento se o estorno falhar — o erro fica
    // logado para reprocessamento.
    await this.paymentsService
      .releaseAppointmentPayment(appointment)
      .catch((err) =>
        this.logger.error(
          `Falha ao liberar pagamento do agendamento ${appointment.appointmentNumber}: ${err?.message}`,
        ),
      );

    this.notificationsService.sendToVendorUser(
      appointment.store.owner.id,
      'Agendamento cancelado',
      `Cliente cancelou ${appointment.appointmentNumber} — ${appointment.service.name}`,
      { type: 'APPOINTMENT', appointmentId: id },
    ).catch(() => {});

    return appointment;
  }

  async vendorCancelAppointment(id: string, vendorId: string): Promise<Appointment> {
    const appointment = await this.findByIdWithRelations(id);
    this.validateStoreOwner(appointment, vendorId);
    this.validateTransition(appointment.status, AppointmentStatus.CANCELLED);

    appointment.status = AppointmentStatus.CANCELLED;
    await this.appointmentsRepository.save(appointment);

    // O cancelamento nao mexia no dinheiro: no cartao os R$ ficavam bloqueados
    // no limite do cliente ate a pre-autorizacao caducar sozinha, e no PIX (ja
    // pago de verdade) o valor ficava parado na plataforma sem nenhum caminho de
    // devolucao. Nao bloqueia o cancelamento se o estorno falhar — o erro fica
    // logado para reprocessamento.
    await this.paymentsService
      .releaseAppointmentPayment(appointment)
      .catch((err) =>
        this.logger.error(
          `Falha ao liberar pagamento do agendamento ${appointment.appointmentNumber}: ${err?.message}`,
        ),
      );

    this.notificationsService.sendToAppUser(
      appointment.customerId,
      'Agendamento cancelado pelo prestador',
      `${appointment.service.name} — ${appointment.appointmentNumber}`,
      { type: 'APPOINTMENT', appointmentId: id },
    ).catch(() => {});

    return appointment;
  }

  async completeAppointment(id: string, vendorId: string): Promise<Appointment> {
    const appointment = await this.findByIdWithRelations(id);
    this.validateStoreOwner(appointment, vendorId);
    this.validateTransition(appointment.status, AppointmentStatus.COMPLETED);

    appointment.status = AppointmentStatus.COMPLETED;
    await this.appointmentsRepository.save(appointment);

    // Settle online payment (fire-and-forget)
    if (appointment.paymentMethod === 'PIX' || appointment.paymentMethod === 'CREDIT_CARD') {
      this.paymentsService.settleAppointmentPayment(appointment).catch((err) => {
        this.logger.error(`Settlement failed for appointment ${appointment.appointmentNumber}: ${err.message}`);
      });
    }

    this.notificationsService.sendToAppUser(
      appointment.customerId,
      'Servico concluido!',
      `${appointment.service.name} — ${appointment.appointmentNumber}`,
      { type: 'APPOINTMENT', appointmentId: id },
    ).catch(() => {});

    return appointment;
  }

  async markNoShow(id: string, vendorId: string): Promise<Appointment> {
    const appointment = await this.findByIdWithRelations(id);
    this.validateStoreOwner(appointment, vendorId);
    this.validateTransition(appointment.status, AppointmentStatus.NO_SHOW);

    appointment.status = AppointmentStatus.NO_SHOW;
    await this.appointmentsRepository.save(appointment);

    return appointment;
  }

  // ─── Queries ────────────────────────────────────────────

  // Perf (F6): paginado (limit/offset), teto 100.
  async myAppointments(customerId: string, limit = 20, offset = 0): Promise<Appointment[]> {
    return this.appointmentsRepository.find({
      where: { customerId, deletedAt: IsNull() },
      relations: RELATIONS,
      order: { createdAt: 'DESC' },
      take: Math.min(Math.max(limit ?? 20, 1), 100),
      skip: Math.max(offset ?? 0, 0),
    });
  }

  async storeAppointments(
    storeId: string,
    vendorId: string,
    date?: string,
    status?: AppointmentStatus,
  ): Promise<Appointment[]> {
    const store = await this.storesRepository.findOne({
      where: { id: storeId },
      relations: ['owner'],
    });
    if (!store) throw new NotFoundException('Loja nao encontrada');
    if (store.owner.id !== vendorId) {
      throw new BadRequestException('Sem permissao');
    }

    const where: any = { storeId, deletedAt: IsNull() };
    if (date) where.scheduledDate = date;
    if (status) where.status = status;

    return this.appointmentsRepository.find({
      where,
      relations: RELATIONS,
      order: { scheduledDate: 'ASC', scheduledTime: 'ASC' },
    });
  }

  async findById(id: string): Promise<Appointment> {
    const appointment = await this.appointmentsRepository.findOne({
      where: { id, deletedAt: IsNull() },
      relations: RELATIONS,
    });
    if (!appointment) throw new NotFoundException('Agendamento nao encontrado');
    return appointment;
  }

  // KAN-225: leitura escopada por dono. So o cliente do agendamento ou o dono
  // da loja podem ler; qualquer outro usuario autenticado recebe 403 (antes a
  // query `appointment(id)` retornava dados de terceiros por id — vazava PII).
  async findByIdForUser(id: string, userId: string): Promise<Appointment> {
    const appointment = await this.findById(id);
    const isCustomer = appointment.customer?.id === userId;
    const isStoreOwner = appointment.store?.owner?.id === userId;
    if (!isCustomer && !isStoreOwner) {
      throw new ForbiddenException('Voce nao tem acesso a este agendamento');
    }
    return appointment;
  }

  // ─── Expiracao por falta de pagamento ───────────────────

  /**
   * Cancela agendamentos que nunca foram pagos, liberando o horario.
   *
   * Pedidos ja tinham `expireAwaitingPaymentOrders`; agendamentos NAO tinham
   * equivalente. O agendamento nasce PENDING antes de o pagamento existir, e
   * `availableSlots` so ignora CANCELLED/NO_SHOW/QUOTE_REJECTED — entao um
   * AWAITING_PAYMENT ocupava a grade indefinidamente. Bastava criar uma conta e
   * chamar `createAppointment(PIX)` para cada slot dos proximos 30 dias, sem
   * pagar nenhum, para deixar a agenda inteira da loja indisponivel para
   * clientes reais, de graca, sem nenhuma rotina que limpasse. Os 30 min
   * acompanham a validade do QR do PIX.
   */
  async expireUnpaidAppointments(): Promise<number> {
    const trintaMinAtras = new Date(Date.now() - 30 * 60 * 1000);
    const vencidos = await this.appointmentsRepository.find({
      where: {
        paymentStatus: 'AWAITING_PAYMENT',
        // BUGFIX: cartao PRE-AUTORIZADO grava paymentStatus 'AWAITING_PAYMENT'
        // igual ao PIX aguardando scan, mas a pre-auth JA e uma garantia — o
        // cliente fez a parte dele. A janela de 30 min acompanha a validade do QR
        // do PIX; aplica-la ao cartao cancelava sozinho, em 30 min, um agendamento
        // com pagamento garantido so porque o vendedor ainda nao confirmou.
        // preAuthChargeId IsNull deixa passar so o PIX de fato nao pago. (A
        // eventual liberacao de pre-auths nunca confirmadas e outra rotina/decisao.)
        preAuthChargeId: IsNull(),
        status: In([
          AppointmentStatus.PENDING,
          AppointmentStatus.QUOTE_ACCEPTED,
        ]),
        createdAt: LessThanOrEqual(trintaMinAtras),
        deletedAt: IsNull(),
      },
    });

    for (const apt of vencidos) {
      apt.status = AppointmentStatus.CANCELLED;
      await this.appointmentsRepository.save(apt);
      this.logger.log(
        `Agendamento ${apt.appointmentNumber} cancelado por falta de pagamento — horario liberado`,
      );
      this.notificationsService
        .sendToAppUser(
          apt.customerId,
          'Agendamento cancelado',
          `${apt.appointmentNumber} foi cancelado porque o pagamento nao foi concluido.`,
          { type: 'APPOINTMENT', appointmentId: apt.id },
        )
        .catch(() => {});
    }
    return vencidos.length;
  }

  // ─── Reminder ───────────────────────────────────────────

  async sendUpcomingReminders(): Promise<number> {
    // BUGFIX: o comentario antigo dizia "server runs in BRT" — em producao NAO
    // roda (TZ=UTC). O lembrete de 1 hora era calculado em UTC contra horarios
    // de parede brasileiros: disparava ~4h adiantado (e marcava reminderSent,
    // entao o lembrete de verdade nunca chegava), e agendamento a partir das
    // ~21:00 BRT nunca era encontrado porque a data UTC ja era a de amanha.
    const now = new Date();
    const todayStr = businessToday(now);

    const nowMinutes = businessMinutes(now);
    const targetMin = nowMinutes + 55;
    const targetMax = nowMinutes + 65;

    // Find CONFIRMED appointments for today that haven't been reminded
    const appointments = await this.appointmentsRepository.find({
      where: {
        scheduledDate: todayStr,
        status: AppointmentStatus.CONFIRMED,
        reminderSent: false,
        deletedAt: IsNull(),
      },
      relations: RELATIONS,
    });

    let count = 0;
    for (const apt of appointments) {
      const [h, m] = apt.scheduledTime.split(':').map(Number);
      const aptMinutes = h * 60 + m;
      if (aptMinutes >= targetMin && aptMinutes <= targetMax) {
        this.notificationsService.sendToAppUser(
          apt.customerId,
          'Lembrete: agendamento em 1 hora!',
          `${apt.service.name} as ${apt.scheduledTime} — ${apt.store.name}`,
          { type: 'APPOINTMENT', appointmentId: apt.id },
        ).catch(() => {});

        apt.reminderSent = true;
        await this.appointmentsRepository.save(apt);
        count++;
      }
    }
    return count;
  }

  // ─── Helpers ────────────────────────────────────────────

  private async findByIdWithRelations(id: string): Promise<Appointment> {
    const appointment = await this.appointmentsRepository.findOne({
      where: { id, deletedAt: IsNull() },
      relations: RELATIONS,
    });
    if (!appointment) throw new NotFoundException('Agendamento nao encontrado');
    return appointment;
  }

  private validateTransition(current: AppointmentStatus, target: AppointmentStatus): void {
    const allowed = STATUS_TRANSITIONS[current];
    if (!allowed || !allowed.includes(target)) {
      throw new BadRequestException(`Transicao de ${current} para ${target} nao permitida`);
    }
  }

  private validateStoreOwner(appointment: Appointment, vendorId: string): void {
    if (appointment.store.owner.id !== vendorId) {
      throw new BadRequestException('Sem permissao para este agendamento');
    }
  }

  private validateCustomer(appointment: Appointment, customerId: string): void {
    if (appointment.customerId !== customerId) {
      throw new BadRequestException('Sem permissao para este agendamento');
    }
  }

  // ─── Analytics ────────────────────────────────────────

  async analyticsTotalCount(): Promise<number> {
    return this.appointmentsRepository.count();
  }

  async analyticsTotalRevenue(): Promise<number> {
    const result = await this.appointmentsRepository
      .createQueryBuilder('apt')
      .select('COALESCE(SUM(apt.price), 0)', 'total')
      .where('apt.status = :status', { status: AppointmentStatus.COMPLETED })
      .getRawOne();
    return parseFloat(result.total);
  }

  async analyticsCountByStatus(): Promise<{ status: string; count: number }[]> {
    return this.appointmentsRepository
      .createQueryBuilder('apt')
      .select('apt.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('apt.status')
      .getRawMany();
  }
}
