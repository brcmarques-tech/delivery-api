import { registerEnumType } from '@nestjs/graphql';

export enum VendorPlan {
  FREE = 'FREE',
  PRO = 'PRO',
  PREMIUM = 'PREMIUM',
}

registerEnumType(VendorPlan, { name: 'VendorPlan' });
