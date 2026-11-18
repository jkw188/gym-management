// Create an honest draft; no URL, provider, evidence or release acceptance is inferred.
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const git = args => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error('GIT_RECORD_UNAVAILABLE');
  return result.stdout.trim();
};
const output = path.resolve(process.argv[2] || path.join(root, 'artifacts/en07-deployment.json'));
// A fixed command observes npm on PATH, which can differ from the npm bundled next to node.exe.
const npmVersion = spawnSync('npm --version', { shell: true, encoding: 'utf8', windowsHide: true }).stdout?.trim();
const record = {
  requirement: 'EN-07', status: 'PREPARED_NOT_DEPLOYED', recordedAt: new Date().toISOString(),
  source: { commit: git(['rev-parse', 'HEAD']), dirty: Boolean(git(['status', '--porcelain'])),
    nodeObserved: process.version, nodeRequired: fs.readFileSync(path.join(root, '.nvmrc'), 'utf8').trim(),
    npmObserved: /^\d+\.\d+\.\d+$/.test(npmVersion || '') ? npmVersion : null,
    packageManager: JSON.parse(fs.readFileSync(path.join(root, 'backend/package.json'), 'utf8')).packageManager,
    lockfiles: Object.fromEntries(['backend', 'frontend'].map(directory => [directory,
      createHash('sha256').update(fs.readFileSync(path.join(root, directory, 'package-lock.json'))).digest('hex')])) },
  topology: { backendInstances: 1, proxy: 'Caddy', routes: ['/api', '/socket.io', 'SPA'], database: 'external transaction-capable MongoDB' },
  operator: null, provider: null, serviceIdentifiers: [], costs: null, httpsUrl: null, databaseIdentifier: null,
  artifacts: { backendImageDigest: null, webImageDigest: null, previousCommit: null, configVersion: null },
  acceptance: 'NOT_EVALUATED', en08: { status: 'NOT_RUN', commit: null, url: null, evidence: null },
  tests: Array.from({ length: 15 }, (_, i) => ({ id: `TC${String(i + 1).padStart(2, '0')}`, status: 'NOT_RUN', observedAt: null, operator: null, evidence: null })),
  backup: { locationReference: null, archiveSha256: null, toolVersion: null, restoreDatabase: null, backupMs: null, restoreMs: null, verified: false },
  rollback: { occurred: false, commit: null, reason: null, startedAt: null, completedAt: null, verificationEvidence: null },
  blockedDependencies: ['UAT_INFRASTRUCTURE_NOT_PROVIDED', 'WEBSITE_CHECKOUT_NOT_IMPLEMENTED', 'REPORTS_NOT_IMPLEMENTED', 'EN08_NOT_RUN'],
};
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(record, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.info('EN07_DEPLOYMENT_DRAFT_CREATED');
