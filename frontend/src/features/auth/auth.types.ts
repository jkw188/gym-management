export type RoleCode = 'ADMIN' | 'STAFF' | 'TRAINER' | 'MEMBER';
export interface AuthUser { id: string; fullName: string; phone: string; email?: string; roleCode: RoleCode }
export interface AuthResponse { accessToken: string; tokenType: 'Bearer'; expiresIn: number; user: AuthUser }
export interface AuthSnapshot { status: 'checking' | 'authenticated' | 'anonymous'; user: AuthUser | null; error?: string; requestId?: string }
