import { SetMetadata } from '@nestjs/common';

export const PERMISSION_KEY = 'permission';

/**
 * Marca uma operacao como sujeita a uma permissao granular de superadmin.
 *
 * SEGURANCA: o campo `permissions` do superadmin era GRAVADO (registerSuperadmin
 * / updateSuperadminPermissions) mas NUNCA LIDO — o RolesGuard devolvia `true`
 * para qualquer SUPERADMIN e nenhum resolver consultava o JSON. Ou seja: um
 * superadmin criado com `{"managePayments": false}` via painel tinha os botoes
 * escondidos na UI, mas bastava chamar a mutation direto no /graphql para fazer
 * tudo. A restricao existia so na aparencia.
 *
 * Uso: `@Permission('managePayments')` junto de `@Roles(UserRole.SUPERADMIN)`.
 */
export const Permission = (permission: string) =>
  SetMetadata(PERMISSION_KEY, permission);
