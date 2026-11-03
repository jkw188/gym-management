import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';
import { ApplicationError, invalidField } from '../../common/errors/application-error';
import { PasswordService } from '../../common/security/password.service';
import { ROLE_CODES } from '../users/schemas/role.schema';
import { UsersService } from '../users/users.service';
import { AuthSessionsRepository } from './auth-sessions.repository';
import { AccessClaims, AuthPrincipal, AuthResponse } from './auth.types';
import { ChangePasswordLimiter } from './change-password-limiter.service';
import { AuthSession } from './schemas/auth-session.schema';

const unauthorized = () => new ApplicationError(401, 'UNAUTHORIZED', 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn');
const credentialsChanged = () => new ApplicationError(401, 'CREDENTIALS_CHANGED', 'Thông tin đăng nhập đã thay đổi, vui lòng đăng nhập lại');
type CurrentAccount = NonNullable<Awaited<ReturnType<UsersService['findById']>>>;
const OBJECT_ID = /^[a-f0-9]{24}$/i;
const REFRESH_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;

function parseAccessClaims(claims: unknown): AccessClaims {
  if (!claims || typeof claims !== 'object') throw unauthorized();
  const { sub, sid, av, iat, exp } = claims as Partial<AccessClaims>;

  const validIds = typeof sub === 'string' && OBJECT_ID.test(sub) && typeof sid === 'string' && OBJECT_ID.test(sid);
  const validNumbers = Number.isInteger(av) && Number(av) >= 0 && Number.isInteger(iat) && Number.isInteger(exp);
  const validLifetime = Number(exp) > Number(iat) && Number(exp) - Number(iat) <= 900;
  const nowInSeconds = Math.floor(Date.now() / 1000);
  const notFromFuture = Number(iat) <= nowInSeconds + 30;

  if (!validIds || !validNumbers || !validLifetime || !notFromFuture) throw unauthorized();
  return { sub: sub as string, sid: sid as string, av: Number(av), iat: Number(iat), exp: Number(exp) };
}

@Injectable()
export class AuthService implements OnModuleInit {
  private dummyHash!: string;
  constructor(private readonly users: UsersService, private readonly sessions: AuthSessionsRepository,
    private readonly passwords: PasswordService, private readonly jwt: JwtService, private readonly config: ConfigService,
    private readonly changePasswordLimiter: ChangePasswordLimiter) {}

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
    const { sub, sid, av } = parseAccessClaims(claims);
    return this.current(await this.sessions.findById(sid), sub, av);
  }

  async refresh(token: unknown) {
    if (typeof token !== 'string' || !REFRESH_TOKEN.test(token)) throw unauthorized();
    const previousHash = this.hash(token);
    const session = await this.sessions.findByHash(previousHash);
    const user = await this.current(session);
    const refreshToken = randomBytes(32).toString('base64url');
    const rotated = await this.sessions.rotate(session!, previousHash, this.hash(refreshToken));
    if (!rotated) throw unauthorized();
    // Recheck account/session after the write, including changes concurrent with rotation.
    return this.issue(rotated, await this.current(rotated, user.id), refreshToken);
  }

  async logout(authorization: string | undefined, refreshToken: unknown): Promise<void> {
    if (authorization !== undefined) {
      const session = await this.findSessionByBearer(authorization);
      await this.sessions.revoke(session._id);
      return;
    }

    if (refreshToken === undefined) {
      return;
    }

    const session = await this.findSessionByRefreshToken(refreshToken);
    await this.sessions.revoke(session._id);
  }

  // Chủ thể lấy từ phiên đăng nhập, không lấy từ dữ liệu client gửi lên (US-67-TC04).
  async changePassword(user: AuthPrincipal, accessToken: string | null, ip: string, currentPassword: string, newPassword: string) {
    // US-67-TC10: đếm mọi request đã qua Guard và kiểm tra định dạng DTO.
    await this.changePasswordLimiter.consumeRequest(ip);

    // US-67-TC03: chỉ kiểm tra, không trim hay normalize giá trị mật khẩu.
    this.passwords.validate(newPassword, 'newPassword');
    // Spec 1.2, F02: luật này chỉ áp dụng cho mật khẩu mới. currentPassword không kiểm tra luật này
    // vì tài khoản cũ có thể đang dùng mật khẩu có khoảng trắng, chỉ cần verify đúng nguyên văn với hash.
    if (/\s/.test(newPassword)) {
      invalidField('newPassword', 'Mật khẩu không được chứa khoảng trắng');
    }

    const credentials = await this.users.findCredentialsById(user.id);
    if (!credentials || credentials.account.status !== 'ACTIVE') {
      throw unauthorized();
    }

    // US-67-TC09: auth_version đổi giữa lúc Guard kiểm tra và lúc đọc account thì phiên này đã bị thu hồi.
    if (credentials.account.authVersion !== this.sessionAuthVersion(accessToken)) {
      throw credentialsChanged();
    }

    // US-67-TC02: sai mật khẩu hiện tại hoặc mật khẩu mới trùng cũ thì không đổi gì.
    await this.changePasswordLimiter.reserveAttempt(user.id, ip);
    let currentIsValid: boolean;
    try {
      currentIsValid = await this.passwords.verifyOrThrow(credentials.passwordHash, currentPassword);
    } catch (error) {
      // Lỗi hệ thống không phải lỗi của người dùng nên không tính là một lần sai.
      await this.changePasswordLimiter.releaseAttempt(user.id, ip);
      throw error;
    }
    if (!currentIsValid) {
      throw new ApplicationError(400, 'CURRENT_PASSWORD_INVALID', 'Mật khẩu hiện tại không đúng');
    }
    await this.changePasswordLimiter.releaseAttempt(user.id, ip);
    const newIsSameAsOld = await this.passwords.verifyOrThrow(credentials.passwordHash, newPassword);
    if (newIsSameAsOld) {
      throw new ApplicationError(400, 'PASSWORD_UNCHANGED', 'Mật khẩu mới phải khác mật khẩu hiện tại');
    }

    // US-67-F03: tạo hash trước khi ghi. newPassword đã qua policy nên lỗi ở đây chỉ có thể là lỗi hệ thống (US-67-TC11).
    let newHash: string;
    try {
      newHash = await this.passwords.hash(newPassword);
    } catch {
      throw new ApplicationError(503, 'SERVICE_UNAVAILABLE', 'Dịch vụ chưa sẵn sàng, vui lòng thử lại');
    }

    // US-67-TC06, TC09: có thay đổi bảo mật chen vào sau lúc đọc thì không ghi đè.
    const updated = await this.users.updatePasswordIfUnchanged(user.id, credentials.passwordHash, credentials.account.authVersion, newHash);
    if (!updated) {
      throw credentialsChanged();
    }

    // US-67-F04: không trả token mới; auth_version đã tăng nên mọi phiên cũ bị từ chối ở request tiếp theo.
    return { message: 'Đã đổi mật khẩu, vui lòng đăng nhập lại', reauthenticationRequired: true };
  }

  // Lấy claim av của access token. Dùng decode vì Guard đã xác minh chữ ký và hạn của chính token này.
  private sessionAuthVersion(accessToken: string | null): number {
    if (!accessToken) {
      throw unauthorized();
    }
    return parseAccessClaims(this.jwt.decode(accessToken)).av;
  }

  private async findSessionByBearer(authorization: string): Promise<AuthSession> {
    const match = BEARER.exec(authorization);
    const token = match?.[1];
    if (!token) {
      throw unauthorized();
    }

    let payload: unknown;
    try {
      payload = await this.jwt.verifyAsync(token, {
        algorithms: ['HS256'],
        ignoreExpiration: true,
        issuer: this.config.getOrThrow<string>('jwtIssuer'),
        audience: this.config.getOrThrow<string>('jwtAudience'),
      });
    } catch {
      throw unauthorized();
    }

    const claims = parseAccessClaims(payload);
    const session = await this.sessions.findById(claims.sid);
    if (!session || session.account_id.toHexString() !== claims.sub) {
      throw unauthorized();
    }
    return session;
  }

  private async findSessionByRefreshToken(token: unknown): Promise<AuthSession> {
    if (typeof token !== 'string' || !REFRESH_TOKEN.test(token)) {
      throw unauthorized();
    }

    const tokenHash = this.hash(token);
    const session = await this.sessions.findByHash(tokenHash);
    if (!session) {
      throw unauthorized();
    }
    return session;
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
