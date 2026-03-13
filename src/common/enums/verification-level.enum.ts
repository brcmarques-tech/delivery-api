import { registerEnumType } from '@nestjs/graphql';

export enum VerificationLevel {
  NONE = 'NONE',
  BRONZE = 'BRONZE',
  SILVER = 'SILVER',
  GOLD = 'GOLD',
  DIAMOND = 'DIAMOND',
}

registerEnumType(VerificationLevel, { name: 'VerificationLevel' });
