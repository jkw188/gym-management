// Run one npm command with a bounded timeout and clean up its descendants (npm -> shell -> Jest/Nest).
const { spawn, spawnSync } = require('node:child_process');
function stopTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    if (result.status !== 0 && child.exitCode === null) { console.error('QUALITY_TREE_STOP_FAILED'); child.kill(); }
  }
  else { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); } }
}
async function run() {
  const [duration, ...args] = process.argv.slice(2), timeout = Number(duration);
  if (!/^\d+$/.test(duration ?? '') || timeout < 60000 || timeout > 3600000 || !args.length) throw new Error('INVALID_QUALITY_STEP');
  const child = spawn(process.execPath, args, { env: process.env, cwd: process.cwd(), stdio: 'inherit', windowsHide: true,
    detached: process.platform !== 'win32' });
  let outcome, force;
  const stop = code => {
    outcome = code; stopTree(child);
    if (process.platform !== 'win32') force = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } }, 5000);
  };
  const timer = setTimeout(() => stop(124), timeout);
  const interrupt = () => stop(130), terminate = () => stop(143);
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  const code = await new Promise(resolve => { child.once('error', () => resolve(1)); child.once('exit', code => resolve(code ?? 1)); });
  clearTimeout(timer); clearTimeout(force); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
  process.exitCode = outcome ?? code;
}
if (require.main === module) run().catch(() => { console.error('QUALITY_STEP_FAILED'); process.exitCode = 1; });
module.exports = { stopTree };
