import { InputType, Field, Float, ObjectType, Int } from '@nestjs/graphql';
import {
  IsNotEmpty,
  IsOptional,
  IsNumber,
  IsInt,
  Min,
  ValidateNested,
  ArrayNotEmpty,
} from 'class-validator';
import { Type } from 'class-transformer';

@InputType()
export class BulkProductItem {
  @Field()
  @IsNotEmpty()
  name: string;

  @Field({ nullable: true })
  @IsOptional()
  description?: string;

  // Mesmas regras do cadastro individual (KAN-253). Preco negativo num pedido
  // ABATE o subtotal dos outros itens e distorce a comissao.
  @Field(() => Float)
  @IsNumber()
  @Min(0, { message: 'O preco nao pode ser negativo' })
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

  // @IsInt porque a coluna `stock` e integer: sem isso o unico "validador" era o
  // erro de sintaxe do Postgres, que aborta a linha com uma mensagem crua.
  @Field({ nullable: true, defaultValue: 0 })
  @IsOptional()
  @IsInt({ message: 'O estoque deve ser um numero inteiro' })
  @Min(0, { message: 'O estoque nao pode ser negativo' })
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

  // SEM @ValidateNested + @Type, o class-validator NAO desce nos itens do array:
  // todos os decorators de BulkProductItem eram decoracao pura. Dava para
  // importar preco negativo e estoque negativo por aqui — exatamente o que o
  // KAN-253 fechou no cadastro individual, reaberto pela importacao em massa.
  @Field(() => [BulkProductItem])
  @ArrayNotEmpty({ message: 'Envie ao menos um produto' })
  @ValidateNested({ each: true })
  @Type(() => BulkProductItem)
  products: BulkProductItem[];
}

@ObjectType()
export class BulkImportResult {
  @Field(() => Int)
  created: number;

  @Field(() => [String])
  errors: string[];
}
