const { spawn } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const { mkdirSync, readFileSync, readdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { MongoClient } = require('mongodb');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { validateTestEnvironment } = require('./test-database.cjs');
const { assessEn05Report } = require('../../scripts/test-report.cjs');

async function main() {
  process.chdir(path.resolve(__dirname, '..'));
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--regression') || args.length > 1) throw new Error('TEST_INVALID_EN05_MODE');
  const mode = args.includes('--regression') ? 'regression' : 'acceptance';
  // Do not load personal .env or reuse a development URI.
  if (process.env.NODE_ENV && process.env.NODE_ENV !== 'test') throw new Error('TEST_NODE_ENV_REQUIRED');
  process.env.NODE_ENV = 'test';
  const runId = randomBytes(6).toString('hex');
  const directory = path.resolve('../artifacts', `en05-${runId}`);
  mkdirSync(directory, { recursive: true });
  let mongo, client;
  const startedAt = new Date().toISOString();
  try {
    if (!process.env.MONGODB_TEST_URI) {
      mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
      process.env.MONGODB_TEST_URI = mongo.getUri('gym_test_en05');
    }
    validateTestEnvironment(process.env);
    client = new MongoClient(process.env.MONGODB_TEST_URI, { serverSelectionTimeoutMS: 10000 });
    await client.connect();
    const hello = await client.db('admin').command({ hello: 1 });
    if (!hello.setName || !hello.logicalSessionTimeoutMinutes) throw new Error('TEST_REPLICA_SET_REQUIRED');
    const mongoVersion = (await client.db('admin').command({ buildInfo: 1 })).version;
    const git = await run('git', ['rev-parse', 'HEAD'], process.env, true);
    const dirty = await run('git', ['status', '--porcelain'], process.env, true);
    const env = { ...process.env, EN04_RUN_ID: runId, EN05_REPORT_DIR: directory,
      JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'), RESET_OTP_PEPPER: '',
      SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', SMTP_FROM: '', FRONTEND_ORIGIN: 'http://localhost:5173',
      EN05_NOW: '2035-11-14T17:00:00.000Z', RECEIVING_ACCOUNTS: '["GYM_MAIN"]' };
    const metadata = { runId, seed: runId, commit: git.output.trim(), dirty: Boolean(dirty.output.trim()),
      startedAt, node: process.version, mongoVersion, replicaSet: true, disposable: Boolean(mongo),
      applicationVersion: require('../package.json').version, clock: env.EN05_NOW, rounds: 10, batchSize: 20,
      sourceSha256: hashTree(['src', 'test/en05.concurrency-spec.ts', 'test/helpers/en05-fixture.ts', 'test/helpers/en05-oracle.ts',
        'scripts/en05-app.cjs', 'scripts/test-en05.cjs', '../scripts/test-report.cjs', 'jest.en05.config.cjs', 'package-lock.json']),
      command: mode === 'regression' ? 'npm run test:en05:regression' : 'npm run test:en05', mode, reportVersion: 2 };
    writeFileSync(path.join(directory, 'environment.json'), JSON.stringify(metadata, null, 2));
    const result = await run(process.execPath, [require.resolve('jest/bin/jest'), '--config', 'jest.en05.config.cjs', '--runInBand'], env);
    // TC17 includes the existing production NotificationFeed dedupe/reconnect tests.
    const frontend = await run(process.execPath, [path.resolve('../frontend/node_modules/vitest/vitest.mjs'), 'run',
      'src/features/notifications/notifications.test.tsx', '--environment', 'jsdom', '--reporter=json',
      '--outputFile', path.join(directory, 'client.json')], env, false, path.resolve('../frontend'));
    let report;
    try { report = JSON.parse(readFileSync(path.join(directory, 'cases.json'), 'utf8')); }
    catch { report = { cases: [], setupFailed: true }; }
    for (let i = 1; i <= 20; i++) {
      const id = `TC${String(i).padStart(2, '0')}`;
      if (!report.cases.some(tc => tc.id === id)) report.cases.push({ id, status: 'NOT_RUN', reason: 'Suite/setup did not complete this case.', rounds: [] });
    }
    const coverage = { 'EN-05-AC01': [1, 2, 3, 6, 7, 8, 9, 10], 'EN-05-AC02': [11, 12, 13, 14, 18, 20],
      'EN-05-AC03': [4, 5, 15, 16, 17], 'EN-05-AC04': Array.from({ length: 20 }, (_, i) => i + 1) };
    const criteria = Object.fromEntries(Object.entries(coverage).map(([ac, ids]) => [ac,
      result.code === 0 && frontend.code === 0 && ids.every(i => report.cases.some(tc => tc.id === `TC${String(i).padStart(2, '0')}` &&
        tc.status === 'PASSED' && tc.rounds.length === 10)) ? 'PASSED' : 'NOT_ACCEPTED']));
    const assessment = assessEn05Report(report, result.code, frontend.code);
    const complete = assessment.acceptancePassed;
    const regression = assessment.regressionPassed ? 'PASSED' : 'FAILED';
    const acceptance = complete ? 'PASSED' : 'NOT_ACCEPTED';
    writeFileSync(path.join(directory, 'summary.json'), JSON.stringify({ ...metadata, finishedAt: new Date().toISOString(),
      jestExitCode: result.code, clientExitCode: frontend.code, regression, acceptance, criteria, incomplete: assessment.incomplete, cases: report.cases.map(tc =>
        ({ id: tc.id, status: tc.status, rounds: tc.rounds.length, reason: tc.reason })) }, null, 2));
    const rows = report.cases.slice().sort((a, b) => a.id.localeCompare(b.id)).map(tc =>
      `| ${tc.id} | ${tc.status} | ${tc.rounds.length}/10 | ${tc.rounds.reduce((sum, round) => sum + round.requests.length, 0)} | ${tc.reason || ''} |`);
    writeFileSync(path.join(directory, 'report.md'), [`# EN-05 ${acceptance}`, '',
      `Mode: ${mode}; regression: ${regression}; full acceptance: ${acceptance}.`, '',
      `Commit: ${metadata.commit}; dirty: ${metadata.dirty}; runId/seed: ${runId}.`,
      `Node ${metadata.node}; MongoDB ${mongoVersion}; replica set; clock ${metadata.clock}.`,
      `Jest exit: ${result.code}; NotificationFeed Vitest exit: ${frontend.code}.`, '',
      `Source SHA256: ${metadata.sourceSha256}.`, '',
      ...Object.entries(criteria).map(([ac, status]) => `- ${ac}: ${status}`), '',
      '| TC | Outcome | Rounds | Requests | Limitation |', '| --- | --- | --- | --- | --- |', ...rows, '',
      'DB before/after, checkpoints, request statuses/resolved outcomes: [cases.json](cases.json).',
      'Process IDs and actual indexes: [processes-indexes.json](processes-indexes.json).',
      'Client dedupe/reconnect checks: [client.json](client.json).',
      'Regression: `npm run test:en05:regression`; full acceptance: `npm run test:en05`.',
      'Known incomplete scope remains visible; any BLOCKED/PARTIAL/FAILED outcome prevents full acceptance.', ''].join('\n'));
    console.log(`EN05 evidence: ${directory}`);
    console.log(complete ? 'EN05 PASSED' : 'EN05 NOT_ACCEPTED: inspect summary.json and cases.json');
    console.log(`EN05 regression: ${regression}; mode: ${mode}; incomplete: ${assessment.incomplete.map(tc => tc.id).join(', ') || 'none'}`);
    if (process.env.GITHUB_STEP_SUMMARY) require('node:fs').appendFileSync(process.env.GITHUB_STEP_SUMMARY, readFileSync(path.join(directory, 'report.md'), 'utf8'));
    process.exitCode = (mode === 'regression' ? assessment.regressionPassed : complete) ? 0 : 1;
  } finally { await client?.close(); await mongo?.stop(); }
}
function hashTree(paths) {
  const hash = createHash('sha256');
  function visit(file) {
    let children;
    try { children = readdirSync(file).sort(); } catch {
      hash.update(file.replaceAll('\\', '/')); hash.update(readFileSync(file)); return;
    }
    for (const child of children) visit(path.join(file, child));
  }
  paths.forEach(visit);
  return hash.digest('hex');
}
function run(command, args, env, capture = false, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd, windowsHide: true, stdio: capture ? ['ignore', 'pipe', 'ignore'] : 'inherit' });
    let output = '';
    child.stdout?.on('data', chunk => { output += chunk; });
    const terminate = () => child.kill();
    process.once('SIGINT', terminate); process.once('SIGTERM', terminate);
    child.once('error', reject);
    child.once('exit', code => {
      process.removeListener('SIGINT', terminate); process.removeListener('SIGTERM', terminate);
      resolve({ code: code ?? 1, output });
    });
  });
}
main().catch(error => {
  console.error(/^(TEST_|INVALID_|MONGODB_TEST_URI_REQUIRED)/.test(error.message) ? error.message : 'EN05_SETUP_FAILED');
  process.exitCode = 1;
});
