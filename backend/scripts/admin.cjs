// Run after build so CLI and application share exactly the same schemas/services.
require('reflect-metadata');
const { randomUUID } = require('node:crypto');
const { ConfigModule } = require('@nestjs/config');
const { NestFactory } = require('@nestjs/core');
const mongoose = require('mongoose');
const { default: configuration, ConfigurationError } = require('../dist/config/configuration');
const { AccountSchema } = require('../dist/modules/users/schemas/account.schema');
const { RoleSchema } = require('../dist/modules/users/schemas/role.schema');
const { AuthSessionSchema } = require('../dist/modules/auth/schemas/auth-session.schema');
const { mapError } = require('../dist/common/http/http-error.filter');

async function run() {
  // ConfigModule loads .env without printing values. Seed variables are only required for seed.
  await ConfigModule.forRoot({ load: [configuration] });
  const config = configuration();
  if (process.argv[2] === 'ensure-indexes') {
    const connection = mongoose.createConnection(config.mongoUri, { dbName: config.mongoDb,
      serverSelectionTimeoutMS: 10000, autoIndex: false, autoCreate: false });
    try {
      await connection.asPromise();
      const account = connection.model('Account', AccountSchema);
      const role = connection.model('Role', RoleSchema);
      const session = connection.model('AuthSession', AuthSessionSchema);
      await Promise.all([account.createIndexes(), role.createIndexes(), session.createIndexes()]);
      console.info(JSON.stringify({ timestamp: new Date().toISOString(), code: 'INDEXES_ENSURED' }));
    } finally { await connection.close(); }
    return;
  }
  if (process.argv[2] !== 'seed-admin') throw new Error('UNKNOWN_COMMAND');
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
