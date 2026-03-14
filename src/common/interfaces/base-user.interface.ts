import { UserRole } from '../enums';

export interface IBaseUser {
  id: string;
  name: string;
  email: string;
  password: string;
  phone: string;
  cpf: string;
  role: UserRole;
  isActive: boolean;
  avatarUrl: string;
  acceptedTermsAt: Date | null;
  resetPasswordToken: string;
  resetPasswordExpires: Date;
  expoPushToken: string;
  pendingRole: string | null;
  approvedAt: Date | null;
  rejectedAt: Date | null;
  rejectionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}
