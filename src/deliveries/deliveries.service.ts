import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Delivery } from './entities/delivery.entity';
import { User } from '../users/entities/user.entity';
import { OrdersService } from '../orders/orders.service';
import { OrderStatus } from '../common/enums';

@Injectable()
export class DeliveriesService {
  constructor(
    @InjectRepository(Delivery)
    private deliveriesRepository: Repository<Delivery>,
    private ordersService: OrdersService,
  ) {}

  async acceptDelivery(orderId: string, deliverer: User): Promise<Delivery> {
    const order = await this.ordersService.findById(orderId);

    const delivery = this.deliveriesRepository.create({
      order,
      deliverer,
    });

    await this.ordersService.updateStatus(orderId, OrderStatus.PICKED_UP);
    return this.deliveriesRepository.save(delivery);
  }

  async updateLocation(
    deliveryId: string,
    latitude: number,
    longitude: number,
  ): Promise<Delivery> {
    const delivery = await this.deliveriesRepository.findOne({
      where: { id: deliveryId },
      relations: ['order'],
    });
    if (!delivery) throw new NotFoundException('Entrega nao encontrada');

    delivery.currentLatitude = latitude;
    delivery.currentLongitude = longitude;
    return this.deliveriesRepository.save(delivery);
  }

  async confirmPickup(deliveryId: string): Promise<Delivery> {
    const delivery = await this.deliveriesRepository.findOne({
      where: { id: deliveryId },
      relations: ['order'],
    });
    if (!delivery) throw new NotFoundException('Entrega nao encontrada');

    delivery.pickedUpAt = new Date();
    await this.ordersService.updateStatus(delivery.order.id, OrderStatus.DELIVERING);
    return this.deliveriesRepository.save(delivery);
  }

  async confirmDelivery(deliveryId: string): Promise<Delivery> {
    const delivery = await this.deliveriesRepository.findOne({
      where: { id: deliveryId },
      relations: ['order'],
    });
    if (!delivery) throw new NotFoundException('Entrega nao encontrada');

    delivery.deliveredAt = new Date();
    await this.ordersService.updateStatus(delivery.order.id, OrderStatus.DELIVERED);
    return this.deliveriesRepository.save(delivery);
  }

  async findByDeliverer(delivererId: string): Promise<Delivery[]> {
    return this.deliveriesRepository.find({
      where: { deliverer: { id: delivererId } },
      relations: ['order', 'order.store', 'order.customer'],
      order: { createdAt: 'DESC' },
    });
  }
}
