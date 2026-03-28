import { registerEnumType } from '@nestjs/graphql';

export enum StoreType {
  PRODUCTS = 'PRODUCTS',
  SERVICES = 'SERVICES',
}

registerEnumType(StoreType, { name: 'StoreType' });
