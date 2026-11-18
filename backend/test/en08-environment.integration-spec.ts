import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// A valid-looking personal .env must not supply test DB/JWT settings. No real server is contacted.
describe('EN08 F02/F03 real bootstrap ignores personal .env in NODE_ENV=test', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'gym-en08-env-'));
  const envFile = path.join(directory, '.env');
  beforeAll(() => writeFileSync(envFile, ['MONGODB_URI=mongodb://127.0.0.1:1/gym_test_env_probe', 'MONGODB_DB=gym_test_env_probe',
    'JWT_ACCESS_SECRET=EN08_DEMO_ONLY_PERSONAL_SECRET_1234567890', 'FRONTEND_ORIGIN=http://localhost:5173', 'PORT=3000'].join('\n')));
  afterAll(() => { unlinkSync(envFile); rmdirSync(directory); });
  it.each(['server', 'admin'] as const)('%s rejects missing explicit test configuration before attempting a connection', async target => {
    const file = path.resolve(__dirname, target === 'server' ? '../dist/main.js' : '../scripts/admin.cjs');
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
    for (const name of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[name]) env[name] = process.env[name];
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [file, ...(target === 'admin' ? ['ensure-indexes'] : [])], { cwd: directory, env, windowsHide: true });
      let output = '';
      child.stdout.on('data', chunk => { output += String(chunk); }); child.stderr.on('data', chunk => { output += String(chunk); });
      const timer = setTimeout(() => { child.kill(); reject(new Error('EN08_ENV_PROBE_TIMEOUT')); }, 15000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); resolve({ code, output }); });
    });
    expect(result.code).not.toBe(0); expect(result.output).toContain(target === 'server' ? 'STARTUP_FAILED' : 'CONFIGURATION_ERROR');
    expect(result.output).toContain('MONGODB_URI'); expect(result.output).toContain('MONGODB_DB');
    expect(result.output).not.toContain('EN08_DEMO_ONLY_PERSONAL_SECRET');
    expect(result.output).not.toContain('MongoServerSelectionError');
  });
});
