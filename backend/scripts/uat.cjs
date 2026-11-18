// EN-07 operator CLI. No HTTP hooks, no shell interpolation, no raw database/tool errors in output.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

function assertUat(env, demo = false) {
  if (env.NODE_ENV !== 'production' || env.DEPLOYMENT_ENV !== 'uat' || !/^gym_uat_[a-z0-9_]+$/.test(env.MONGODB_DB || '') ||
    /^gym_uat_restore_/.test(env.MONGODB_DB)) throw new Error('UAT_ENVIRONMENT_REQUIRED');
  if (demo && (env.UAT_DEMO_SEED !== 'ALLOW_DEMO_ONLY' || env.UAT_DATA_CLASSIFICATION !== 'DEMO_ONLY')) throw new Error('UAT_DEMO_OPT_IN_REQUIRED');
}
function assertRestoreTarget(source, target) {
  if (!/^gym_uat_restore_[a-z0-9_]+$/.test(target || '') || source === target) throw new Error('UAT_NEW_RESTORE_DATABASE_REQUIRED');
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
// Index key order is significant, unlike the order of fields in a BSON document.
function indexContract(index) {
  const { v, ns, key, ...options } = index;
  return { keys: Object.entries(key), options: canonical(options) };
}
function compareSnapshots(before, after) {
  const issues = [];
  const names = new Set([...Object.keys(before.collections), ...Object.keys(after.collections)]);
  for (const name of [...names].sort()) {
    if (JSON.stringify(before.collections[name]) !== JSON.stringify(after.collections[name])) issues.push(name);
  }
  if (JSON.stringify(before.finance) !== JSON.stringify(after.finance)) issues.push('FINANCE_TOTALS');
  if (after.sourceIssues.length) issues.push('SOURCE_RELATIONS');
  if (!after.inventory.consistent) issues.push('INVENTORY_LEDGER');
  return { matched: issues.length === 0, issues };
}
async function snapshot(connection) {
  const { BSON } = require('mongodb');
  const { TransactionRunner } = require('../dist/infrastructure/transaction/transaction-runner');
  const { reconcileInventory } = require('../dist/modules/inventory/inventory-reconciliation');
  const db = connection.db, collections = {};
  const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map(row => row.name)
    .filter(name => !name.startsWith('system.') && name !== '_uat_restore_receipt').sort();
  for (const name of names) {
    const collection = db.collection(name), hash = createHash('sha256');
    let count = 0;
    for await (const row of collection.find({}, { promoteValues: false }).sort({ _id: 1 })) {
      hash.update(JSON.stringify(canonical(BSON.EJSON.serialize(row, { relaxed: false }))) + '\n'); count++;
    }
    const indexes = (await collection.listIndexes().toArray()).map(indexContract).sort((a, b) => a.options.name.localeCompare(b.options.name));
    collections[name] = { count, sha256: hash.digest('hex'), indexes };
  }
  const sum = async (name, filter) => {
    const rows = await db.collection(name).aggregate([{ $match: filter }, { $group: { _id: null, amount: { $sum: '$amount' }, count: { $sum: 1 } } }]).toArray();
    return { amount: rows[0]?.amount.toString() || '0', count: rows[0]?.count || 0 };
  };
  const finance = { receipts: await sum('payments', { status: 'SUCCEEDED' }), payouts: await sum('refunds', { status: 'SUCCEEDED' }) };
  const inventory = await reconcileInventory(connection, new TransactionRunner(connection));
  const sourceIssues = [];
  for (const [collection, field, from] of [
    ['orders', 'transaction_id', 'transactions'], ['order_items', 'order_id', 'orders'], ['order_items', 'product_id', 'products'],
    ['service_sales', 'transaction_id', 'transactions'], ['service_sales', 'member_id', 'members'], ['service_sales', 'plan_id', 'plans'],
    ['memberships', 'service_sale_id', 'service_sales'], ['payments', 'transaction_id', 'transactions'], ['invoices', 'transaction_id', 'transactions'],
    ['returns', 'order_id', 'orders'], ['return_items', 'return_id', 'returns'], ['return_items', 'order_item_id', 'order_items'],
    ['refunds', 'payment_id', 'payments'], ['refunds', 'order_id', 'orders'], ['refund_attempts', 'refund_id', 'refunds'],
    ['pt_bookings', 'membership_id', 'memberships'], ['pt_bookings', 'trainer_id', 'trainers'], ['pt_bookings', 'shift_id', 'work_shifts'],
  ]) {
    const rows = await db.collection(collection).aggregate([
      { $lookup: { from, localField: field, foreignField: '_id', as: 'source' } },
      { $match: { source: { $size: 0 } } }, { $count: 'count' },
    ]).toArray();
    if (rows.length) sourceIssues.push({ relation: `${collection}.${field}`, count: rows[0].count });
  }
  // Counts/hashes cover source relations, timestamps and evidence bytes without publishing any of them.
  return { version: 1, capturedAt: new Date().toISOString(), collections, finance, inventory, sourceIssues };
}
async function fileHash(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function toolVersion(tool) {
  const result = spawnSync(tool, ['--version'], { encoding: 'utf8', windowsHide: true });
  const version = result.stdout?.match(/(?:mongodump|mongorestore) version: ([0-9.]+)/)?.[1];
  if (result.status !== 0 || !version) throw new Error('UAT_DATABASE_TOOLS_REQUIRED');
  return version;
}
function databaseTool(tool, uri, args) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-uat-'));
  const configFile = path.join(directory, 'database-tools.yml');
  try {
    // JSON is valid YAML. URI goes only to a mode-600 file, never argv, stdout or stderr.
    fs.writeFileSync(configFile, JSON.stringify({ uri }), { mode: 0o600, flag: 'wx' });
    const result = spawnSync(tool, ['--config', configFile, ...args], { stdio: 'ignore', windowsHide: true });
    if (result.status !== 0) throw new Error('UAT_DATABASE_TOOL_FAILED');
  } finally {
    fs.rmSync(configFile, { force: true }); fs.rmdirSync(directory);
  }
}
const safeLog = (code, data = {}) => console.info(JSON.stringify({ timestamp: new Date().toISOString(), code, ...data }));
async function run(args = process.argv.slice(2)) {
  require('reflect-metadata');
  await require('@nestjs/config').ConfigModule.forRoot({ ignoreEnvFile: process.env.DEPLOYMENT_ENV === 'uat' });
  const env = process.env;
  assertUat(env, args[0] === 'seed-demo');
  const { default: configuration, readMongoConfiguration } = require('../dist/config/configuration');
  const { EnvironmentCheck } = require('../dist/infrastructure/environment/environment-check');
  const mongoose = require('mongoose');
  const config = readMongoConfiguration(env);
  if (args[0] === 'config-check') {
    configuration();
    safeLog('UAT_CONFIGURATION_VALID'); return;
  }
  if (args[0] === 'smoke') {
    configuration();
    const checks = [];
    for (const [route, expected] of [['/api/health/live', 'ok'], ['/api/health/ready', 'ready']]) {
      const response = await fetch(`${env.FRONTEND_ORIGIN}${route}`, { redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (!response.ok || (await response.json()).status !== expected || !response.headers.get('x-request-id')) throw new Error('UAT_HTTP_SMOKE_FAILED');
      checks.push({ route, status: response.status });
    }
    for (const route of ['/api/docs', '/api/docs-json']) {
      const response = await fetch(`${env.FRONTEND_ORIGIN}${route}`, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
      if (![401, 403, 404].includes(response.status)) throw new Error('UAT_SWAGGER_EXPOSED');
      checks.push({ route, status: response.status });
    }
    const spa = await fetch(`${env.FRONTEND_ORIGIN}/member/memberships`, { redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!spa.ok || !(await spa.text()).includes('<div id="root">')) throw new Error('UAT_SPA_SMOKE_FAILED');
    safeLog('UAT_PUBLIC_HTTP_SMOKE_PASSED', { checks, limitations: 'Browser auth, realtime, workers, restore and EN08 still required' }); return;
  }
  const connect = async dbName => {
    const connection = mongoose.createConnection(config.mongoUri, { dbName, autoIndex: false, autoCreate: false,
      serverSelectionTimeoutMS: 10000, connectTimeoutMS: 10000 });
    try { await connection.asPromise(); return connection; }
    catch { await connection.close().catch(() => undefined); throw new Error('UAT_DATABASE_UNAVAILABLE'); }
  };
  if (args[0] === 'seed-demo') {
    await require('./uat-demo.cjs').seedDemo(env); return;
  }
  if (args[0] === 'restore-rehearsal') {
    const [, input, target] = args; assertRestoreTarget(config.mongoDb, target);
    const archive = path.resolve(input || '');
    const manifest = JSON.parse(fs.readFileSync(`${archive}.manifest.json`, 'utf8'));
    if (manifest.version !== 1 || manifest.sourceDb !== config.mongoDb || manifest.archiveSha256 !== await fileHash(archive)) throw new Error('UAT_BACKUP_INVALID');
    const version = toolVersion('mongorestore'), connection = await connect(target), started = Date.now();
    try {
      if ((await connection.db.listCollections({}, { nameOnly: true }).toArray()).length) throw new Error('UAT_RESTORE_TARGET_NOT_EMPTY');
      databaseTool('mongorestore', config.mongoUri, [`--archive=${archive}`, '--gzip', `--nsInclude=${config.mongoDb}.*`,
        `--nsFrom=${config.mongoDb}.*`, `--nsTo=${target}.*`, '--stopOnError']);
      const after = await snapshot(connection), comparison = compareSnapshots(manifest.snapshot, after);
      const result = { ...comparison, elapsedMs: Date.now() - started, mongorestoreVersion: version };
      fs.writeFileSync(`${archive}.${target}.restore.json`, JSON.stringify(result, null, 2), { mode: 0o600, flag: 'wx' });
      if (!comparison.matched) throw new Error('UAT_RESTORE_COMPARISON_FAILED');
      await connection.db.collection('_uat_restore_receipt').insertOne({ _id: 'en07', sourceDb: config.mongoDb,
        archiveSha256: manifest.archiveSha256, restoredAt: new Date() });
      safeLog('UAT_RESTORE_VERIFIED', result);
    } finally { await connection.close(); }
    return;
  }
  if (args[0] === 'migration-plan') {
    const target = args[1]; assertRestoreTarget(config.mongoDb, target);
    const connection = await connect(target);
    let before;
    try {
      if (!(await connection.db.collection('_uat_restore_receipt').findOne({ _id: 'en07', sourceDb: config.mongoDb }))) throw new Error('UAT_VERIFIED_RESTORE_REQUIRED');
      before = await snapshot(connection);
    } finally { await connection.close(); }
    // Rehearse real migration on a verified disposable restore, never the live source database.
    const result = spawnSync(process.execPath, [path.join(__dirname, 'admin.cjs'), 'ensure-indexes'], { windowsHide: true, stdio: 'inherit',
      env: { ...env, MONGODB_DB: target } });
    if (result.status !== 0) throw new Error('UAT_MIGRATION_REHEARSAL_FAILED');
    const migrated = await connect(target);
    try {
      const after = await snapshot(migrated);
      if (!after.inventory.consistent || after.sourceIssues.length || JSON.stringify(before.finance) !== JSON.stringify(after.finance)) throw new Error('UAT_MIGRATION_RECONCILIATION_FAILED');
      const changes = compareSnapshots(before, after).issues;
      safeLog('UAT_MIGRATION_REHEARSED', { changedCollections: changes });
    } finally { await migrated.close(); }
    return;
  }
  if (!['backup', 'snapshot', 'workers'].includes(args[0])) throw new Error('UAT_COMMAND_INVALID');
  const connection = await connect(config.mongoDb);
  try {
    await new EnvironmentCheck(connection).assertReady();
    if (args[0] === 'workers') {
      const db = connection.db, now = new Date();
      const statuses = await db.collection('notification_outbox').aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]).toArray();
      const oldest = await db.collection('notification_outbox').find({ status: { $in: ['READY', 'PROCESSING'] } }).sort({ available_at: 1 }).limit(1).next();
      safeLog('UAT_WORKER_OBSERVATION', { outbox: statuses.map(row => ({ status: row._id, count: row.count })),
        oldestAvailableLagMs: oldest ? Math.max(0, now - oldest.available_at) : 0,
        expiredHeld: await db.collection('orders').countDocuments({ reservation_state: 'HELD', status: { $in: ['PENDING', 'CONFIRMED'] }, reservation_expires_at: { $lte: now } }),
        reminderOccurrences: await db.collection('reminder_occurrences').countDocuments() });
      return;
    }
    if (env.UAT_WRITES_STOPPED !== 'CONFIRMED') throw new Error('UAT_QUIESCED_DATABASE_REQUIRED');
    if (!args[1]) throw new Error('UAT_OUTPUT_PATH_REQUIRED');
    const output = path.resolve(args[1]), started = Date.now();
    if (args[0] === 'snapshot') {
      const data = await snapshot(connection);
      fs.writeFileSync(output, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' });
      if (!data.inventory.consistent || data.sourceIssues.length) throw new Error('UAT_SOURCE_INCONSISTENT');
      safeLog('UAT_SNAPSHOT_SAVED'); return;
    }
    const version = toolVersion('mongodump');
    if (fs.existsSync(output) || fs.existsSync(`${output}.manifest.json`)) throw new Error('UAT_BACKUP_ALREADY_EXISTS');
    const before = await snapshot(connection);
    if (!before.inventory.consistent || before.sourceIssues.length) throw new Error('UAT_SOURCE_INCONSISTENT');
    fs.writeFileSync(output, Buffer.alloc(0), { mode: 0o600, flag: 'wx' });
    databaseTool('mongodump', config.mongoUri, [`--db=${config.mongoDb}`, `--archive=${output}`, '--gzip']);
    if (fs.statSync(output).size === 0) throw new Error('UAT_BACKUP_EMPTY');
    const after = await snapshot(connection);
    if (!compareSnapshots(before, after).matched) throw new Error('UAT_DATABASE_CHANGED_DURING_BACKUP');
    const manifest = { version: 1, sourceDb: config.mongoDb, createdAt: new Date().toISOString(),
      elapsedMs: Date.now() - started, mongodumpVersion: version, archiveSha256: await fileHash(output), snapshot: before };
    fs.writeFileSync(`${output}.manifest.json`, JSON.stringify(manifest, null, 2), { mode: 0o600, flag: 'wx' });
    safeLog('UAT_BACKUP_SAVED', { elapsedMs: manifest.elapsedMs });
  } finally { await connection.close(); }
}
if (require.main === module) run().catch(error => {
  // Only our fixed error codes or validation names may be printed; never error.message from a driver/tool/file.
  const code = /^UAT_[A-Z_]+$/.test(error?.message || '') ? error.message : 'UAT_COMMAND_FAILED';
  console.error(JSON.stringify({ timestamp: new Date().toISOString(), code,
    ...(error?.constructor?.name === 'ConfigurationError' ? { message: error.message } : {}) })); process.exitCode = 1;
});
module.exports = { assertUat, assertRestoreTarget, indexContract, compareSnapshots, snapshot, fileHash, run };
