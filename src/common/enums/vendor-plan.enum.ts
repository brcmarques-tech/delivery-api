import { registerEnumType } from '@nestjs/graphql';

export enum VendorPlan {
  FREE = 'FREE',
  PRO = 'PRO',
  PREMIUM = 'PREMIUM',
  ENTERPRISE = 'ENTERPRISE',
  CUSTOM = 'CUSTOM',
}

registerEnumType(VendorPlan, { name: 'VendorPlan' });
