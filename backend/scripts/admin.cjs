// Run after build so CLI and application share exactly the same schemas/services.
require('reflect-metadata');
const { randomUUID } = require('node:crypto');
const { ConfigModule } = require('@nestjs/config');
const { NestFactory } = require('@nestjs/core');
const mongoose = require('mongoose');
const { default: configuration, ConfigurationError, readMongoConfiguration } = require('../dist/config/configuration');
const { AccountSchema } = require('../dist/modules/users/schemas/account.schema');
const { RoleSchema } = require('../dist/modules/users/schemas/role.schema');
const { SecurityStateSchema, ACCOUNT_ADMINISTRATION } = require('../dist/modules/users/schemas/security-state.schema');
const { SecurityEventSchema } = require('../dist/modules/users/schemas/security-event.schema');
const { PermissionSchema, RolePermissionSchema } = require('../dist/modules/users/schemas/permission.schema');
const { AccessCatalogService } = require('../dist/modules/users/access-catalog.service');
const { MemberSchema } = require('../dist/modules/members/schemas/member.schema');
const { dropLegacyPhoneIndex } = require('../dist/modules/members/members.repository');
const { AuthSessionSchema } = require('../dist/modules/auth/schemas/auth-session.schema');
const { AuthRateLimitSchema } = require('../dist/modules/auth/schemas/auth-rate-limit.schema');
const { PasswordResetSchema } = require('../dist/modules/auth/schemas/password-reset.schema');
const { OperationRequestSchema } = require('../dist/modules/operations/schemas/operation-request.schema');
const { NotificationSchema } = require('../dist/modules/notifications/schemas/notification.schema');
const { NotificationRecipientSchema } = require('../dist/modules/notifications/schemas/notification-recipient.schema');
const { NotificationOutboxSchema } = require('../dist/modules/notifications/schemas/notification-outbox.schema');
const { NotificationCounterSchema } = require('../dist/modules/notifications/schemas/notification-counter.schema');
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
      await Promise.all([connection.model('Permission', PermissionSchema).createIndexes(),
        connection.model('RolePermission', RolePermissionSchema).createIndexes()]);
      const securityState = connection.model('SecurityState', SecurityStateSchema);
      const securityEvent = connection.model('SecurityEvent', SecurityEventSchema);
      await securityEvent.createIndexes();
      await securityState.updateOne({ _id: ACCOUNT_ADMINISTRATION }, { $setOnInsert: { revision: 0n } }, { upsert: true });
      // US-09: members dùng schema của MembersModule; xóa index phone cũ (không unique) trước khi tạo index unique.
      const members = connection.model('Member', MemberSchema);
      await dropLegacyPhoneIndex(members.collection);
      const session = connection.model('AuthSession', AuthSessionSchema);
      const rateLimit = connection.model('AuthRateLimit', AuthRateLimitSchema);
      const passwordReset = connection.model('PasswordReset', PasswordResetSchema);
      // EN-02 bước 2: unique index (actor_id, operation, client_key); collection mới nên chưa có dữ liệu trùng.
      const operationRequest = connection.model('OperationRequest', OperationRequestSchema);
      await Promise.all([account.createIndexes(), role.createIndexes(), members.createIndexes(), session.createIndexes(), rateLimit.createIndexes(),
        passwordReset.createIndexes(), operationRequest.createIndexes()]);
      // EN-03 bước 1: index notifications/recipients/outbox và counter sequence phải có trước khi nhận ghi.
      const notification = connection.model('Notification', NotificationSchema);
      const recipient = connection.model('NotificationRecipient', NotificationRecipientSchema);
      const outbox = connection.model('NotificationOutbox', NotificationOutboxSchema);
      const counter = connection.model('NotificationCounter', NotificationCounterSchema);
      await Promise.all([notification.createIndexes(), recipient.createIndexes(), outbox.createIndexes()]);
      // Chỉ tạo counter khi chưa có; chạy lại nhiều lần không đổi value.
      await counter.updateOne({ _id: 'global' }, { $setOnInsert: { value: 0n } }, { upsert: true });
      // US-05 migration: account tạo trước US-05 chưa có recovery_revision thì ghi 0. Chạy lại nhiều lần vẫn an toàn
      // vì chỉ chọn account chưa có field này; timestamps: false để không đổi updated_at.
      await account.updateMany({ recovery_revision: { $exists: false } }, { $set: { recovery_revision: 0 } }, { timestamps: false });
      console.info(JSON.stringify({ timestamp: new Date().toISOString(), code: 'INDEXES_ENSURED' }));
    } finally { await connection.close(); }
    return;
  }
  if (process.argv[2] === 'seed-access') {
    const config = readMongoConfiguration(process.env);
    const connection = mongoose.createConnection(config.mongoUri, { dbName: config.mongoDb,
      serverSelectionTimeoutMS: 10000, autoIndex: false, autoCreate: false });
    try {
      await connection.asPromise();
      const catalog = new AccessCatalogService(connection.model('Role', RoleSchema),
        connection.model('Permission', PermissionSchema), connection.model('RolePermission', RolePermissionSchema));
      await catalog.seed();
      console.info(JSON.stringify({ timestamp: new Date().toISOString(), code: 'ACCESS_CATALOG_SEEDED' }));
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
  if (process.argv[2] === 'retry-notification') {
    // EN-03 bước 2 (spec mục 2): công cụ vận hành đưa job outbox DEAD về READY theo eventKey, giữ nguyên eventKey.
    // Lỗi 404 NOTIFICATION_OUTBOX_NOT_FOUND / 409 NOTIFICATION_OUTBOX_NOT_DEAD được in mã lỗi ở run().catch, thoát mã 1.
    const eventKey = process.argv[3];
    if (!eventKey) throw new ConfigurationError('Usage: npm run retry-notification -- <eventKey>');
    configuration();
    const { AppModule } = require('../dist/app.module');
    const { NotificationOutboxService } = require('../dist/modules/notifications/notification-outbox.service');
    const app = await NestFactory.createApplicationContext(AppModule, { logger: false, abortOnError: false });
    try {
      // App context không chạy worker (spec 1.2): lệnh chỉ đổi trạng thái job, việc gửi để worker của HTTP server làm.
      await app.get(NotificationOutboxService).retryDead(eventKey);
      console.info(JSON.stringify({ timestamp: new Date().toISOString(), code: 'NOTIFICATION_RETRY_SCHEDULED', eventKey }));
    } finally { await app.close(); }
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
