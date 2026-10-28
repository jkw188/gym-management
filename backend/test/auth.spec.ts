import { randomBytes } from 'node:crypto';
import { readAuthConfiguration } from '../src/config/auth.configuration';
import { refreshCookieOptions } from '../src/modules/auth/auth.controller';
import { LoginLimiter } from '../src/modules/auth/login-limiter.service';

describe('US-02 configuration, cookies and limiter', () => {
  it('requires a strong external secret and fixed issuer/audience/lifetimes without echoing secrets', () => {
    const JWT_ACCESS_SECRET = randomBytes(32).toString('base64url');
    expect(readAuthConfiguration({ JWT_ACCESS_SECRET })).toMatchObject({ jwtIssuer: 'gym-api', jwtAudience: 'gym-web', jwtAccessTtlSeconds: 900, refreshTtlSeconds: 604800 });
    for (const env of [{}, { JWT_ACCESS_SECRET: 'short' }, { JWT_ACCESS_SECRET, JWT_ISSUER: 'wrong' },
      { JWT_ACCESS_SECRET, JWT_AUDIENCE: 'wrong' }, { JWT_ACCESS_SECRET, JWT_ACCESS_TTL_SECONDS: '1800' },
      { JWT_ACCESS_SECRET, REFRESH_TTL_SECONDS: '999999' }]) expect(() => readAuthConfiguration(env)).toThrow('Invalid environment variables');
    try { readAuthConfiguration({ JWT_ACCESS_SECRET: 'short-secret' }); }
    catch (error) { expect((error as Error).message).not.toContain('short-secret'); }
  });

  it('TC08: sets host-only HttpOnly Lax cookies and permits insecure cookies only for local development', () => {
    const expires = new Date();
    expect(refreshCookieOptions('development', 'http://localhost:5173', expires)).toEqual({ httpOnly: true, sameSite: 'lax', path: '/api/auth', secure: false, expires });
    expect(refreshCookieOptions('production', 'https://gym.example', expires).secure).toBe(true);
    expect(refreshCookieOptions('development', 'https://gym.example', expires).secure).toBe(true);
  });

  it('US-03 TC08: logout clears the cookie with the same name/path/flags, Secure in production', () => {
    expect(refreshCookieOptions('development', 'http://localhost:5173')).toEqual({ httpOnly: true, sameSite: 'lax', path: '/api/auth', secure: false });
    expect(refreshCookieOptions('production', 'https://gym.example')).toEqual({ httpOnly: true, sameSite: 'lax', path: '/api/auth', secure: true });
  });

  it('TC05–06: shares normalized phone buckets, also caps IP and resets after 60 seconds', () => {
    const limiter = new LoginLimiter();
    for (let i = 0; i < 5; i++) expect(limiter.consume('ip1', '+84901234567', 0)).toBe(0);
    expect(limiter.consume('ip1', '+84901234567', 1000)).toBe(59);
    for (let i = 0; i < 15; i++) expect(limiter.consume('ip1', `phone-${i}`, 1000)).toBe(0);
    expect(limiter.consume('ip1', 'other', 1000)).toBe(59);
    expect(limiter.consume('ip2', '+84901234567', 1000)).toBe(0);
    expect(limiter.consume('ip1', '+84901234567', 61000)).toBe(0);
  });
});
