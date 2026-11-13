const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { existsSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { MongoClient } = require('mongodb');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { validateTestEnvironment } = require('./test-database.cjs');

async function main() {
  process.chdir(path.resolve(__dirname, '..'));
  if (existsSync('.env.test')) process.loadEnvFile('.env.test');
  if (process.env.NODE_ENV !== 'test') throw new Error('TEST_NODE_ENV_REQUIRED');
  let mongo;
  let client;
  try {
    if (!process.env.MONGODB_TEST_URI) {
      mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' },
        replSet: { count: 1, storageEngine: 'wiredTiger' } });
      process.env.MONGODB_TEST_URI = mongo.getUri('gym_test_s01');
    }
    validateTestEnvironment(process.env);
    client = new MongoClient(process.env.MONGODB_TEST_URI, { serverSelectionTimeoutMS: 10000 });
    await client.connect();
    const hello = await client.db('admin').command({ hello: 1 });
    if (!hello.setName || !hello.logicalSessionTimeoutMinutes) throw new Error('TEST_REPLICA_SET_REQUIRED');
    const mongoVersion = (await client.db('admin').command({ buildInfo: 1 })).version;
    const runId = randomBytes(6).toString('hex');
    if (process.env.EN04_EVIDENCE_DIR) writeFileSync(path.join(process.env.EN04_EVIDENCE_DIR, 'e2e-environment.json'),
      JSON.stringify({ runId, mongoVersion, replicaSet: true, disposable: Boolean(mongo), checkedAt: new Date().toISOString() }, null, 2) + '\n');
    await client.close(); client = undefined;
    const env = { ...process.env, EN04_RUN_ID: runId,
      JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'), RESET_OTP_PEPPER: '',
      SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', SMTP_FROM: '',
      PORT: '3000', FRONTEND_ORIGIN: 'http://localhost:5173' };
    process.exitCode = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [require.resolve('jest/bin/jest'), '--config', 'jest.e2e.config.cjs',
        '--runInBand', ...process.argv.slice(2)], { env, stdio: 'inherit', windowsHide: true });
      const interrupt = signal => child.kill(signal);
      const terminate = () => interrupt('SIGTERM');
      const cancel = () => interrupt('SIGINT');
      process.once('SIGTERM', terminate); process.once('SIGINT', cancel);
      child.once('error', reject);
      child.once('exit', code => {
        process.removeListener('SIGTERM', terminate); process.removeListener('SIGINT', cancel);
        resolve(code ?? 1);
      });
    });
  } finally { await client?.close(); await mongo?.stop(); }
}

main().catch(error => {
  // Never print a driver error, URI, credentials or the child environment.
  const known = /^(?:TEST_|MONGODB_TEST_URI_REQUIRED|INVALID_)/.test(error.message);
  console.error(known ? error.message : 'E2E_SETUP_FAILED: check test configuration and MongoDB availability');
  process.exitCode = 1;
});
