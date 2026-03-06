import { registerEnumType } from '@nestjs/graphql';

export enum UserRole {
  CUSTOMER = 'CUSTOMER',
  VENDOR = 'VENDOR',
  DELIVERER = 'DELIVERER',
  ADMIN = 'ADMIN',
}

registerEnumType(UserRole, { name: 'UserRole' });
