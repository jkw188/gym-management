import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';
import { ApplicationError } from '../../common/errors/application-error';
import { PasswordService } from '../../common/security/password.service';
import { ROLE_CODES } from '../users/schemas/role.schema';
import { UsersService } from '../users/users.service';
import { AuthSessionsRepository } from './auth-sessions.repository';
import { AccessClaims, AuthPrincipal, AuthResponse } from './auth.types';
import { AuthSession } from './schemas/auth-session.schema';

const unauthorized = () => new ApplicationError(401, 'UNAUTHORIZED', 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn');
type CurrentAccount = NonNullable<Awaited<ReturnType<UsersService['findById']>>>;

@Injectable()
export class AuthService implements OnModuleInit {
  private dummyHash!: string;
  constructor(private readonly users: UsersService, private readonly sessions: AuthSessionsRepository,
    private readonly passwords: PasswordService, private readonly jwt: JwtService, private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> { this.dummyHash = await this.passwords.hash(randomBytes(32).toString('base64url')); }
  private hash(token: string) { return createHash('sha256').update(token).digest('hex'); }

  private async principal(account: CurrentAccount | null): Promise<AuthPrincipal | null> {
    if (!account || account.status !== 'ACTIVE') return null;
    const role = await this.users.findRoleById(account.roleId);
    if (!role || !ROLE_CODES.includes(role.code)) return null;
    return { id: account.id, fullName: account.fullName, phone: account.phone,
      ...(account.email ? { email: account.email } : {}), roleCode: role.code };
  }

  async login(phone: string, password: string) {
    const credentials = await this.users.findCredentialsByPhone(phone);
    const valid = await this.passwords.verify(credentials?.passwordHash ?? this.dummyHash, password);
    const user = await this.principal(credentials?.account ?? null);
    if (!valid || !user || !credentials) {
      throw new ApplicationError(401, 'INVALID_CREDENTIALS', 'Thông tin đăng nhập không chính xác hoặc tài khoản không được phép đăng nhập');
    }
    const refreshToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.config.getOrThrow<number>('refreshTtlSeconds') * 1000);
    const session = await this.sessions.create(user.id, credentials.account.authVersion, this.hash(refreshToken), expiresAt);
    return this.issue(session, user, refreshToken);
  }

  private async current(session: AuthSession | null, accountId?: string, authVersion?: number): Promise<AuthPrincipal> {
    if (!session || session.revoked_at || session.expires_at.getTime() <= Date.now() ||
      (accountId !== undefined && session.account_id.toHexString() !== accountId) ||
      (authVersion !== undefined && Number(session.auth_version) !== authVersion)) throw unauthorized();
    const account = await this.users.findById(session.account_id.toHexString());
    if (!account || account.authVersion !== Number(session.auth_version)) throw unauthorized();
    const user = await this.principal(account);
    if (!user) throw unauthorized();
    return user;
  }

  async validateAccess(claims: unknown): Promise<AuthPrincipal> {
    if (!claims || typeof claims !== 'object') throw unauthorized();
    const { sub, sid, av, iat, exp } = claims as Partial<AccessClaims>;
    if (typeof sub !== 'string' || !/^[a-f0-9]{24}$/i.test(sub) || typeof sid !== 'string' || !/^[a-f0-9]{24}$/i.test(sid) ||
      !Number.isInteger(av) || Number(av) < 0 || !Number.isInteger(iat) || !Number.isInteger(exp) ||
      Number(exp) - Number(iat) > 900 || Number(exp) <= Number(iat) || Number(iat) > Math.floor(Date.now() / 1000) + 30) throw unauthorized();
    return this.current(await this.sessions.findById(sid), sub, av);
  }

  async refresh(token: unknown) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw unauthorized();
    const previousHash = this.hash(token);
    const session = await this.sessions.findByHash(previousHash);
    const user = await this.current(session);
    const refreshToken = randomBytes(32).toString('base64url');
    const rotated = await this.sessions.rotate(session!, previousHash, this.hash(refreshToken));
    if (!rotated) throw unauthorized();
    // Recheck account/session after the write, including changes concurrent with rotation.
    return this.issue(rotated, await this.current(rotated, user.id), refreshToken);
  }

  private async issue(session: AuthSession, user: AuthPrincipal, refreshToken: string) {
    const now = Math.floor(Date.now() / 1000);
    const exp = Math.min(now + this.config.getOrThrow<number>('jwtAccessTtlSeconds'), Math.floor(session.expires_at.getTime() / 1000));
    if (exp <= now) throw unauthorized();
    const accessToken = await this.jwt.signAsync({ sub: user.id, sid: session.id.toHexString(), av: Number(session.auth_version), iat: now, exp });
    const body: AuthResponse = { accessToken, tokenType: 'Bearer', expiresIn: exp - now, user };
    return { body, refreshToken, expiresAt: session.expires_at };
  }
}
