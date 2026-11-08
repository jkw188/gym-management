const { spawnSync } = require('node:child_process');
const { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const prefixScript = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-prefix.js');
const npmPrefix = existsSync(prefixScript) ? spawnSync(process.execPath, [prefixScript], { encoding: 'utf8', windowsHide: true }).stdout?.trim() : undefined;
const npmCli = [process.env.npm_execpath,
  npmPrefix && path.join(npmPrefix, 'node_modules/npm/bin/npm-cli.js'),
  path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
  path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].find(file => file && existsSync(file));
if (!npmCli) throw new Error('NPM_CLI_NOT_FOUND: use the Node/npm installation documented in README');
const artifactDir = path.join(root, 'artifacts');
mkdirSync(artifactDir, { recursive: true });
const reportFile = path.join(artifactDir, 'quality-gate.json');
const git = args => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : undefined;
};
const npm = args => spawnSync(process.execPath, [npmCli, ...args],
  { cwd: root, encoding: 'utf8', windowsHide: true }).stdout?.trim();
const gitStatus = git(['status', '--porcelain']);
const report = { requirement: 'EN-04', status: 'running', commit: git(['rev-parse', 'HEAD']) || 'unavailable',
  dirty: gitStatus === undefined ? null : gitStatus.length > 0,
  startedAt: new Date().toISOString(), node: process.version, npm: npm(['--version']), platform: `${process.platform}/${process.arch}`,
  mongodb: '8.0.17 (disposable replica set), or MONGODB_TEST_URI with hello check', steps: [] };
const save = () => writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
const steps = [
  ['backend', ['ci', '--no-audit', '--no-fund']], ['frontend', ['ci', '--no-audit', '--no-fund']],
  ['backend', ['run', 'typecheck']], ['backend', ['run', 'typecheck:test']], ['frontend', ['run', 'typecheck']],
  ['backend', ['run', 'build']], ['frontend', ['run', 'build']],
  ['backend', ['run', 'test:unit', '--', '--json', '--outputFile=../artifacts/unit.json'], 'unit.json'],
  ['frontend', ['test', '--', '--pool=threads', '--maxWorkers=1', '--reporter=json', '--outputFile=../artifacts/frontend.json'], 'frontend.json'],
  ['backend', ['run', 'test:integration', '--', '--json', '--outputFile=../artifacts/integration.json'], 'integration.json'],
  ['backend', ['run', 'test:e2e', '--', '--json', '--outputFile=../artifacts/e2e.json'], 'e2e.json'],
];
const requiredTests = {
  'unit.json': ['backend/test/foundation.spec.ts', 'backend/test/auth.spec.ts', 'backend/test/users.spec.ts', 'backend/test/test-database.spec.ts'],
  'integration.json': ['foundation', 'registration', 'auth', 'logout', 'profile', 'users', 'account-security', 'access-roles']
    .map(name => `backend/test/${name}.integration-spec.ts`),
  'frontend.json': ['auth/auth', 'auth/registration', 'auth/logout', 'profile/profile', 'users/users', 'users/account-status', 'users/account-role']
    .map(name => `frontend/src/features/${name}.test.tsx`),
  'e2e.json': ['backend/test/s01.e2e-spec.ts', 'backend/test/database-safety.e2e-spec.ts'],
};
// A repository adding lint later automatically includes it in this gate.
for (const directory of ['backend', 'frontend']) {
  if (JSON.parse(readFileSync(path.join(root, directory, 'package.json'), 'utf8')).scripts.lint) steps.splice(5, 0, [directory, ['run', 'lint']]);
}
save();
for (const [directory, args, resultName] of steps) {
  if (resultName) rmSync(path.join(artifactDir, resultName), { force: true });
  const step = { directory, command: `npm ${args.join(' ')}`, startedAt: new Date().toISOString() };
  console.info(`[EN-04] ${directory}: ${step.command}`);
  const child = spawnSync(process.execPath, [npmCli, ...args], {
    cwd: path.join(root, directory), stdio: 'inherit', windowsHide: true,
    timeout: 20 * 60 * 1000, env: { ...process.env, NODE_ENV: 'test', EN04_EVIDENCE_DIR: artifactDir,
      npm_config_cache: process.env.npm_config_cache || path.join(root, '.cache', 'npm'),
      MONGOMS_DOWNLOAD_DIR: process.env.MONGOMS_DOWNLOAD_DIR || path.join(root, '.cache', 'mongodb-binaries') },
  });
  step.exitCode = child.status ?? 1;
  step.finishedAt = new Date().toISOString();
  if (resultName) {
    const file = path.join(artifactDir, resultName);
    if (existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        const executed = raw.testResults.map(suite => path.relative(root, suite.name).replaceAll('\\', '/'));
        step.missingRequiredFiles = requiredTests[resultName].filter(file => !executed.includes(file));
        step.tests = { passed: raw.numPassedTests, failed: raw.numFailedTests, skipped: raw.numPendingTests,
          suitesPassed: raw.numPassedTestSuites, suitesFailed: raw.numFailedTestSuites };
        // Retain evidence without raw failure messages, HTTP bodies, tokens or environment values.
        writeFileSync(file, JSON.stringify({ ...step.tests, success: raw.success,
          suites: raw.testResults.map(suite => ({ file: path.relative(root, suite.name), status: suite.status,
            tests: suite.assertionResults.map(test => ({ name: test.fullName, status: test.status })) })) }, null, 2) + '\n');
        if (!raw.success || raw.numFailedTests || raw.numPendingTests || !raw.numPassedTests || raw.numFailedTestSuites || step.missingRequiredFiles.length) step.exitCode = 1;
      } catch { step.exitCode = 1; step.reportError = 'INVALID_TEST_REPORT'; }
    } else { step.exitCode = 1; step.reportError = 'MISSING_TEST_REPORT'; }
  }
  report.steps.push(step);
  save();
  if (step.exitCode !== 0) { report.status = 'failed'; report.exitCode = step.exitCode; process.exitCode = step.exitCode; break; }
}
if (report.status === 'running') { report.status = 'passed'; report.exitCode = 0; }
report.finishedAt = new Date().toISOString();
save();
console.info('[EN-04] Evidence: artifacts/quality-gate.json');
