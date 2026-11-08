import { RoleCode } from '../users/schemas/role.schema';

// Server-only verified claims; symbol keys never appear in HTTP JSON responses.
export const ACCESS_CONTEXT = Symbol('accessContext');

export interface AuthPrincipal {
  [ACCESS_CONTEXT]?: { sessionId: string; authVersion: number; expiresAt: number };
  id: string;
  fullName: string;
  phone: string;
  email?: string;
  roleCode: RoleCode;
}
export interface AccessClaims { sub: string; sid: string; av: number; iat: number; exp: number }
export interface AuthResponse { accessToken: string; tokenType: 'Bearer'; expiresIn: number; user: AuthPrincipal }
