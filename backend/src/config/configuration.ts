export class ConfigurationError extends Error {}

export function readConfiguration(env: NodeJS.ProcessEnv) {
  const invalid: string[] = [];
  const nodeEnv = env.NODE_ENV ?? 'development';
  if (!['development', 'test', 'production'].includes(nodeEnv)) invalid.push('NODE_ENV');
  const portText = env.PORT ?? (nodeEnv === 'production' ? '' : '3000');
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) invalid.push('PORT');
  const frontendOrigin = env.FRONTEND_ORIGIN ?? (nodeEnv === 'production' ? '' : 'http://localhost:5173');
  try {
    const url = new URL(frontendOrigin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== frontendOrigin) throw new Error();
  } catch { invalid.push('FRONTEND_ORIGIN'); }
  const mongoUri = env.MONGODB_URI?.trim() ?? '';
  const mongoDb = env.MONGODB_DB?.trim() ?? '';
  if (!/^mongodb(?:\+srv)?:\/\//.test(mongoUri)) invalid.push('MONGODB_URI');
  if (!mongoDb || /[\/\\."$*<>:|?\s\0]/.test(mongoDb)) invalid.push('MONGODB_DB');
  if (nodeEnv === 'test' && !/^gym_management_test(?:_[a-zA-Z0-9_-]+)?$/.test(mongoDb)) invalid.push('MONGODB_DB (test database required)');
  if (invalid.length) throw new ConfigurationError(`Invalid environment variables: ${invalid.join(', ')}`);
  return { nodeEnv, port, frontendOrigin, mongoUri, mongoDb };
}

// Keep EN-01 validation reusable by infrastructure tools and validate Auth at application startup.
export default () => ({ ...readConfiguration(process.env), ...readAuthConfiguration(process.env) });

import { readAuthConfiguration } from './auth.configuration';
