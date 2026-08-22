import { ObjectType, Field, Int } from '@nestjs/graphql';
import { AppUser } from '../entities/app-user.entity';
import { VendorUser } from '../entities/vendor-user.entity';

/**
 * KAN-292: paginacao no servidor do painel de Usuarios. Antes a tela puxava
 * allAppUsers + allVendorUsers (as duas tabelas INTEIRAS) e separava por papel /
 * buscava no cliente.
 */
@ObjectType()
export class AppUserPage {
  @Field(() => [AppUser])
  items: AppUser[];

  @Field(() => Int)
  total: number;

  @Field()
  hasMore: boolean;
}

@ObjectType()
export class VendorUserPage {
  @Field(() => [VendorUser])
  items: VendorUser[];

  @Field(() => Int)
  total: number;

  @Field()
  hasMore: boolean;
}

/** Contagens por aba para os badges (independem da pagina/busca). */
@ObjectType()
export class UserRoleCounts {
  @Field(() => Int)
  customers: number;

  @Field(() => Int)
  deliverers: number;

  @Field(() => Int)
  admins: number;

  @Field(() => Int)
  vendors: number;
}
