import { isEmail } from 'class-validator';
import { ConfigurationError } from './configuration';

export function readAuthConfiguration(env: NodeJS.ProcessEnv) {
  const invalid: string[] = [];
  const jwtAccessSecret = env.JWT_ACCESS_SECRET ?? '';
  if (Buffer.byteLength(jwtAccessSecret, 'utf8') < 32 || jwtAccessSecret.trim().length < 32) invalid.push('JWT_ACCESS_SECRET');
  const fixed = { JWT_ACCESS_TTL_SECONDS: '900', REFRESH_TTL_SECONDS: '604800', JWT_ISSUER: 'gym-api', JWT_AUDIENCE: 'gym-web' };
  for (const [key, value] of Object.entries(fixed)) if (env[key] !== undefined && env[key] !== value) invalid.push(key);
  // US-05: quên mật khẩu chỉ bật khi có RESET_OTP_PEPPER. Có thì phải ngẫu nhiên ≥ 32 byte và khác JWT secret.
  const resetOtpPepper = env.RESET_OTP_PEPPER || undefined;
  if (resetOtpPepper !== undefined && (Buffer.byteLength(resetOtpPepper, 'utf8') < 32 || resetOtpPepper.trim().length < 32 ||
    resetOtpPepper === jwtAccessSecret)) invalid.push('RESET_OTP_PEPPER');
  // US-05: bật quên mật khẩu (có pepper) thì bắt buộc đủ cấu hình SMTP; không bật thì bỏ qua các biến SMTP.
  const smtp = resetOtpPepper === undefined ? undefined : readSmtpConfiguration(env, invalid);
  if (invalid.length) throw new ConfigurationError(`Invalid environment variables: ${invalid.join(', ')}`);
  return { jwtAccessSecret, jwtAccessTtlSeconds: 900, refreshTtlSeconds: 604800, jwtIssuer: 'gym-api', jwtAudience: 'gym-web', resetOtpPepper, smtp };
}

export interface SmtpConfiguration { host: string; port: number; secure: boolean; user: string; pass: string; from: string }

// Chỉ ghi TÊN biến sai vào danh sách lỗi, không ghi giá trị, để mật khẩu SMTP không lọt vào log.
function readSmtpConfiguration(env: NodeJS.ProcessEnv, invalid: string[]): SmtpConfiguration {
  const host = env.SMTP_HOST?.trim() ?? '';
  if (!host) invalid.push('SMTP_HOST');
  const portText = env.SMTP_PORT ?? '';
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535) invalid.push('SMTP_PORT');
  if (env.SMTP_SECURE !== 'true' && env.SMTP_SECURE !== 'false') invalid.push('SMTP_SECURE');
  const user = env.SMTP_USER ?? '';
  if (!user) invalid.push('SMTP_USER');
  const pass = env.SMTP_PASS ?? '';
  if (!pass) invalid.push('SMTP_PASS');
  const from = env.SMTP_FROM?.trim() ?? '';
  if (!isEmail(from)) invalid.push('SMTP_FROM');
  return { host, port, secure: env.SMTP_SECURE === 'true', user, pass, from };
}
