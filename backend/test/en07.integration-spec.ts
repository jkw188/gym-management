import 'reflect-metadata';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as os from 'node:os';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose, { Connection } from 'mongoose';
import { compareSnapshots, snapshot } from '../scripts/uat.cjs';

describe('EN-07 operator commands against a disposable real replica set', () => {
  let mongo: MongoMemoryReplSet, source: Connection, target: Connection, env: NodeJS.ProcessEnv;
  const cli = (script: string, args: string[], extra: NodeJS.ProcessEnv = {}) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...env, ...extra }, windowsHide: true });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('EN07_CLI_TIMEOUT')); }, 90000);
    child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
    env = { ...process.env, NODE_ENV: 'production', DEPLOYMENT_ENV: 'uat', PORT: '3000', FRONTEND_ORIGIN: 'https://uat.example.invalid',
      MONGODB_URI: mongo.getUri(), MONGODB_DB: `gym_uat_en07_${randomBytes(4).toString('hex')}`, UAT_DATA_CLASSIFICATION: 'DEMO_ONLY',
      UAT_DEMO_SEED: 'ALLOW_DEMO_ONLY', JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'), RETAIL_QUOTE_SECRET: randomBytes(32).toString('base64url'),
      PICKUP_LOCATION: 'DEMO ONLY Counter', RECEIVING_ACCOUNTS: '[]', RECEIVING_ACCOUNT_DETAILS: '[]', PAYOUT_ACCOUNTS: '[]',
      RESET_OTP_PEPPER: '', SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', SMTP_FROM: '',
      SEED_ADMIN_PHONE: '0907000001', SEED_ADMIN_NAME: 'DEMO ONLY Admin', SEED_ADMIN_PASSWORD: randomBytes(24).toString('base64url'), SEED_ADMIN_EMAIL: 'admin@example.invalid',
      DEMO_STAFF_PHONE: '0907000002', DEMO_STAFF_PASSWORD: randomBytes(24).toString('base64url'),
      DEMO_TRAINER_PHONE: '0907000003', DEMO_TRAINER_PASSWORD: randomBytes(24).toString('base64url'),
      DEMO_MEMBER_PHONE: '0907000004', DEMO_MEMBER_PASSWORD: randomBytes(24).toString('base64url') };
    // Inherited EN04 evidence configuration is for the test harness, not the UAT application.
    for (const key of Object.keys(env)) if (/^EN0[456]_/.test(key)) delete env[key];
    const migrated = await cli('scripts/admin.cjs', ['ensure-indexes']);
    if (migrated.status !== 0) throw new Error(JSON.stringify(migrated));
    source = await mongoose.createConnection(mongo.getUri(), { dbName: env.MONGODB_DB, runtimeAdapters: { os }, autoIndex: false }).asPromise();
    target = await mongoose.createConnection(mongo.getUri(), { dbName: `${env.MONGODB_DB}_copy`, runtimeAdapters: { os }, autoIndex: false }).asPromise();
  }, 180000);
  afterAll(async () => { await target?.close(); await source?.close(); await mongo?.stop(); });

  it('validates UAT config and refuses wrong demo DB before connecting, without printing credentials', async () => {
    expect((await cli('scripts/uat.cjs', ['config-check'])).status).toBe(0);
    const rejected = await cli('scripts/uat.cjs', ['seed-demo'], { MONGODB_DB: 'gym_management', MONGODB_URI: 'mongodb://sensitive:credential@127.0.0.1:1' });
    expect(rejected.status).toBe(1); expect(rejected.stderr).toContain('UAT_ENVIRONMENT_REQUIRED');
    expect(rejected.stderr).not.toMatch(/sensitive|credential/);
  });

  it('seeds four roles, GYM/PT, schedule, real POS receipt/payment/return/payout writers; repeat preserves the Admin hash and business data', async () => {
    const seeded = await cli('scripts/uat.cjs', ['seed-demo']);
    if (seeded.status !== 0) throw new Error(JSON.stringify(seeded));
    expect(seeded.stdout).toContain('UAT_DEMO_SEEDED');
    const db = source.db!;
    expect(await db.collection('accounts').countDocuments()).toBe(4);
    expect(await db.collection('memberships').countDocuments()).toBe(2);
    expect(await db.collection('pt_bookings').countDocuments()).toBe(1);
    expect(await db.collection('public_sessions').countDocuments({ status: 'PUBLISHED' })).toBe(1);
    expect(await db.collection('refunds').countDocuments({ status: 'SUCCEEDED' })).toBe(1);
    expect(await db.collection('orders').countDocuments({ channel: 'POS', status: 'COMPLETED' })).toBe(1);
    const before = await snapshot(source);
    expect(before.inventory).toMatchObject({ checked: 1, consistent: true });
    expect(before.finance).toEqual({ receipts: { amount: '250000', count: 3 }, payouts: { amount: '25000', count: 1 } });
    const repeated = await cli('scripts/uat.cjs', ['seed-demo']);
    expect(repeated.status).toBe(0); expect(repeated.stdout).toContain('UAT_DEMO_UNCHANGED');
    expect(compareSnapshots(before, await snapshot(source)).matched).toBe(true);
  }, 120000);

  it('compares BSON fixture copies and detects changed source evidence, money or indexes (not a backup-tool rehearsal)', async () => {
    const before = await snapshot(source);
    for (const { name } of await source.db!.listCollections({}, { nameOnly: true }).toArray()) {
      const rows = await source.db!.collection(name).find({}, { promoteValues: false }).toArray();
      await target.db!.createCollection(name);
      if (rows.length) await target.db!.collection(name).insertMany(rows);
      for (const index of await source.db!.collection(name).listIndexes().toArray()) {
        if (index.name === '_id_') continue;
        const { key, v, ns, ...options } = index;
        await target.db!.collection(name).createIndex(key, options);
      }
    }
    expect(compareSnapshots(before, await snapshot(target))).toEqual({ matched: true, issues: [] });
    await target.db!.collection('orders').updateOne({}, { $set: { recipient_name: 'Changed after restore' } });
    expect(compareSnapshots(before, await snapshot(target)).issues).toContain('orders');
    await target.db!.collection('payments').dropIndex('payments_succeeded_transaction_unique');
    expect(compareSnapshots(before, await snapshot(target)).issues).toContain('payments');
    await target.db!.collection('invoices').insertOne({ transaction_id: new mongoose.Types.ObjectId() });
    const orphaned = await snapshot(target);
    expect(orphaned.sourceIssues).toContainEqual({ relation: 'invoices.transaction_id', count: 1 });
    expect(compareSnapshots(before, orphaned).issues).toContain('SOURCE_RELATIONS');
  }, 60000);

  it('blocks the UAT HTTP process before listening when a required unique index is missing', async () => {
    await source.db!.collection('payments').dropIndex('payments_succeeded_transaction_unique');
    const failed = await cli('dist/main.js', []);
    expect(failed.status).toBe(1); expect(failed.stderr).toContain('STARTUP_FAILED');
    expect(failed.stdout).not.toContain('APPLICATION_STARTED');
    expect(failed.stderr).not.toContain(env.JWT_ACCESS_SECRET);
  }, 120000);
});
