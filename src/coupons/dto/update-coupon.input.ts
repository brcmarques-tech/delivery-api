import { InputType, Field, Float, Int } from '@nestjs/graphql';
import { IsIn, IsNumber, Min, IsOptional, IsInt } from 'class-validator';

@InputType()
export class UpdateCouponInput {
  @Field()
  id: string;

  @Field({ nullable: true })
  code?: string;

  // BUGFIX: o update nao tinha NENHUMA validacao (o create tem). Dava para gravar
  // discountValue/minimumOrder/maxDiscount/maxUses NEGATIVOS e um discountType
  // arbitrario. Um cupom FIXED com discountValue -100 fazia o total do pedido
  // subir R$100 (subtotal - (-100)) e inflava a comissao. Mesmas regras do create.
  @Field({ nullable: true })
  @IsOptional()
  @IsIn(['PERCENT', 'FIXED'])
  discountType?: string;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  discountValue?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  minimumOrder?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  maxDiscount?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxUses?: number;

  @Field({ nullable: true })
  expiresAt?: Date;
}
