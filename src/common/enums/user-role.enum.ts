import { registerEnumType } from '@nestjs/graphql';

export enum UserRole {
  CUSTOMER = 'CUSTOMER',
  VENDOR = 'VENDOR',
  DELIVERER = 'DELIVERER',
  SUPERADMIN = 'SUPERADMIN',
  /** @deprecated Mantido apenas para compatibilidade com o banco. Usar VENDOR. */
  ADMIN = 'ADMIN',
}

registerEnumType(UserRole, { name: 'UserRole' });
