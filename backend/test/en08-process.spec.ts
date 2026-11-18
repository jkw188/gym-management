import { spawn, ChildProcess } from 'node:child_process';
const { stopTree } = require('../../scripts/quality-step.cjs') as { stopTree(child: ChildProcess): void };

describe('EN08 process cleanup for bounded quality steps', () => {
  it('stops an owned command and its descendant so timed-out tests cannot run beside the next gate', async () => {
    const child = spawn(process.execPath, ['-e', "const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000);"],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    let descendant: number | undefined;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    try {
      descendant = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('EN08_PROCESS_PROBE_START_TIMEOUT')), 5000);
        child.stdout!.once('data', chunk => { clearTimeout(timer); resolve(Number(String(chunk).trim())); });
        child.once('error', error => { clearTimeout(timer); reject(error); });
      });
      expect(Number.isInteger(descendant) && descendant > 0).toBe(true);
      stopTree(child);
      await Promise.race([exited, new Promise((_, reject) => { stopTimer = setTimeout(() => reject(new Error('EN08_PROCESS_PROBE_STOP_TIMEOUT')), 7000); })]);
      const deadline = Date.now() + 3000;
      let alive = true;
      while (alive && Date.now() < deadline) {
        try { process.kill(descendant!, 0); await new Promise(resolve => setTimeout(resolve, 25)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; alive = false; }
      }
      expect(alive).toBe(false);
    } finally {
      clearTimeout(stopTimer);
      stopTree(child);
      if (descendant) { try { process.kill(descendant); } catch { /* stopped */ } }
    }
  }, 20000);
});
