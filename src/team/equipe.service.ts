import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { createHash, randomBytes } from 'crypto';
import {
  VendorTeamMember,
  ModuloDaLoja,
  PapelNaEquipe,
} from './entities/vendor-team-member.entity';
import { Store } from '../stores/entities/store.entity';
import { VendorUser } from '../users/entities/vendor-user.entity';
import { MailService } from '../mail/mail.service';

/**
 * KAN-82 — quem pode o quê dentro de uma loja.
 *
 * ─── A REGRA ────────────────────────────────────────────────────────────────
 *
 *   DONO .......... pode tudo, sempre. Não precisa de linha nenhuma nesta
 *                   tabela e não pode ser removido.
 *   MANAGER ....... os módulos liberados + gerenciar a equipe.
 *   EMPLOYEE ...... só os módulos liberados.
 *
 * ─── POR QUE ISTO É UM SERVIÇO, E NÃO UM GUARD SOZINHO ──────────────────────
 *
 * A autorização de loja no projeto sempre foi `store.owner.id !== userId`,
 * repetida em 31 lugares. Trocar isso por um guard de rota não resolveria:
 * metade das checagens está DENTRO do service, depois de carregar o pedido ou
 * o cupom para descobrir de que loja ele é. Então a peça central é uma função
 * — `exigirPermissao` — chamada exatamente onde a checagem antiga estava.
 *
 * A mensagem de erro é a MESMA de antes ("Voce nao tem permissao...") de
 * propósito: quem não tem acesso não deve conseguir distinguir "não é da
 * loja" de "é da equipe mas sem este módulo" — isso mapeia a estrutura da
 * loja para quem está sondando.
 */
@Injectable()
export class EquipeService {
  private readonly logger = new Logger(EquipeService.name);

  /** Validade do convite. Curta: convite é direito de acesso. */
  private static readonly DIAS_DE_CONVITE = 7;

  constructor(
    @InjectRepository(VendorTeamMember)
    private readonly equipeRepository: Repository<VendorTeamMember>,
    @InjectRepository(Store)
    private readonly storesRepository: Repository<Store>,
    @InjectRepository(VendorUser)
    private readonly vendorsRepository: Repository<VendorUser>,
    private readonly mailService: MailService,
  ) {}

  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** Dono da loja? */
  private async ehDono(userId: string, storeId: string): Promise<boolean> {
    const n = await this.storesRepository.count({
      where: { id: storeId, owner: { id: userId } } as any,
    });
    return n > 0;
  }

  /** Vínculo ATIVO (aceito e não revogado) do usuário com a loja. */
  async vinculoAtivo(userId: string, storeId: string): Promise<VendorTeamMember | null> {
    return this.equipeRepository.findOne({
      where: {
        storeId,
        memberId: userId,
        revokedAt: IsNull(),
      } as any,
    });
  }

  /**
   * Pode agir nesta loja neste módulo? Dono sempre pode.
   *
   * `modulo` opcional: quando ausente, a pergunta é só "faz parte da loja?" —
   * usado em leituras amplas (ex.: abrir o painel da loja).
   */
  async podeGerenciar(
    userId: string,
    storeId: string,
    modulo?: ModuloDaLoja,
  ): Promise<boolean> {
    if (!userId || !storeId) return false;
    if (await this.ehDono(userId, storeId)) return true;

    const vinculo = await this.vinculoAtivo(userId, storeId);
    if (!vinculo || !vinculo.acceptedAt) return false;
    if (vinculo.role === PapelNaEquipe.OWNER || vinculo.role === PapelNaEquipe.MANAGER) {
      // MANAGER tem os módulos liberados; OWNER na tabela é só histórico.
      if (!modulo) return true;
      return (vinculo.permissions || []).includes(modulo);
    }
    if (!modulo) return true;
    return (vinculo.permissions || []).includes(modulo);
  }

  /**
   * Versão que LANÇA — é o que substitui os `if (store.owner.id !== userId)`
   * espalhados pelos services.
   */
  async exigirPermissao(
    userId: string,
    storeId: string,
    modulo?: ModuloDaLoja,
    mensagem = 'Voce nao tem permissao sobre esta loja.',
  ): Promise<void> {
    if (!(await this.podeGerenciar(userId, storeId, modulo))) {
      throw new ForbiddenException(mensagem);
    }
  }

  // ─── Gestão da equipe ──────────────────────────────────────────────────

  /** Só o dono (ou um MANAGER) mexe na equipe. */
  private async exigirGestaoDeEquipe(userId: string, storeId: string): Promise<void> {
    if (await this.ehDono(userId, storeId)) return;
    const vinculo = await this.vinculoAtivo(userId, storeId);
    if (vinculo?.acceptedAt && vinculo.role === PapelNaEquipe.MANAGER) return;
    throw new ForbiddenException('Voce nao pode gerenciar a equipe desta loja.');
  }

  async listar(userId: string, storeId: string): Promise<VendorTeamMember[]> {
    await this.exigirGestaoDeEquipe(userId, storeId);
    return this.equipeRepository.find({
      where: { storeId } as any,
      relations: ['member'],
      order: { invitedAt: 'DESC' },
    });
  }

  async convidar(
    userId: string,
    storeId: string,
    memberEmail: string,
    role: PapelNaEquipe,
    permissions: ModuloDaLoja[],
  ): Promise<VendorTeamMember> {
    await this.exigirGestaoDeEquipe(userId, storeId);

    const store = await this.storesRepository.findOne({
      where: { id: storeId },
      relations: ['owner'],
    });
    if (!store) throw new NotFoundException('Loja nao encontrada');

    const email = memberEmail.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new BadRequestException('E-mail invalido');
    }
    if (store.owner?.email?.toLowerCase() === email) {
      throw new BadRequestException('O dono da loja ja tem acesso total.');
    }
    if (role === PapelNaEquipe.OWNER) {
      // Dono é quem é; não se concede por convite. Sem esta trava, um MANAGER
      // poderia criar um "dono" paralelo e tirar o acesso do dono de verdade.
      throw new BadRequestException('Nao e possivel convidar alguem como OWNER.');
    }

    const validos = this.somenteModulosValidos(permissions);
    if (validos.length === 0) {
      throw new BadRequestException('Selecione ao menos um modulo para o funcionario.');
    }

    const jaConvidado = await this.equipeRepository.findOne({
      where: { storeId, memberEmail: email, revokedAt: IsNull() } as any,
    });
    if (jaConvidado) {
      throw new BadRequestException('Este e-mail ja tem convite ou acesso nesta loja.');
    }

    // Se a pessoa já tem conta de lojista, o convite já nasce ligado a ela —
    // mas ainda precisa ser ACEITO: ninguém entra numa equipe sem saber.
    const jaExiste = await this.vendorsRepository.findOne({ where: { email } });

    const token = randomBytes(24).toString('hex');
    const membro = this.equipeRepository.create({
      ownerId: store.owner.id,
      storeId,
      memberEmail: email,
      memberId: jaExiste?.id ?? null,
      role,
      permissions: validos,
      inviteTokenHash: this.hash(token),
    } as any);
    const salvo = (await this.equipeRepository.save(membro)) as unknown as VendorTeamMember;

    this.enviarConvite(email, store, token, validos, !!jaExiste).catch((e) =>
      this.logger.error(`Falha ao enviar convite de equipe: ${e?.message || e}`),
    );

    this.logger.log(
      `[EQUIPE] convite para ${email} na loja ${store.name} (${validos.join(',')})`,
    );
    return salvo;
  }

  /** Aceita o convite. O token é de uso único: some ao ser aceito. */
  async aceitar(userId: string, token: string): Promise<VendorTeamMember> {
    const convite = await this.equipeRepository.findOne({
      where: { inviteTokenHash: this.hash(token), revokedAt: IsNull() } as any,
      relations: ['store'],
    });
    if (!convite) throw new NotFoundException('Convite invalido ou ja utilizado.');

    const limite = new Date(convite.invitedAt);
    limite.setDate(limite.getDate() + EquipeService.DIAS_DE_CONVITE);
    if (new Date() > limite) {
      throw new BadRequestException('Este convite expirou. Peca um novo ao dono da loja.');
    }

    const usuario = await this.vendorsRepository.findOne({ where: { id: userId } });
    if (!usuario) throw new NotFoundException('Usuario nao encontrado');

    // O convite é para um E-MAIL. Aceitar com outra conta transformaria um
    // link vazado em acesso para quem o interceptou.
    if (usuario.email?.toLowerCase() !== convite.memberEmail.toLowerCase()) {
      throw new ForbiddenException(
        'Este convite foi enviado para outro e-mail. Entre com a conta convidada.',
      );
    }

    convite.memberId = usuario.id;
    convite.acceptedAt = new Date();
    convite.inviteTokenHash = null;
    const salvo = await this.equipeRepository.save(convite);
    this.logger.log(`[EQUIPE] ${usuario.email} aceitou o convite da loja ${convite.storeId}`);
    return salvo;
  }

  async atualizarPermissoes(
    userId: string,
    membroId: string,
    permissions: ModuloDaLoja[],
    role?: PapelNaEquipe,
  ): Promise<VendorTeamMember> {
    const membro = await this.equipeRepository.findOne({ where: { id: membroId } });
    if (!membro) throw new NotFoundException('Membro nao encontrado');
    await this.exigirGestaoDeEquipe(userId, membro.storeId);
    if (role === PapelNaEquipe.OWNER) {
      throw new BadRequestException('Nao e possivel promover alguem a OWNER.');
    }

    const validos = this.somenteModulosValidos(permissions);
    if (validos.length === 0) {
      throw new BadRequestException('Selecione ao menos um modulo (ou revogue o acesso).');
    }
    membro.permissions = validos;
    if (role) membro.role = role;
    return this.equipeRepository.save(membro);
  }

  async revogar(userId: string, membroId: string): Promise<boolean> {
    const membro = await this.equipeRepository.findOne({ where: { id: membroId } });
    if (!membro) throw new NotFoundException('Membro nao encontrado');
    await this.exigirGestaoDeEquipe(userId, membro.storeId);

    // Revogar o próprio acesso de gestão deixaria a loja sem quem administre a
    // equipe (o dono continua podendo, mas um MANAGER se auto-revogando é um
    // tiro no pé silencioso).
    if (membro.memberId === userId) {
      throw new BadRequestException('Voce nao pode revogar o proprio acesso.');
    }

    membro.revokedAt = new Date();
    membro.inviteTokenHash = null;
    await this.equipeRepository.save(membro);
    this.logger.log(`[EQUIPE] acesso revogado: ${membro.memberEmail} na loja ${membro.storeId}`);
    return true;
  }

  /** As lojas em que este usuário é membro (não dono) — o painel usa para o menu. */
  async minhasLojasComoMembro(userId: string): Promise<VendorTeamMember[]> {
    return this.equipeRepository.find({
      where: { memberId: userId, revokedAt: IsNull() } as any,
      relations: ['store'],
    });
  }

  /** Para o superadmin ver a equipe de uma loja (sem exigir vínculo). */
  async listarParaSuperadmin(storeId: string): Promise<VendorTeamMember[]> {
    return this.equipeRepository.find({
      where: { storeId } as any,
      relations: ['member'],
      order: { invitedAt: 'DESC' },
    });
  }

  /**
   * Filtra o que veio do cliente contra o enum.
   *
   * Sem isto, um módulo inventado ("ADMIN") entraria no jsonb e ficaria lá
   * para sempre parecendo uma permissão — e um `includes()` futuro poderia
   * passar a reconhecê-lo.
   */
  private somenteModulosValidos(lista: ModuloDaLoja[] | undefined): ModuloDaLoja[] {
    const validos = Object.values(ModuloDaLoja);
    return [...new Set((lista || []).filter((m) => validos.includes(m)))];
  }

  private async enviarConvite(
    email: string,
    store: Store,
    token: string,
    permissions: ModuloDaLoja[],
    jaTemConta: boolean,
  ) {
    const base = process.env.VENDOR_PANEL_URL || 'https://vendor.bcmtech.com.br';
    const link = `${base}/equipe/convite?token=${token}`;
    await this.mailService.sendTeamInvite(
      email,
      store.name,
      link,
      permissions,
      jaTemConta,
      EquipeService.DIAS_DE_CONVITE,
    );
  }
}
