import { InputType, Field, Float, ObjectType, Int } from '@nestjs/graphql';
import { IsNotEmpty, IsOptional } from 'class-validator';

@InputType()
export class BulkProductItem {
  @Field()
  @IsNotEmpty()
  name: string;

  @Field({ nullable: true })
  @IsOptional()
  description?: string;

  @Field(() => Float)
  price: number;

  @Field({ nullable: true })
  @IsOptional()
  imageUrl?: string;

  @Field({ nullable: true })
  @IsOptional()
  unit?: string;

  @Field({ nullable: true })
  @IsOptional()
  categoryId?: string;

  @Field({ nullable: true, defaultValue: 0 })
  @IsOptional()
  stock?: number;

  @Field({ nullable: true })
  @IsOptional()
  barcode?: string;

  @Field({ nullable: true, defaultValue: false })
  @IsOptional()
  isVariableWeight?: boolean;
}

@InputType()
export class BulkCreateProductsInput {
  @Field()
  storeId: string;

  @Field(() => [BulkProductItem])
  products: BulkProductItem[];
}

@ObjectType()
export class BulkImportResult {
  @Field(() => Int)
  created: number;

  @Field(() => [String])
  errors: string[];
}
