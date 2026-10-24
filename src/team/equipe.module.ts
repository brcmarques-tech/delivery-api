import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { VendorTeamMember } from './entities/vendor-team-member.entity';
import { Store } from '../stores/entities/store.entity';
import { VendorUser } from '../users/entities/vendor-user.entity';
import { EquipeService } from './equipe.service';
import { EquipeResolver } from './equipe.resolver';
import { MailModule } from '../mail/mail.module';

/**
 * KAN-82. GLOBAL de propósito: a pergunta "este usuário pode agir nesta loja?"
 * aparece em pedidos, produtos, promoções, cupons, categorias, serviços,
 * agendamentos e agenda. Importar o módulo em cada um deles criaria um nó de
 * dependências (e ciclos) sem ganho nenhum — a autorização é infraestrutura,
 * como o banco.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([VendorTeamMember, Store, VendorUser]), MailModule],
  providers: [EquipeService, EquipeResolver],
  exports: [EquipeService],
})
export class EquipeModule {}
