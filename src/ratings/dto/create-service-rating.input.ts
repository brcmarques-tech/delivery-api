import { InputType, Field, Int } from '@nestjs/graphql';
import {
  ArrayMaxSize,
  IsInt,
  IsOptional,
  IsUrl,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

@InputType()
export class CreateServiceRatingInput {
  @Field()
  appointmentId: string;

  // A faixa ja e checada no service; aqui e so a mesma regra declarada na borda.
  @Field(() => Int)
  @IsInt()
  @Min(1)
  @Max(5)
  rating: number;

  // Nenhum campo tinha validacao, e o ValidationPipe global so aplica as regras
  // que existem. `comment` e coluna `text` e `photoUrls` e `jsonb`, ambos sem
  // teto: cabia um comentario de ~9 MB dentro do limite de body de 10 MB. E esse
  // registro passa a ser devolvido em TODA chamada de `serviceRatings(storeId)`,
  // que e publica e sem guard — qualquer visitante anonimo baixando 9 MB por
  // request na pagina daquela loja.
  @Field({ nullable: true })
  @IsOptional()
  @MaxLength(1000)
  comment?: string;

  // As URLs tambem nao eram validadas: dava para apontar as "fotos da avaliacao"
  // para um dominio de terceiros e rastrear o IP de quem visita a loja, ou
  // trocar o conteudo depois de publicado.
  @Field(() => [String], { nullable: true })
  @IsOptional()
  @ArrayMaxSize(5)
  @IsUrl({ protocols: ['https'], require_protocol: true }, { each: true })
  photoUrls?: string[];
}
