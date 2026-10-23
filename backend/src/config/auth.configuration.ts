import { ConfigurationError } from './configuration';

export function readAuthConfiguration(env: NodeJS.ProcessEnv) {
  const invalid: string[] = [];
  const jwtAccessSecret = env.JWT_ACCESS_SECRET ?? '';
  if (Buffer.byteLength(jwtAccessSecret, 'utf8') < 32 || jwtAccessSecret.trim().length < 32) invalid.push('JWT_ACCESS_SECRET');
  const fixed = { JWT_ACCESS_TTL_SECONDS: '900', REFRESH_TTL_SECONDS: '604800', JWT_ISSUER: 'gym-api', JWT_AUDIENCE: 'gym-web' };
  for (const [key, value] of Object.entries(fixed)) if (env[key] !== undefined && env[key] !== value) invalid.push(key);
  if (invalid.length) throw new ConfigurationError(`Invalid environment variables: ${invalid.join(', ')}`);
  return { jwtAccessSecret, jwtAccessTtlSeconds: 900, refreshTtlSeconds: 604800, jwtIssuer: 'gym-api', jwtAudience: 'gym-web' };
}
