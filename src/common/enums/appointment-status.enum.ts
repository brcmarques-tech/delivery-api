import { registerEnumType } from '@nestjs/graphql';

export enum AppointmentStatus {
  PENDING = 'PENDING',
  CONFIRMED = 'CONFIRMED',
  CANCELLED = 'CANCELLED',
  COMPLETED = 'COMPLETED',
  NO_SHOW = 'NO_SHOW',
  QUOTE_REQUESTED = 'QUOTE_REQUESTED',
  QUOTED = 'QUOTED',
  QUOTE_ACCEPTED = 'QUOTE_ACCEPTED',
  QUOTE_REJECTED = 'QUOTE_REJECTED',
}

registerEnumType(AppointmentStatus, { name: 'AppointmentStatus' });
