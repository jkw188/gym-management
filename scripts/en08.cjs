const { spawn, spawnSync } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { IDS, assessTests, assessRelease, assessS07, assessEn04 } = require('./en08-evidence.cjs');
const { stopTree } = require('./quality-step.cjs');
const root = path.resolve(__dirname, '..'), backend = path.join(root, 'backend');
const backendRequire = createRequire(path.join(backend, 'package.json'));
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const write = (file, data) => writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { flag: 'w' });
const git = args => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error('EN08_GIT_UNAVAILABLE');
  return result.stdout.trim();
};
function resolveNpmCli() {
  const prefixScript = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-prefix.js');
  const prefix = existsSync(prefixScript) ? spawnSync(process.execPath, [prefixScript], { encoding: 'utf8', windowsHide: true }).stdout?.trim() : undefined;
  const candidates = [process.env.npm_execpath, prefix && path.join(prefix, 'node_modules/npm/bin/npm-cli.js'),
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')];
  const cli = candidates.find(p => p && existsSync(p));
  if (!cli) throw new Error('EN08_NPM_CLI_NOT_FOUND');
  return cli;
}
function fingerprint() {
  const files = git(['ls-files', '--cached', '--others', '--exclude-standard']).split(/\r?\n/).filter(Boolean).sort();
  const hash = createHash('sha256');
  for (const file of files) { hash.update(file); hash.update(existsSync(path.join(root, file)) ? readFileSync(path.join(root, file)) : 'DELETED'); }
  return hash.digest('hex');
}
function execute(args, cwd, env, timeout = 45 * 60000) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: 'inherit', windowsHide: true, detached: process.platform !== 'win32' });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; stopTree(child); }, timeout);
    const stop = () => stopTree(child); process.once('SIGTERM', stop); process.once('SIGINT', stop);
    const finish = code => { clearTimeout(timer); process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); resolve(timedOut ? 124 : code ?? 1); };
    child.once('error', () => finish(1)); child.once('exit', finish);
  });
}
function sanitizeJest(raw) {
  return { success: raw.success, numPassedTests: raw.numPassedTests, numFailedTests: raw.numFailedTests, numPendingTests: raw.numPendingTests,
    numTodoTests: raw.numTodoTests, numPassedTestSuites: raw.numPassedTestSuites, numFailedTestSuites: raw.numFailedTestSuites,
    testResults: (raw.testResults ?? []).map(s => ({ name: s.name, status: s.status, assertionResults: (s.assertionResults ?? []).map(t => ({ fullName: t.fullName, status: t.status })) })) };
}
async function gateProbe(directory, env) {
  const results = [];
  for (const mode of ['passed', 'failed', 'skipped']) {
    const file = path.join(directory, `${mode}.probe.cjs`), output = path.join(directory, `${mode}.json`);
    const action = mode === 'failed' ? "test('mandatory', () => expect(1).toBe(2));" : mode === 'skipped' ? "test.skip('mandatory', () => {});" : "test('mandatory', () => expect(1).toBe(1));";
    writeFileSync(file, "test('control', () => expect(true).toBe(true));\n" + action + '\n');
    const exitCode = await execute([backendRequire.resolve('jest/bin/jest'), '--config', JSON.stringify({ rootDir: directory, testRegex: '\\.probe\\.cjs$', testEnvironment: 'node' }),
      '--runInBand', '--runTestsByPath', file, '--json', '--outputFile', output], backend, env, 60000);
    const raw = existsSync(output) ? read(output) : null;
    const assessed = assessTests(raw, [path.relative(root, file).replaceAll('\\', '/')], root);
    const expected = mode === 'passed';
    results.push({ mode, exitCode, gatePassed: assessed.passed, expectedGatePassed: expected,
      status: raw && assessed.passed === expected && (mode === 'failed' ? exitCode !== 0 : exitCode === 0) ? 'PASS' : 'FAIL' });
    if (raw) write(output, sanitizeJest(raw));
  }
  write(path.join(directory, 'probe.json'), results);
  return results.every(r => r.status === 'PASS');
}
function inventory() {
  const matrix = read(path.join(__dirname, 'en08-matrix.json'));
  const missing = [];
  for (const row of matrix.requirements) {
    for (const file of [...row.sourceCandidates, ...row.testCandidates]) if (!existsSync(path.join(root, file))) missing.push({ id: row.id, file });
    const requirement = path.join(root, row.requirement);
    row.requirementAvailable = existsSync(requirement);
    row.requirementMatches = row.requirementAvailable && createHash('sha256').update(readFileSync(requirement)).digest('hex') === row.requirementSha256;
  }
  return { ...matrix, missing, acceptance: 'NOT_REVIEWED' };
}
function requiredTests() {
  const backendTests = readdirSync(path.join(backend, 'test'));
  const frontendTests = [];
  const visit = dir => { for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name); if (entry.isDirectory()) visit(file); else if (/\.test\.tsx?$/.test(entry.name)) frontendTests.push(path.relative(root, file).replaceAll('\\', '/'));
  } };
  visit(path.join(root, 'frontend/src'));
  return { unit: backendTests.filter(n => /\.spec\.ts$/.test(n)).map(n => `backend/test/${n}`),
    integration: backendTests.filter(n => /\.integration-spec\.ts$/.test(n)).map(n => `backend/test/${n}`),
    e2e: backendTests.filter(n => /\.e2e-spec\.ts$/.test(n)).map(n => `backend/test/${n}`), frontend: frontendTests };
}
async function main() {
  if (process.argv.length !== 2) throw new Error('EN08_NO_BYPASS_ARGUMENTS');
  if (process.env.NODE_ENV && process.env.NODE_ENV !== 'test') throw new Error('TEST_NODE_ENV_REQUIRED');
  // Validate an external test URI against the ORIGINAL dev configuration before removing personal settings.
  if (process.env.MONGODB_TEST_URI) backendRequire('./scripts/test-database.cjs').validateTestEnvironment({ ...process.env, NODE_ENV: 'test' });
  const runId = randomBytes(6).toString('hex'), directory = path.join(root, 'artifacts', `en08-${runId}`);
  mkdirSync(directory, { recursive: true });
  const sourceSha256 = fingerprint(), dirty = git(['status', '--porcelain']).length > 0;
  const npmCli = resolveNpmCli();
  const npmVersion = spawnSync(process.execPath, [npmCli, '--version'], { encoding: 'utf8', windowsHide: true }).stdout.trim();
  // Allowlist: do not propagate UAT/dev URI, credentials, mail or worker settings into tests.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SystemRoot|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|HOME|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|CI|GITHUB_ACTIONS)$/i.test(key)));
  Object.assign(env, { NODE_ENV: 'test', TZ: 'Asia/Ho_Chi_Minh', npm_config_cache: process.env.npm_config_cache || path.join(root, '.cache/npm'),
    MONGOMS_DOWNLOAD_DIR: process.env.MONGOMS_DOWNLOAD_DIR || path.join(root, '.cache/mongodb-binaries'), npm_execpath: npmCli, npm_node_execpath: process.execPath });
  if (process.env.MONGODB_TEST_URI) env.MONGODB_TEST_URI = process.env.MONGODB_TEST_URI;
  const run = { requirement: 'EN-08', runId, commit: git(['rev-parse', 'HEAD']), dirty, sourceSha256, sourceUnchanged: false,
    startedAt: new Date().toISOString(), timezone: 'Asia/Ho_Chi_Minh', node: process.version, npm: npmVersion,
    platform: `${process.platform}/${process.arch}`, command: 'node scripts/en08.cjs', lockfiles: Object.fromEntries(['backend', 'frontend'].map(k =>
      [k, createHash('sha256').update(readFileSync(path.join(root, k, 'package-lock.json'))).digest('hex')])),
    traceabilityReviewed: false, openCriticalDefects: null, steps: [], cases: [] };
  const save = () => write(path.join(directory, 'summary.json'), { ...run, ...assessRelease(run) });
  save();
  try {
    write(path.join(directory, 'traceability.json'), inventory());
    const step = async (id, command, args, cwd, extra = {}, verify) => {
      const row = { id, command, startedAt: new Date().toISOString(), status: 'FAIL', exitCode: null, evidence: [] };
      run.steps.push(row); save(); console.info(`[EN08] ${id}: ${command}`);
      row.exitCode = await execute(args, cwd, { ...env, ...extra });
      row.finishedAt = new Date().toISOString();
      row.status = row.exitCode === 0 ? 'PASS' : 'FAIL';
      try { if (verify && !await verify(row)) row.status = 'FAIL'; } catch { row.status = 'FAIL'; row.failureCode = 'EN08_MISSING_OR_INVALID_EVIDENCE'; }
      save(); return row;
    };
    const en04 = path.join(directory, 'en04'); mkdirSync(en04);
    const required = requiredTests(); write(path.join(directory, 'mandatory-suites.json'), required);
    await step('EN04', 'node scripts/quality-gate.cjs --continue-on-failure', [path.join(__dirname, 'quality-gate.cjs'), '--continue-on-failure'], root, { EN04_EVIDENCE_DIR: en04 }, row => {
      row.evidence = ['en04/quality-gate.json']; const quality = read(path.join(en04, 'quality-gate.json'));
      // EN04 sanitizes its JSON. EN08 still rejects every TODO in implemented S01-S08 tests.
      return assessEn04(quality, Object.fromEntries(['unit', 'frontend', 'integration', 'e2e'].map(name => [name, read(path.join(en04, `${name}.json`))])), required, run.commit);
    });
    for (const id of ['EN05', 'EN06']) {
      const before = new Set(readdirSync(path.join(root, 'artifacts'))), script = `test:${id.toLowerCase()}`;
      await step(id, `npm run ${script}`, [npmCli, 'run', script], backend, {}, row => {
        const added = readdirSync(path.join(root, 'artifacts')).filter(n => n.startsWith(`${id.toLowerCase()}-`) && !before.has(n));
        if (added.length !== 1) return false;
        const evidence = path.join(root, 'artifacts', added[0]), summary = read(path.join(evidence, 'summary.json'));
        row.evidence = [path.relative(directory, evidence).replaceAll('\\', '/')];
        return summary.acceptance === 'PASSED' && summary.commit === run.commit;
      });
    }
    const s07 = path.join(directory, 's07'); mkdirSync(s07);
    // Fresh, owned test replica set, never a personal .env. Guarded lease is shared by both child processes.
    let mongo;
    try {
      let uri = env.MONGODB_TEST_URI;
      if (!uri) { mongo = await backendRequire('mongodb-memory-server').MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1, storageEngine: 'wiredTiger' } }); uri = mongo.getUri('gym_test_en08'); }
      const rawFile = path.join(s07, 'jest.json');
      const required = ['backend/test/en08.concurrency-spec.ts'];
      await step('S07', 'jest --config jest.en08.config.cjs --runInBand', [backendRequire.resolve('jest/bin/jest'), '--config', 'jest.en08.config.cjs', '--runInBand', '--json', '--outputFile', rawFile], backend,
        { MONGODB_TEST_URI: uri, EN04_RUN_ID: runId, EN06_REPORT_DIR: s07, EN06_NOW: '2035-11-14T17:00:00.000Z',
          JWT_ACCESS_SECRET: randomBytes(32).toString('base64url'), RETAIL_QUOTE_SECRET: randomBytes(32).toString('base64url'), PICKUP_LOCATION: 'EN08 DEMO ONLY counter' }, row => {
          const raw = read(rawFile); const passed = assessTests(raw, required, root).passed && assessS07(read(path.join(s07, 's07-cases.json')), read(path.join(s07, 'processes-indexes.json')));
          write(rawFile, sanitizeJest(raw)); row.evidence = ['s07/jest.json', 's07/s07-cases.json', 's07/processes-indexes.json']; return passed;
        });
    } finally { await mongo?.stop(); }
    const probe = path.join(directory, 'gate-probe'); mkdirSync(probe);
    const probeStartedAt = new Date().toISOString(), probePassed = await gateProbe(probe, env);
    run.steps.push({ id: 'GATE_PROBE', command: 'Jest control/fail/skip in isolated artifact directory', startedAt: probeStartedAt, finishedAt: new Date().toISOString(),
      status: probePassed ? 'PASS' : 'FAIL', exitCode: probePassed ? 0 : 1, evidence: ['gate-probe/probe.json'] });
    const reasons = [
      'AC-level permission/owner matrix needs review; missing US20/35/36/37/40/41 source coverage.',
      'Auth/socket/replay suites are candidates; four-role cross-feature coverage is not yet reviewed.',
      'Self-service UPGRADE US20 is absent; inherited EN05 acceptance remains incomplete.',
      'Full EN05/EN06 acceptance required; regression/foundation is insufficient.',
      'Return/payout batch20 covered; all ISSUE/ADJUST conflict pairs still need ten-round evidence.',
      'Broadcast batch20 covered; review/reopen/completion/reminder need two-process ten-round evidence.',
      'US50 report API/UI absent; reference oracle is not actual report comparison.',
      'US50 historical snapshot/drill-down API absent.',
      'US51 API/UI and committed-source oracle suite exist; frozen-candidate AC review and full EN08 evidence remain required.',
      'US51 period/precision/filter/snapshot suite exists; full EN08 frozen-candidate results and operator review remain required.',
      'US52 performance API/UI absent; reference oracle is not actual report comparison.',
      'US52 attendance/review drill-down API absent.',
      'Inherited faults run; full S07 source/ledger/quota/refund/audit/outbox/key fault inventory needs review.',
      'Inherited response-loss resolution runs; missing WEBSITE and full S07 resolve evidence.',
      'EN07 UAT restart/worker/socket and source before/after evidence missing.',
      'Database safety must pass EN04 database-safety.e2e-spec.ts and test-database.spec.ts.',
      'EN07 HTTPS UAT URL and four-role browser/cookie/realtime smoke are unavailable.',
      'Traceability candidates recorded; AC-specific review and UC38/report/schema/OpenAPI synchronization blocked by missing stories.',
      'Isolated Jest failure/skip probes must be rejected by the strict gate.',
      'Independent operator rerun, frozen clean commit, EN07 restore/report verification and reviewed defect decisions are missing.',
    ];
    run.cases = IDS.map((id, i) => ({ id, requirement: i < 6 ? 'EN-08-AC01' : i < 12 ? 'EN-08-AC02' : i < 17 ? 'EN-08-AC03' : 'EN-08-AC04',
      status: 'BLOCKED', reason: reasons[i], expected: 'All checks in requirement TC completed on the frozen candidate', actual: reasons[i],
      command: run.command, timestamp: new Date().toISOString(), timezone: run.timezone, fixture: 'test/fixtures/en08-reports.cjs (reference only)',
      evidence: [], exitCode: null }));
    for (const [id, stepId] of [['TC16', 'EN04'], ['TC19', 'GATE_PROBE']]) {
      const tc = run.cases.find(tc => tc.id === id), tested = run.steps.find(s => s.id === stepId);
      tc.status = tested.status; tc.evidence = tested.evidence; tc.exitCode = tested.exitCode; tc.actual = `${stepId}: ${tested.status}`;
    }
    const safety = run.cases.find(tc => tc.id === 'TC16');
    try {
      const suites = ['unit', 'e2e'].flatMap(name => read(path.join(en04, `${name}.json`)).suites);
      const requiredSafety = ['backend/test/test-database.spec.ts', 'backend/test/database-safety.e2e-spec.ts'];
      const found = requiredSafety.map(file => suites.find(s => s.file.replaceAll('\\', '/') === file));
      safety.status = found.some(s => !s) ? 'NOT_RUN' : found.every(s => s.status === 'passed' && s.tests.length && s.tests.every(t => t.status === 'passed')) ? 'PASS' : 'FAIL';
      safety.evidence = ['en04/unit.json', 'en04/e2e.json']; safety.exitCode = safety.status === 'PASS' ? 0 : 1;
      safety.actual = `${requiredSafety.join(', ')}: ${safety.status}`;
    } catch { safety.status = 'NOT_RUN'; safety.actual = 'Required safety report unavailable'; }
    // A regression failure is visible even when the broader case is also blocked by missing scope.
    for (const [id, stepId] of [['TC01', 'EN04'], ['TC04', 'EN05'], ['TC05', 'S07'], ['TC06', 'S07']]) {
      if (run.steps.find(s => s.id === stepId)?.status === 'FAIL') { const tc = run.cases.find(tc => tc.id === id); tc.status = 'FAIL'; tc.evidence = run.steps.find(s => s.id === stepId).evidence; }
    }
  } catch (error) {
    run.failureCode = /^(EN08_|TEST_)/.test(error.message) ? error.message : 'EN08_RUN_FAILED';
  } finally {
    for (const id of IDS) if (!run.cases.some(tc => tc.id === id)) run.cases.push({ id, status: 'NOT_RUN', reason: run.failureCode || 'Runner did not reach this case', evidence: [] });
    run.sourceUnchanged = fingerprint() === sourceSha256; run.finishedAt = new Date().toISOString(); save();
    const assessment = assessRelease(run);
    write(path.join(directory, 'defects.json'), { reviewed: false, owner: 'UNASSIGNED', retestCommit: null,
      blockers: assessment.incomplete.map(tc => ({ id: `EN08-${tc.id}`, severity: 'RELEASE_BLOCKER', ownerRequirement: run.cases.find(c => c.id === tc.id)?.requirement,
        status: tc.status, reproduction: run.command, evidence: run.cases.find(c => c.id === tc.id)?.evidence ?? [], reason: tc.reason })) });
    writeFileSync(path.join(directory, 'report.md'), ['# EN-08 ' + assessment.acceptance, '',
      `Commit: ${run.commit}; dirty: ${run.dirty}; runId: ${runId}; source SHA256: ${sourceSha256}.`,
      `Timezone: ${run.timezone}; Node ${run.node}; npm ${run.npm}.`, '',
      '| TC | Status | Missing scope / reason |', '| --- | --- | --- |', ...run.cases.map(tc => `| ${tc.id} | ${tc.status} | ${tc.reason} |`), '',
      'Reference oracle tests do not establish report acceptance. See summary.json, traceability.json, inherited run directories and docs/en08-runbook.md.', ''].join('\n'));
    console.info(`[EN08] ${assessment.acceptance}; evidence: ${path.relative(root, directory)}`); process.exitCode = assessment.exitCode;
  }
}
if (require.main === module) main().catch(error => { console.error(/^(EN08_|TEST_)/.test(error.message) ? error.message : 'EN08_SETUP_FAILED'); process.exitCode = 1; });
module.exports = { fingerprint, inventory, gateProbe, requiredTests, resolveNpmCli };
