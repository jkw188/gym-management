export class ConfigurationError extends Error {}

export function readConfiguration(env: NodeJS.ProcessEnv) {
  const invalid: string[] = [];
  const nodeEnv = env.NODE_ENV ?? 'development';
  if (!['development', 'test', 'production'].includes(nodeEnv)) invalid.push('NODE_ENV');
  const deploymentEnvironment = env.DEPLOYMENT_ENV ?? nodeEnv;
  if (!['development', 'test', 'production', 'uat'].includes(deploymentEnvironment) ||
    (deploymentEnvironment === 'uat' ? nodeEnv !== 'production' : deploymentEnvironment !== nodeEnv)) invalid.push('DEPLOYMENT_ENV');
  const trustProxyText = env.TRUST_PROXY_HOPS ?? '0';
  if (!/^[01]$/.test(trustProxyText)) invalid.push('TRUST_PROXY_HOPS');
  const portText = env.PORT ?? (nodeEnv === 'production' ? '' : '3000');
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) invalid.push('PORT');
  const frontendOrigin = env.FRONTEND_ORIGIN ?? (nodeEnv === 'production' ? '' : 'http://localhost:5173');
  try {
    const url = new URL(frontendOrigin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== frontendOrigin) throw new Error();
    if (deploymentEnvironment === 'uat' && url.protocol !== 'https:') throw new Error();
  } catch { invalid.push('FRONTEND_ORIGIN'); }
  const { mongoUri, mongoDb } = checkMongoVariables(env, nodeEnv, invalid);
  if (deploymentEnvironment === 'uat') {
    if (env.UAT_DATA_CLASSIFICATION !== 'DEMO_ONLY') invalid.push('UAT_DATA_CLASSIFICATION');
    const quoteSecret = env.RETAIL_QUOTE_SECRET ?? '';
    if (Buffer.byteLength(quoteSecret) < 32 || quoteSecret.trim().length < 32 || quoteSecret === env.JWT_ACCESS_SECRET) invalid.push('RETAIL_QUOTE_SECRET');
    if (!env.PICKUP_LOCATION?.trim()) invalid.push('PICKUP_LOCATION');
    if (Object.keys(env).some(key => /^EN0[456]_/.test(key))) invalid.push('EN04/05/06 test-only variables');
  }
  const reminderTickMs = Number(env.REMINDER_TICK_MS ?? '60000');
  const reminderBatchSize = Number(env.REMINDER_BATCH_SIZE ?? '50');
  if (!Number.isInteger(reminderTickMs) || reminderTickMs < 1000 || reminderTickMs > 60000) invalid.push('REMINDER_TICK_MS');
  if (!Number.isInteger(reminderBatchSize) || reminderBatchSize < 1 || reminderBatchSize > 50) invalid.push('REMINDER_BATCH_SIZE');
  if (invalid.length) throw new ConfigurationError(`Invalid environment variables: ${invalid.join(', ')}`);
  return { nodeEnv, deploymentEnvironment, trustProxyHops: Number(trustProxyText), port, frontendOrigin, mongoUri, mongoDb,
    reminderTickMs, reminderBatchSize, reminderTimezone: 'Asia/Ho_Chi_Minh' };
}

// Chỉ kiểm MONGODB_URI, MONGODB_DB cho lệnh quản trị chỉ cần kết nối DB (ensure-indexes, check-environment),
// để không bắt buộc JWT/SMTP như khi chạy cả ứng dụng.
export function readMongoConfiguration(env: NodeJS.ProcessEnv) {
  const invalid: string[] = [];
  const result = checkMongoVariables(env, env.NODE_ENV ?? 'development', invalid);
  if (invalid.length) throw new ConfigurationError(`Invalid environment variables: ${invalid.join(', ')}`);
  return result;
}

// Only public, stable receiving-account codes; never bank credentials.
export function readReceivingAccounts(env: NodeJS.ProcessEnv): string[] {
  if (!env.RECEIVING_ACCOUNTS?.trim()) return [];
  try {
    const codes: unknown = JSON.parse(env.RECEIVING_ACCOUNTS);
    if (!Array.isArray(codes) || codes.some((code: unknown) => typeof code !== 'string' || !/^[A-Z0-9_-]{1,40}$/.test(code)) ||
      new Set(codes).size !== codes.length) throw new Error();
    return codes as string[];
  } catch { throw new ConfigurationError('Invalid environment variables: RECEIVING_ACCOUNTS'); }
}

// US-18 mục 2: thông tin công khai để Member chuyển khoản (ngân hàng, số tài khoản, tên chủ tài khoản), KHÔNG có credential.
// RECEIVING_ACCOUNT_DETAILS = JSON [{code,bankName,accountNumber,accountName}]; mỗi code phải có trong RECEIVING_ACCOUNTS.
export type ReceivingAccountDetail = { code: string; bankName: string; accountNumber: string; accountName: string };

export function readReceivingAccountDetails(env: NodeJS.ProcessEnv, codes: string[]): ReceivingAccountDetail[] {
  if (!env.RECEIVING_ACCOUNT_DETAILS?.trim()) return [];
  try {
    const rows: unknown = JSON.parse(env.RECEIVING_ACCOUNT_DETAILS);
    if (!Array.isArray(rows)) throw new Error();
    const details: ReceivingAccountDetail[] = [];
    for (const row of rows) {
      // Mã tài khoản phải nằm trong danh sách RECEIVING_ACCOUNTS; ba ô còn lại là chuỗi không rỗng.
      if (typeof row?.code !== 'string' || !codes.includes(row.code)) throw new Error();
      for (const text of [row.bankName, row.accountNumber, row.accountName]) {
        if (typeof text !== 'string' || !text.trim() || text.length > 120) throw new Error();
      }
      details.push({ code: row.code, bankName: row.bankName, accountNumber: row.accountNumber, accountName: row.accountName });
    }
    return details;
  } catch { throw new ConfigurationError('Invalid environment variables: RECEIVING_ACCOUNT_DETAILS'); }
}

// Ghi TÊN biến sai vào invalid (không ghi giá trị); NODE_ENV=test bắt buộc dùng database test.
function checkMongoVariables(env: NodeJS.ProcessEnv, nodeEnv: string, invalid: string[]) {
  const mongoUri = env.MONGODB_URI?.trim() ?? '';
  const mongoDb = env.MONGODB_DB?.trim() ?? '';
  if (!/^mongodb(?:\+srv)?:\/\//.test(mongoUri)) invalid.push('MONGODB_URI');
  if (!mongoDb || /[\/\\."$*<>:|?\s\0]/.test(mongoDb)) invalid.push('MONGODB_DB');
  if (nodeEnv === 'test' && !/^(?:gym_test_[a-zA-Z0-9_-]+|gym_management_test(?:_[a-zA-Z0-9_-]+)?)$/.test(mongoDb)) invalid.push('MONGODB_DB (test database required)');
  // EN-07: the same guard protects app startup and administrative commands before connecting.
  if (env.DEPLOYMENT_ENV === 'uat' && (nodeEnv !== 'production' || !/^gym_uat_[a-z0-9_]+$/.test(mongoDb))) {
    invalid.push('MONGODB_DB (isolated UAT database required)');
  }
  return { mongoUri, mongoDb };
}

// Keep EN-01 validation reusable by infrastructure tools and validate Auth at application startup.
export default () => {
  const receivingAccounts = readReceivingAccounts(process.env);
  return { ...readConfiguration(process.env), ...readAuthConfiguration(process.env), receivingAccounts,
    payoutAccounts: readPayoutAccounts(process.env),
    receivingAccountDetails: readReceivingAccountDetails(process.env, receivingAccounts) };
};

import { readAuthConfiguration } from './auth.configuration';

// Separate allowlist for money leaving the gym; never infer it from receiving accounts.
export function readPayoutAccounts(env: NodeJS.ProcessEnv): string[] {
  try { return readReceivingAccounts({ RECEIVING_ACCOUNTS: env.PAYOUT_ACCOUNTS }); }
  catch { throw new ConfigurationError('Invalid environment variables: PAYOUT_ACCOUNTS'); }
}
