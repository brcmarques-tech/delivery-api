import { Resolver, Query, Mutation, Args, Float, ResolveField, Parent, Context } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { verify as jwtVerify } from 'jsonwebtoken';
import { ServiceRating } from './entities/service-rating.entity';
import { AppUser } from '../users/entities/app-user.entity';
import { Appointment } from '../appointments/entities/appointment.entity';
import { RatingsService } from './ratings.service';
import { CreateServiceRatingInput } from './dto/create-service-rating.input';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../common/enums/user-role.enum';

@Resolver(() => ServiceRating)
export class RatingsResolver {
  constructor(private readonly ratingsService: RatingsService) {}

  // SEGURANCA: `serviceRatings(storeId)` NAO exige autenticacao — e proposital,
  // avaliacoes sao publicas. O problema era o que vinha junto: a entidade expoe
  // `customer` (AppUser inteiro: email e telefone) e `appointment` (endereco do
  // cliente, coordenadas GPS, valor pago, handles do Pagar.me). Qualquer pessoa,
  // sem token, colhia isso de todos os avaliadores de qualquer loja — passando
  // por cima do KAN-225, que ja tinha fechado o acesso direto ao agendamento.
  //
  // A avaliacao continua publica com o que ela precisa mostrar (nota, comentario,
  // fotos, nome e avatar de quem avaliou). O resto so para quem e parte.
  private principal(ctx: any): { sub?: string; role?: string } | null {
    const fromWs = ctx?.wsUser;
    if (fromWs) return fromWs;
    const raw: string =
      ctx?.req?.headers?.authorization || ctx?.req?.headers?.Authorization || '';
    const token = raw.replace(/^Bearer\s+/i, '').trim();
    const secret = process.env.JWT_SECRET;
    if (!token || !secret) return null;
    try {
      return jwtVerify(token, secret) as any;
    } catch {
      return null;
    }
  }

  @ResolveField(() => AppUser)
  customer(@Parent() rating: ServiceRating, @Context() ctx: any): any {
    const p = this.principal(ctx);
    const dono = !!p?.sub && p.sub === (rating as any).customerId;
    if (p?.role === 'SUPERADMIN' || dono) return rating.customer;
    // Visao publica: identidade minima para exibir a avaliacao.
    const c: any = rating.customer || {};
    return {
      ...c,
      email: '',
      phone: '',
      cpf: null,
      identityPhotoUrl: null,
      identityPhotoBackUrl: null,
      birthDate: null,
      cnhNumber: null,
    };
  }

  @ResolveField(() => Appointment, { nullable: true })
  appointment(@Parent() rating: ServiceRating, @Context() ctx: any): any {
    const p = this.principal(ctx);
    const dono = !!p?.sub && p.sub === (rating as any).customerId;
    return p?.role === 'SUPERADMIN' || dono ? rating.appointment : null;
  }

  @Mutation(() => ServiceRating)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.CUSTOMER)
  rateService(
    @Args('input') input: CreateServiceRatingInput,
    @CurrentUser() user: any,
  ): Promise<ServiceRating> {
    return this.ratingsService.rateService(input, user.id);
  }

  @Query(() => [ServiceRating])
  serviceRatings(
    @Args('storeId') storeId: string,
  ): Promise<ServiceRating[]> {
    return this.ratingsService.serviceRatings(storeId);
  }

  @Query(() => Float)
  averageStoreRating(
    @Args('storeId') storeId: string,
  ): Promise<number> {
    return this.ratingsService.averageStoreRating(storeId);
  }

  @Query(() => ServiceRating, { nullable: true })
  @UseGuards(GqlAuthGuard)
  ratingForAppointment(
    @Args('appointmentId') appointmentId: string,
    @CurrentUser() user: any,
  ): Promise<ServiceRating | null> {
    // KAN-225: escopa por dono (cliente que avaliou ou dono da loja)
    return this.ratingsService.ratingForAppointment(appointmentId, user.id);
  }
}
