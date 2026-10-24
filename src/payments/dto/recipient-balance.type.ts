import { ObjectType, Field, Float } from '@nestjs/graphql';

@ObjectType()
export class RecipientBalance {
  @Field(() => Float)
  availableAmount: number;

  @Field(() => Float)
  waitingFundsAmount: number;

  @Field(() => Float)
  transferredAmount: number;

  @Field()
  autoAnticipationEnabled: boolean;
}

@ObjectType()
export class AnticipationSimulation {
  @Field(() => Float)
  originalAmount: number;

  @Field(() => Float)
  anticipatedAmount: number;

  @Field(() => Float)
  fee: number;

  @Field(() => Float)
  feePercentage: number;

  /**
   * true = estes valores NAO vieram do Pagar.me; sao um chute do nosso lado.
   *
   * Existe porque o fallback de `simulateAnticipation` devolvia uma taxa fixa de
   * 3,5% com exatamente a mesma forma de uma cotacao real, e a tela mostrava
   * "Voce recebe R$ X" em destaque. O lojista/entregador nao tinha como saber
   * que aquele numero era inventado pelo nosso codigo — e hoje ele SEMPRE e,
   * porque a rota de antecipacao usada esta errada (ver o comentario em
   * simulateAnticipation). Numero de dinheiro sem procedencia nao pode ser
   * apresentado como cotacao.
   */
  @Field(() => Boolean)
  isEstimate: boolean;
}

@ObjectType()
export class AnticipationResult {
  @Field()
  id: string;

  @Field()
  status: string;

  @Field(() => Float)
  requestedAmount: number;

  @Field(() => Float)
  approvedAmount: number;

  @Field(() => Float)
  fee: number;

  @Field()
  createdAt: string;
}
