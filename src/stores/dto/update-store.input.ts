import { InputType, Field, Float } from '@nestjs/graphql';
import { IsOptional, Matches, IsIn } from 'class-validator';
import { StoreType } from '../../common/enums';

@InputType()
export class UpdateStoreInput {
  @Field()
  id: string;

  @Field({ nullable: true })
  @IsOptional()
  name?: string;

  @Field({ nullable: true })
  @IsOptional()
  description?: string;

  @Field({ nullable: true })
  @IsOptional()
  phone?: string;

  @Field({ nullable: true })
  @IsOptional()
  whatsappNumber?: string;

  @Field({ nullable: true })
  @IsOptional()
  street?: string;

  @Field({ nullable: true })
  @IsOptional()
  number?: string;

  @Field({ nullable: true })
  @IsOptional()
  complement?: string;

  @Field({ nullable: true })
  @IsOptional()
  neighborhood?: string;

  @Field({ nullable: true })
  @IsOptional()
  city?: string;

  @Field({ nullable: true })
  @IsOptional()
  state?: string;

  @Field({ nullable: true })
  @IsOptional()
  zipCode?: string;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  deliveryFee?: number;

  @Field({ nullable: true })
  @IsOptional()
  estimatedDeliveryMinutes?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  minimumOrder?: number;

  @Field({ nullable: true })
  @IsOptional()
  hasOwnDelivery?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  freeDelivery?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  deliveryStartTime?: string;

  @Field({ nullable: true })
  @IsOptional()
  deliveryEndTime?: string;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  freeDeliveryAbove?: number;

  @Field({ nullable: true })
  @IsOptional()
  logoUrl?: string;

  @Field({ nullable: true })
  @IsOptional()
  bannerUrl?: string;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  latitude?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  longitude?: number;

  @Field(() => StoreType, { nullable: true })
  @IsOptional()
  storeType?: StoreType;

  // ─── KAN-13: identidade visual ──────────────────────────────────────────
  //
  // Hexadecimal (#RGB, #RRGGBB ou #RRGGBBAA), validado aqui e DE NOVO no
  // service — aqui para a mensagem ser boa, la porque regra de dado nao pode
  // depender so do DTO (mutation direta existe).
  //
  // String vazia = voltar ao tema da plataforma. Sem isso, quem escolheu uma
  // cor ficaria preso a ela para sempre.
  @Field({ nullable: true })
  @IsOptional()
  @Matches(/^(#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8}))?$/, {
    message: 'primaryColor deve ser uma cor hexadecimal, como #FF6B35',
  })
  primaryColor?: string;

  @Field({ nullable: true })
  @IsOptional()
  @Matches(/^(#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8}))?$/, {
    message: 'backgroundColor deve ser uma cor hexadecimal, como #FFFFFF',
  })
  backgroundColor?: string;

  @Field({ nullable: true })
  @IsOptional()
  @Matches(/^(#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8}))?$/, {
    message: 'textColor deve ser uma cor hexadecimal, como #111111',
  })
  textColor?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsIn(['GRID', 'LIST', ''], { message: 'productLayout deve ser GRID ou LIST' })
  productLayout?: string;
}
