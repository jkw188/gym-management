const { spawn } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const { mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } = require('node:fs');
const path = require('node:path');
const { MongoClient } = require('mongodb');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { validateTestEnvironment } = require('./test-database.cjs');
const { assessEn06, IDS } = require('./en06-report.cjs');
function run(command, args, env, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, windowsHide: true, stdio: capture ? ['ignore', 'pipe', 'ignore'] : 'inherit' });
    let output = ''; child.stdout?.on('data', chunk => { output += chunk; });
    const stop = () => child.kill(); process.once('SIGINT', stop); process.once('SIGTERM', stop);
    child.once('error', reject);
    child.once('exit', code => { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); resolve({ code: code ?? 1, output }); });
  });
}
function fingerprint() {
  const hash = createHash('sha256');
  function visit(file) {
    let children;
    try { children = readdirSync(file).sort(); } catch { hash.update(file.replaceAll('\\', '/')); hash.update(readFileSync(file)); return; }
    children.forEach(child => visit(path.join(file, child)));
  }
  ['src', 'test/en06.concurrency-spec.ts', 'test/helpers/en06-fixture.ts', 'test/helpers/en06-oracle.ts',
    'scripts/en06-app.cjs', 'scripts/test-en06.cjs', 'scripts/en06-report.cjs', 'scripts/test-database.cjs',
    'test/en06-oracle.spec.ts', 'test/en06-report.spec.ts', 'jest.config.cjs', 'jest.en06.config.cjs', 'package.json', 'package-lock.json'].forEach(visit);
  return hash.digest('hex');
}
const readJson = (file, fallback) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } };
async function main() {
  process.chdir(path.resolve(__dirname, '..'));
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some(arg => arg !== '--foundation')) throw new Error('TEST_INVALID_EN06_MODE');
  const mode = args.includes('--foundation') ? 'foundation' : 'acceptance';
  if (process.env.NODE_ENV && process.env.NODE_ENV !== 'test') throw new Error('TEST_NODE_ENV_REQUIRED');
  process.env.NODE_ENV = 'test'; // Never load a personal .env file.
  const runId = randomBytes(6).toString('hex'), startedAt = new Date().toISOString();
  const directory = path.resolve('../artifacts', `en06-${runId}`); mkdirSync(directory, { recursive: true });
  let mongo, client;
  try {
    if (!process.env.MONGODB_TEST_URI) {
      mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
      process.env.MONGODB_TEST_URI = mongo.getUri('gym_test_en06');
    }
    validateTestEnvironment(process.env);
    client = new MongoClient(process.env.MONGODB_TEST_URI, { serverSelectionTimeoutMS: 10000 }); await client.connect();
    const hello = await client.db('admin').command({ hello: 1 });
    if (!hello.setName || !hello.logicalSessionTimeoutMinutes) throw new Error('TEST_REPLICA_SET_REQUIRED');
    const mongoVersion = (await client.db('admin').command({ buildInfo: 1 })).version;
    const git = await run('git', ['rev-parse', 'HEAD'], process.env, true), dirty = await run('git', ['status', '--porcelain'], process.env, true);
    const metadata = { runId, commit: git.output.trim(), dirty: Boolean(dirty.output.trim()), startedAt, node: process.version,
      mongoVersion, replicaSet: true, disposable: Boolean(mongo), rounds: 10, batchSize: 20, clock: '2035-11-14T17:00:00.000Z',
      sourceSha256: fingerprint(), mode, command: mode === 'foundation' ? 'npm run test:en06:foundation' : 'npm run test:en06' };
    writeFileSync(path.join(directory, 'environment.json'), JSON.stringify(metadata, null, 2));
    const env = { ...process.env, EN04_RUN_ID: runId, EN06_REPORT_DIR: directory, EN06_NOW: metadata.clock,
      JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'), RESET_OTP_PEPPER: '', SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', SMTP_FROM: '',
      FRONTEND_ORIGIN: 'http://localhost:5173', RECEIVING_ACCOUNTS: '["GYM_MAIN"]' };
    const result = await run(process.execPath, [require.resolve('jest/bin/jest'), '--config', 'jest.en06.config.cjs', '--runInBand',
      '--json', '--outputFile', path.join(directory, 'jest.json')], env);
    const report = readJson(path.join(directory, 'cases.json'), { cases: [], setupFailed: true });
    for (const id of IDS) if (!report.cases.some(tc => tc.id === id)) report.cases.push({ id, status: 'NOT_RUN', rounds: [], reason: 'Suite/setup did not finish.', owner: 'EN06' });
    report.cases.sort((a, b) => a.id.localeCompare(b.id));
    writeFileSync(path.join(directory, 'cases.json'), JSON.stringify(report, null, 2));
    const processes = readJson(path.join(directory, 'processes-indexes.json'), {});
    const assessment = assessEn06(report, result.code, processes);
    const acceptance = assessment.acceptancePassed ? 'PASSED' : 'NOT_ACCEPTED';
    const foundation = assessment.foundationPassed ? 'PASSED' : 'FAILED';
    const coverage = { 'EN-06-AC01': [1, 2, 3, 4, 5, 6, 7, 11, 12, 13, 14],
      'EN-06-AC02': [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18], 'EN-06-AC03': [4, 5, 6, 18, 19, 20], 'EN-06-AC04': Array.from({ length: 20 }, (_, i) => i + 1) };
    const criteria = Object.fromEntries(Object.entries(coverage).map(([ac, ids]) => [ac, assessment.acceptancePassed &&
      ids.every(i => report.cases.find(tc => tc.id === IDS[i - 1])?.status === 'PASSED') ? 'PASSED' : 'NOT_ACCEPTED']));
    const summary = { ...metadata, finishedAt: new Date().toISOString(), jestExitCode: result.code, acceptance, foundation, criteria,
      incomplete: assessment.incomplete, cases: report.cases.map(tc => ({ id: tc.id, status: tc.status, rounds: tc.rounds.length, owner: tc.owner, reason: tc.reason })) };
    writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
    const markdown = ['# EN-06 ' + acceptance, '', `Commit: ${metadata.commit}; dirty: ${metadata.dirty}; runId: ${runId}.`,
      `Node ${metadata.node}; MongoDB ${mongoVersion}; replica set; clock ${metadata.clock}; 10 rounds; batch <=20.`,
      `Mode: ${mode}; foundation: ${foundation}; acceptance: ${acceptance}; Jest exit: ${result.code}.`,
      `Source SHA256: ${metadata.sourceSha256}.`, '', ...Object.entries(criteria).map(([ac, status]) => `- ${ac}: ${status}`), '',
      '| TC | Status | Rounds | Triage owner | Missing acceptance scope |', '| --- | --- | --- | --- | --- |',
      ...report.cases.map(tc => `| ${tc.id} | ${tc.status} | ${tc.rounds.length}/10 | ${tc.owner} | ${tc.reason} |`), '',
      'Foundation checks never satisfy retail acceptance. No expiry writer/workers or order/cart/refund fixtures are substituted.',
      'DB before/after, hashes, money totals, checkpoints and resolved outcomes: [cases.json](cases.json).',
      'Actual process IDs and indexes: [processes-indexes.json](processes-indexes.json).',
      'Re-run: `npm run test:en06` (strict acceptance) or `npm run test:en06:foundation` (existing foundation only).', ''].join('\n');
    writeFileSync(path.join(directory, 'report.md'), markdown);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
    console.log(`EN06 evidence: ${directory}\nEN06 foundation: ${foundation}; acceptance: ${acceptance}`);
    process.exitCode = (mode === 'foundation' ? assessment.foundationPassed : assessment.acceptancePassed) ? 0 : 1;
  } catch (error) {
    writeFileSync(path.join(directory, 'summary.json'), JSON.stringify({ runId, startedAt, mode, acceptance: 'NOT_ACCEPTED', foundation: 'FAILED',
      setupFailed: true, failureCode: /^(TEST_|INVALID_)/.test(error.message) ? error.message : 'EN06_SETUP_FAILED' }, null, 2));
    throw error;
  } finally { await client?.close(); await mongo?.stop(); }
}
main().catch(error => { console.error(/^(TEST_|INVALID_|MONGODB_TEST_URI_REQUIRED)/.test(error.message) ? error.message : 'EN06_SETUP_FAILED'); process.exitCode = 1; });
