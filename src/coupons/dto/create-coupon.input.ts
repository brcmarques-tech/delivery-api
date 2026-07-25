import { InputType, Field, Float, Int } from '@nestjs/graphql';
import { IsIn, IsNumber, Min, IsOptional, IsInt } from 'class-validator';

@InputType()
export class CreateCouponInput {
  @Field()
  code: string;

  // Input#4: valida o tipo e barra valores negativos (o cap de 100% em PERCENT
  // é checado no service, mas negativos e tipos inválidos não eram barrados).
  @Field({ defaultValue: 'PERCENT' })
  @IsIn(['PERCENT', 'FIXED'])
  discountType: string;

  @Field(() => Float)
  @IsNumber()
  @Min(0)
  discountValue: number;

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

  @Field(() => Int, { nullable: true, defaultValue: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxUses?: number;

  @Field({ nullable: true })
  expiresAt?: Date;

  @Field()
  storeId: string;
}
