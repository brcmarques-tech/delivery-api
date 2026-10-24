import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DistanciaService } from './distancia.service';

/**
 * KAN-29. Global porque a distância é usada no cálculo do frete (orders) e na
 * tela de loja (stores), e nada impede que apareça em mais lugares — o cache
 * de cota da ORS só funciona se for UMA instância do serviço para a aplicação
 * inteira.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [DistanciaService],
  exports: [DistanciaService],
})
export class GeoModule {}
