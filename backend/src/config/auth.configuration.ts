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
  if (invalid.length) throw new ConfigurationError(`Invalid environment variables: ${invalid.join(', ')}`);
  return { jwtAccessSecret, jwtAccessTtlSeconds: 900, refreshTtlSeconds: 604800, jwtIssuer: 'gym-api', jwtAudience: 'gym-web', resetOtpPepper };
}
