import { Resolver, Query, Mutation, Args, ResolveField, Parent, Context } from '@nestjs/graphql';
import { UseGuards, ForbiddenException } from '@nestjs/common';
import { verify as jwtVerify } from 'jsonwebtoken';
import { AppUser } from './entities/app-user.entity';
import { ApprovalLog } from './entities/approval-log.entity';
import { AppUsersService } from './app-users.service';
import { MailService } from '../mail/mail.service';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Permission } from '../auth/decorators/permission.decorator';
import { UserRole } from '../common/enums';
import { RegisterDelivererInput } from './dto/register-deliverer.input';
import { ApprovalUserPage, ApprovalCounts } from './dto/approval-user.output';
import { AppUserPage, UserRoleCounts } from './dto/user-page.output';

@Resolver(() => AppUser)
export class AppUsersResolver {
  constructor(
    private appUsersService: AppUsersService,
    private mailService: MailService,
  ) {}

  @Query(() => AppUser)
  @UseGuards(GqlAuthGuard)
  meApp(@CurrentUser() user: AppUser): AppUser {
    return user;
  }

  // ─── PII: campos sensíveis só para o próprio usuário ou superadmin ───
  // Antes eram @Field diretos e vazavam via order.customer / order.delivery.deliverer
  // / storeOrders / availableStore para qualquer parte de um pedido. Padrão do
  // Store.owner (KAN-259). Vale para HTTP (JWT no header) e WS (ctx.wsUser).
  private async canSeePII(user: AppUser, ctx: any): Promise<boolean> {
    let payload: any = ctx?.wsUser || null;
    if (!payload) {
      const raw: string =
        ctx?.req?.headers?.authorization || ctx?.req?.headers?.Authorization || '';
      const token = raw.replace(/^Bearer\s+/i, '').trim();
      const secret = process.env.JWT_SECRET;
      if (token && secret) {
        try { payload = jwtVerify(token, secret); } catch { payload = null; }
      }
    }
    if (!payload) return false;
    // Dono do proprio dado: nao depende de liveness — o acesso ja passou pelo
    // guard da query de topo.
    if (!!payload.sub && payload.sub === user.id) return true;
    // Elevacao a SUPERADMIN: mesmo furo que o RatingsResolver fechou. O `role` e
    // um claim congelado no JWT (ate 7 dias) e este caminho NAO passa pela
    // JwtStrategy — entao isActive/sessionToken nao eram conferidos, e um
    // superadmin desligado seguia lendo PII com o token antigo. Confere no banco,
    // com memo por request para nao virar N+1 numa lista.
    if (payload.role !== 'SUPERADMIN' || !payload.sub) return false;
    if (ctx.__piiSuperadmin === undefined) {
      ctx.__piiSuperadmin = this.appUsersService
        .isActiveSuperadmin(payload.sub, payload.sessionToken)
        .catch(() => false);
    }
    return ctx.__piiSuperadmin;
  }

  /** Serializa o jsonb para String — ver o comentario no campo da entity. */
  @ResolveField(() => String, { nullable: true })
  permissions(@Parent() user: AppUser): string | null {
    const raw = (user as any).permissions;
    if (raw === null || raw === undefined) return null;
    return typeof raw === 'string' ? raw : JSON.stringify(raw);
  }

  @ResolveField(() => String, { nullable: true })
  async cpf(@Parent() user: AppUser, @Context() ctx: any): Promise<string | null> {
    return (await this.canSeePII(user, ctx)) ? (user.cpf ?? null) : null;
  }

  @ResolveField(() => String, { nullable: true })
  async identityPhotoUrl(@Parent() user: AppUser, @Context() ctx: any): Promise<string | null> {
    return (await this.canSeePII(user, ctx)) ? (user.identityPhotoUrl ?? null) : null;
  }

  @ResolveField(() => String, { nullable: true })
  async identityPhotoBackUrl(@Parent() user: AppUser, @Context() ctx: any): Promise<string | null> {
    return (await this.canSeePII(user, ctx)) ? (user.identityPhotoBackUrl ?? null) : null;
  }

  @ResolveField(() => String, { nullable: true })
  async birthDate(@Parent() user: AppUser, @Context() ctx: any): Promise<string | null> {
    return (await this.canSeePII(user, ctx)) ? (user.birthDate ?? null) : null;
  }

  @ResolveField(() => String, { nullable: true })
  async cnhNumber(@Parent() user: AppUser, @Context() ctx: any): Promise<string | null> {
    return (await this.canSeePII(user, ctx)) ? (user.cnhNumber ?? null) : null;
  }

  @Mutation(() => AppUser)
  @UseGuards(GqlAuthGuard)
  registerAsDeliverer(
    @Args('input') input: RegisterDelivererInput,
    @CurrentUser() user: AppUser,
  ): Promise<AppUser> {
    return this.appUsersService.registerAsDeliverer(user.id, input);
  }

  @Query(() => [AppUser])
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  allAppUsers(): Promise<AppUser[]> {
    return this.appUsersService.findAll();
  }

  // KAN-292: usuarios do app por papel, paginado no servidor (painel Usuarios).
  @Query(() => AppUserPage)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  appUsersByRole(
    @Args('role') role: string,
    @Args('search', { nullable: true }) search?: string,
    @Args('limit', { nullable: true }) limit?: number,
    @Args('offset', { nullable: true }) offset?: number,
  ): Promise<AppUserPage> {
    // Whitelist do papel (vai para o WHERE parametrizado, mas restringe o dominio).
    const allowed: Record<string, UserRole> = {
      CUSTOMER: UserRole.CUSTOMER,
      DELIVERER: UserRole.DELIVERER,
      SUPERADMIN: UserRole.SUPERADMIN,
    };
    const r = allowed[role] ?? UserRole.CUSTOMER;
    return this.appUsersService.findByRolePaginated(
      r,
      search ?? null,
      limit ?? 20,
      offset ?? 0,
    );
  }

  @Query(() => UserRoleCounts)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  async appUserRoleCounts(): Promise<UserRoleCounts> {
    const c = await this.appUsersService.roleCounts();
    // `vendors` e preenchido por uma query separada no cliente (VendorUsersService);
    // aqui devolvemos 0 e o painel usa o total de vendorUsersPage.
    return { ...c, vendors: 0 };
  }

  @Query(() => [AppUser])
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  pendingAppApprovals(): Promise<AppUser[]> {
    return this.appUsersService.findPendingApprovals();
  }

  // KAN-245: historico de aprovacoes/rejeicoes paginado no servidor (une app +
  // vendor). Substitui o allAppUsers/allVendorUsers no painel de aprovacoes.
  @Query(() => ApprovalUserPage)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  approvalUsers(
    @Args('status') status: string,
    @Args('search', { nullable: true }) search?: string,
    @Args('limit', { nullable: true }) limit?: number,
    @Args('offset', { nullable: true }) offset?: number,
  ): Promise<ApprovalUserPage> {
    const s = status === 'rejected' ? 'rejected' : 'approved';
    return this.appUsersService.findApprovalUsers(
      s,
      search ?? null,
      limit ?? 20,
      offset ?? 0,
    );
  }

  @Query(() => ApprovalCounts)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  approvalCounts(): Promise<ApprovalCounts> {
    return this.appUsersService.approvalCounts();
  }

  @Mutation(() => AppUser)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  @Permission('approvals')
  async approveAppUser(@Args('id') id: string, @CurrentUser() admin: AppUser): Promise<AppUser> {
    const result = await this.appUsersService.approveUser(id);
    const adminEmail = admin.notificationEmail || admin.email;
    this.mailService.sendAdminActionEmail(adminEmail, admin.name, 'Usuario aprovado', `Usuario: ${result.name} (${result.email})\nRole: ${result.role}`).catch(() => {});
    return result;
  }

  @Mutation(() => AppUser)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  @Permission('approvals')
  async rejectAppUser(
    @Args('id') id: string,
    @Args('reason') reason: string,
    @CurrentUser() admin: AppUser,
  ): Promise<AppUser> {
    const result = await this.appUsersService.rejectUser(id, reason);
    const adminEmail = admin.notificationEmail || admin.email;
    this.mailService.sendAdminActionEmail(adminEmail, admin.name, 'Usuario rejeitado', `Usuario: ${result.name} (${result.email})\nMotivo: ${reason}`).catch(() => {});
    return result;
  }

  @Mutation(() => AppUser)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  @Permission('users')
  async updateAppUserRole(
    @Args('id') id: string,
    @Args('role', { type: () => UserRole }) role: UserRole,
    @CurrentUser() admin: AppUser,
  ): Promise<AppUser> {
    // ESCALONAMENTO DE PRIVILEGIO: promover alguem a SUPERADMIN cria uma conta
    // com `permissions = null`, que o RolesGuard trata como superadmin PLENO.
    // Como esta mutation exigia apenas a chave `users`, um admin restrito
    // (users:true, settings:false) promovia a propria conta secundaria e passava
    // a poder tudo — inclusive `settings`. Promover a superadmin agora exige a
    // mesma chave que administra superadmins.
    if (role === UserRole.SUPERADMIN) {
      const raw = (admin as any).permissions;
      const permitido =
        raw === null ||
        raw === undefined ||
        (() => {
          try {
            const mapa = typeof raw === 'string' ? JSON.parse(raw) : raw;
            return mapa?.settings === true;
          } catch {
            return false;
          }
        })();
      if (!permitido) {
        throw new ForbiddenException(
          'Promover a SUPERADMIN exige a permissao de Configuracoes.',
        );
      }
    }

    const result = await this.appUsersService.updateUserRole(id, role);
    const adminEmail = admin.notificationEmail || admin.email;
    this.mailService.sendAdminActionEmail(adminEmail, admin.name, 'Role de usuario alterado', `Usuario: ${result.name} (${result.email})\nNovo role: ${role}`).catch(() => {});
    return result;
  }

  @Mutation(() => AppUser)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  @Permission('users')
  async toggleAppUserActive(@Args('id') id: string, @CurrentUser() admin: AppUser): Promise<AppUser> {
    const result = await this.appUsersService.toggleUserActive(id);
    const adminEmail = admin.notificationEmail || admin.email;
    this.mailService.sendAdminActionEmail(adminEmail, admin.name, `Usuario ${result.isActive ? 'ativado' : 'desativado'}`, `Usuario: ${result.name} (${result.email})`).catch(() => {});
    return result;
  }

  @Mutation(() => AppUser)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  @Permission('settings')
  async registerSuperadmin(
    @Args('name') name: string,
    @Args('email') email: string,
    @Args('password') password: string,
    @Args('phone') phone: string,
    @CurrentUser() admin: AppUser,
    @Args('permissions', { nullable: true }) permissions?: string,
  ): Promise<AppUser> {
    const parsedPermissions = permissions ? JSON.parse(permissions) : undefined;
    const result = await this.appUsersService.createSuperadmin({ name, email, password, phone, permissions: parsedPermissions });
    const adminEmail = admin.notificationEmail || admin.email;
    this.mailService.sendAdminActionEmail(adminEmail, admin.name, 'Novo superadmin criado', `Nome: ${name}\nEmail: ${email}`).catch(() => {});
    return result;
  }

  @Mutation(() => AppUser)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  @Permission('settings')
  async updateSuperadminPermissions(
    @Args('id') id: string,
    @Args('permissions') permissions: string,
    @CurrentUser() admin: AppUser,
  ): Promise<AppUser> {
    const result = await this.appUsersService.updateSuperadminPermissions(id, JSON.parse(permissions));
    const adminEmail = admin.notificationEmail || admin.email;
    this.mailService.sendAdminActionEmail(adminEmail, admin.name, 'Permissoes de superadmin atualizadas', `Superadmin: ${result.name} (${result.email})\nPermissoes: ${permissions}`).catch(() => {});
    return result;
  }

  @Mutation(() => AppUser)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  updateNotificationEmail(
    @CurrentUser() user: AppUser,
    @Args('email') email: string,
    @Args('userId', { type: () => String, nullable: true }) userId?: string,
  ): Promise<AppUser> {
    // O painel edita o email POR LINHA da tabela de admins, mas esta mutation
    // so gravava no proprio usuario logado: o master clicava na linha da Carla,
    // digitava o email dela, e o backend sobrescrevia o email de auditoria DELE
    // — a linha da Carla seguia "Nao configurado" e os emails de acao
    // administrativa do master passavam a ir para outra pessoa.
    const alvo = userId || user.id;
    if (alvo !== user.id) {
      // Editar o email de OUTRO admin exige a chave que administra superadmins
      // (mesma regra de updateSuperadminPermissions). null = superadmin pleno.
      const raw = (user as any).permissions;
      let permitido = raw === null || raw === undefined;
      if (!permitido) {
        try {
          const mapa = typeof raw === 'string' ? JSON.parse(raw) : raw;
          permitido = mapa?.settings === true;
        } catch {
          permitido = false;
        }
      }
      if (!permitido) {
        throw new ForbiddenException(
          'Editar o email de notificacao de outro admin exige a permissao de Configuracoes.',
        );
      }
    }
    return this.appUsersService.updateNotificationEmail(alvo, email);
  }

  @Mutation(() => AppUser)
  @UseGuards(GqlAuthGuard)
  updateAppProfile(
    @CurrentUser() user: AppUser,
    @Args('name', { nullable: true }) name?: string,
    @Args('phone', { nullable: true }) phone?: string,
    @Args('currentPassword', { nullable: true }) currentPassword?: string,
    @Args('newPassword', { nullable: true }) newPassword?: string,
    @Args('avatarUrl', { nullable: true }) avatarUrl?: string,
  ): Promise<AppUser> {
    return this.appUsersService.updateProfile(user.id, name, phone, currentPassword, newPassword, avatarUrl);
  }

  @Mutation(() => AppUser)
  @UseGuards(GqlAuthGuard)
  async acceptAppTerms(@CurrentUser() user: AppUser): Promise<AppUser> {
    return this.appUsersService.acceptTerms(user.id);
  }

  @Query(() => [ApprovalLog])
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  approvalLogs(): Promise<ApprovalLog[]> {
    return this.appUsersService.getApprovalLogs();
  }

  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard)
  async registerAppPushToken(
    @Args('token') token: string,
    @CurrentUser() user: AppUser,
  ): Promise<boolean> {
    await this.appUsersService.updatePushToken(user.id, token);
    return true;
  }

  /** Chamada no logout: solta o token deste aparelho para o proximo usuario nao herdar os pushes. */
  @Mutation(() => Boolean)
  @UseGuards(GqlAuthGuard)
  async unregisterAppPushToken(
    @Args('token', { type: () => String, nullable: true }) token: string | null,
    @CurrentUser() user: AppUser,
  ): Promise<boolean> {
    await this.appUsersService.clearPushToken(user.id, token ?? undefined);
    return true;
  }
}
