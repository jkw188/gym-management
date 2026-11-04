// Run after build so CLI and application share exactly the same schemas/services.
require('reflect-metadata');
const { randomUUID } = require('node:crypto');
const { ConfigModule } = require('@nestjs/config');
const { NestFactory } = require('@nestjs/core');
const mongoose = require('mongoose');
const { default: configuration, ConfigurationError, readMongoConfiguration } = require('../dist/config/configuration');
const { AccountSchema } = require('../dist/modules/users/schemas/account.schema');
const { RoleSchema } = require('../dist/modules/users/schemas/role.schema');
const { AuthSessionSchema } = require('../dist/modules/auth/schemas/auth-session.schema');
const { AuthRateLimitSchema } = require('../dist/modules/auth/schemas/auth-rate-limit.schema');
const { PasswordResetSchema } = require('../dist/modules/auth/schemas/password-reset.schema');
const { OperationRequestSchema } = require('../dist/modules/operations/schemas/operation-request.schema');
const { EnvironmentCheck } = require('../dist/infrastructure/environment/environment-check');
const { mapError } = require('../dist/common/http/http-error.filter');

async function run() {
  // ConfigModule chỉ nạp .env vào process.env (không in giá trị); mỗi lệnh tự kiểm đúng các biến nó cần.
  await ConfigModule.forRoot();
  if (process.argv[2] === 'ensure-indexes') {
    // Chỉ cần MONGODB_URI, MONGODB_DB; không bắt buộc JWT/SMTP.
    const config = readMongoConfiguration(process.env);
    const connection = mongoose.createConnection(config.mongoUri, { dbName: config.mongoDb,
      serverSelectionTimeoutMS: 10000, autoIndex: false, autoCreate: false });
    try {
      await connection.asPromise();
      const account = connection.model('Account', AccountSchema);
      const role = connection.model('Role', RoleSchema);
      const session = connection.model('AuthSession', AuthSessionSchema);
      const rateLimit = connection.model('AuthRateLimit', AuthRateLimitSchema);
      const passwordReset = connection.model('PasswordReset', PasswordResetSchema);
      // EN-02 bước 2: unique index (actor_id, operation, client_key); collection mới nên chưa có dữ liệu trùng.
      const operationRequest = connection.model('OperationRequest', OperationRequestSchema);
      await Promise.all([account.createIndexes(), role.createIndexes(), session.createIndexes(), rateLimit.createIndexes(),
        passwordReset.createIndexes(), operationRequest.createIndexes()]);
      // US-05 migration: account tạo trước US-05 chưa có recovery_revision thì ghi 0. Chạy lại nhiều lần vẫn an toàn
      // vì chỉ chọn account chưa có field này; timestamps: false để không đổi updated_at.
      await account.updateMany({ recovery_revision: { $exists: false } }, { $set: { recovery_revision: 0 } }, { timestamps: false });
      console.info(JSON.stringify({ timestamp: new Date().toISOString(), code: 'INDEXES_ENSURED' }));
    } finally { await connection.close(); }
    return;
  }
  if (process.argv[2] === 'check-environment') {
    // EN-02-F01, EN-02-TC02: kiểm replica set và unique index trước nghiệm thu. Chỉ đọc, không tạo index.
    const config = readMongoConfiguration(process.env);
    const connection = mongoose.createConnection(config.mongoUri, { dbName: config.mongoDb,
      serverSelectionTimeoutMS: 10000, autoIndex: false, autoCreate: false });
    try {
      await connection.asPromise();
      await new EnvironmentCheck(connection).assertReady();
      console.info(JSON.stringify({ timestamp: new Date().toISOString(), code: 'ENVIRONMENT_READY' }));
    } catch (error) {
      // In thẳng lý do (không qua mapError) để người chạy biết thiếu replica set hay thiếu index; thoát mã 1.
      console.error(JSON.stringify({ timestamp: new Date().toISOString(), code: 'ENVIRONMENT_NOT_READY',
        message: error instanceof Error ? error.message : String(error) }));
      process.exitCode = 1;
    } finally { await connection.close(); }
    return;
  }
  if (process.argv[2] !== 'seed-admin') throw new Error('UNKNOWN_COMMAND');
  // seed-admin khởi động cả AppModule nên vẫn kiểm toàn bộ cấu hình (JWT, SMTP...) như trước.
  configuration();
  const required = ['SEED_ADMIN_PHONE', 'SEED_ADMIN_NAME', 'SEED_ADMIN_PASSWORD'];
  const missing = required.filter(key => !process.env[key]);
  if (missing.length) throw new ConfigurationError(`Missing environment variables: ${missing.join(', ')}`);
  const { AppModule } = require('../dist/app.module');
  const { SeedAdminService } = require('../dist/modules/users/seed-admin.service');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false, abortOnError: false });
  try {
    const result = await app.get(SeedAdminService).run({ phone: process.env.SEED_ADMIN_PHONE,
      fullName: process.env.SEED_ADMIN_NAME, password: process.env.SEED_ADMIN_PASSWORD, email: process.env.SEED_ADMIN_EMAIL });
    console.info(JSON.stringify({ timestamp: new Date().toISOString(), code: 'ADMIN_SEED_COMPLETED', result }));
  } finally { await app.close(); }
}

run().catch(error => {
  const mapped = mapError(error);
  console.error(JSON.stringify({ timestamp: new Date().toISOString(), requestId: randomUUID(),
    code: error instanceof ConfigurationError ? 'CONFIGURATION_ERROR' : mapped.code,
    message: error instanceof ConfigurationError ? error.message : mapped.message }));
  process.exitCode = 1;
});
