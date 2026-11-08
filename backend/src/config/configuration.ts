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
  const { mongoUri, mongoDb } = checkMongoVariables(env, nodeEnv, invalid);
  if (invalid.length) throw new ConfigurationError(`Invalid environment variables: ${invalid.join(', ')}`);
  return { nodeEnv, port, frontendOrigin, mongoUri, mongoDb };
}

// Chỉ kiểm MONGODB_URI, MONGODB_DB cho lệnh quản trị chỉ cần kết nối DB (ensure-indexes, check-environment),
// để không bắt buộc JWT/SMTP như khi chạy cả ứng dụng.
export function readMongoConfiguration(env: NodeJS.ProcessEnv) {
  const invalid: string[] = [];
  const result = checkMongoVariables(env, env.NODE_ENV ?? 'development', invalid);
  if (invalid.length) throw new ConfigurationError(`Invalid environment variables: ${invalid.join(', ')}`);
  return result;
}

// Ghi TÊN biến sai vào invalid (không ghi giá trị); NODE_ENV=test bắt buộc dùng database test.
function checkMongoVariables(env: NodeJS.ProcessEnv, nodeEnv: string, invalid: string[]) {
  const mongoUri = env.MONGODB_URI?.trim() ?? '';
  const mongoDb = env.MONGODB_DB?.trim() ?? '';
  if (!/^mongodb(?:\+srv)?:\/\//.test(mongoUri)) invalid.push('MONGODB_URI');
  if (!mongoDb || /[\/\\."$*<>:|?\s\0]/.test(mongoDb)) invalid.push('MONGODB_DB');
  if (nodeEnv === 'test' && !/^(?:gym_test_[a-zA-Z0-9_-]+|gym_management_test(?:_[a-zA-Z0-9_-]+)?)$/.test(mongoDb)) invalid.push('MONGODB_DB (test database required)');
  return { mongoUri, mongoDb };
}

// Keep EN-01 validation reusable by infrastructure tools and validate Auth at application startup.
export default () => ({ ...readConfiguration(process.env), ...readAuthConfiguration(process.env) });

import { readAuthConfiguration } from './auth.configuration';
