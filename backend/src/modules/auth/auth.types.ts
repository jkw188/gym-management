import { RoleCode } from '../users/schemas/role.schema';

export interface AuthPrincipal {
  id: string;
  fullName: string;
  phone: string;
  email?: string;
  roleCode: RoleCode;
}
export interface AccessClaims { sub: string; sid: string; av: number; iat: number; exp: number }
export interface AuthResponse { accessToken: string; tokenType: 'Bearer'; expiresIn: number; user: AuthPrincipal }
