const path = require('node:path');
const IDS = Object.freeze(Array.from({ length: 20 }, (_, i) => `TC${String(i + 1).padStart(2, '0')}`));
// EN08 has no inherited exception for TODO/skip, including in a later S01-S08 suite.
function assessTests(raw, required, root) {
  const suites = Array.isArray(raw?.testResults) ? raw.testResults : [];
  const files = suites.map(s => path.relative(root, s.name).replaceAll('\\', '/'));
  const missing = required.filter(f => !files.includes(f));
  const incomplete = suites.flatMap(s => (s.assertionResults ?? []).filter(t => t.status !== 'passed').map(t => ({ file: path.relative(root, s.name).replaceAll('\\', '/'), name: t.fullName, status: t.status })));
  const assertions = suites.reduce((n, s) => n + (s.assertionResults?.length ?? 0), 0);
  const passed = raw?.success === true && raw.numFailedTests === 0 && raw.numFailedTestSuites === 0 &&
    (raw.numPendingTests ?? 0) === 0 && (raw.numTodoTests ?? 0) === 0 && raw.numPassedTests > 0 && raw.numPassedTests === assertions &&
    suites.length > 0 && suites.every(s => s.status === 'passed' && s.assertionResults?.length > 0) && missing.length === 0 && incomplete.length === 0;
  return { passed, missing, incomplete, assertions };
}
function assessRelease(run) {
  const validMetadata = /^[a-f\d]{40}$/.test(run?.commit ?? '') && /^[a-f\d]{12}$/.test(run?.runId ?? '') && run.dirty === false && run.sourceUnchanged === true &&
    run.node === 'v24.13.0' && run.npm === '11.11.1' && /^[a-f\d]{64}$/.test(run.sourceSha256 ?? '') &&
    ['backend', 'frontend'].every(k => /^[a-f\d]{64}$/.test(run.lockfiles?.[k] ?? ''));
  const cases = Array.isArray(run?.cases) ? run.cases : [];
  const steps = Array.isArray(run?.steps) ? run.steps : [];
  const stepsPassed = ['EN04', 'EN05', 'EN06', 'S07', 'GATE_PROBE'].every(id => steps.filter(s => s.id === id).length === 1 && steps.find(s => s.id === id).status === 'PASS');
  const casesPassed = cases.length === 20 && IDS.every(id => cases.filter(tc => tc.id === id).length === 1 &&
    cases.find(tc => tc.id === id).status === 'PASS' && cases.find(tc => tc.id === id).evidence?.length > 0);
  const accepted = validMetadata && stepsPassed && casesPassed && run.traceabilityReviewed === true && run.openCriticalDefects === 0;
  return { acceptance: accepted ? 'ACCEPTED' : 'NOT_ACCEPTED', exitCode: accepted ? 0 : 1,
    criteria: Object.fromEntries([[1, IDS.slice(0, 6)], [2, IDS.slice(6, 12)], [3, IDS.slice(12, 17)], [4, IDS.slice(17)]].map(([n, ids]) =>
      [`EN-08-AC0${n}`, accepted && ids.every(id => cases.find(tc => tc.id === id)?.status === 'PASS') ? 'PASS' : 'NOT_ACCEPTED'])),
    incomplete: cases.filter(tc => tc.status !== 'PASS').map(tc => ({ id: tc.id, status: tc.status, reason: tc.reason })) };
}
function assessS07(report, processes) {
  const cases = report?.cases ?? [], pids = processes?.pids ?? [];
  return pids.length === 2 && new Set(pids).size === 2 && pids.every(p => Number.isInteger(p) && p > 0 && p !== processes.parentPid) &&
    cases.length === 3 && ['S07-RETURN', 'S07-PAYOUT', 'S07-BROADCAST'].every(id => cases.filter(tc => tc.id === id).length === 1 && cases.some(tc => tc.id === id && tc.status === 'PASS' &&
      tc.rounds.length === 10 && tc.rounds.every((r, i) => r.round === i && r.status === 'PASS' && r.before?.invariants === 'PASSED' && r.after?.invariants === 'PASSED' &&
        r.before?.returns?.invariants === 'PASS' && r.after?.returns?.invariants === 'PASS' &&
        r.requests.length >= 20 && r.requests.every(q => q.resolved === true && pids.includes(q.pid) && Number.isInteger(q.status) && q.status >= 200 && q.status < 500) &&
        new Set(r.requests.map(q => q.pid)).size === 2)));
}
function assessEn04(quality, reports, required, commit) {
  if (quality?.status !== 'passed' || quality.commit !== commit || !Array.isArray(quality.steps) || quality.steps.some(s => s.exitCode !== 0)) return false;
  return ['unit', 'frontend', 'integration', 'e2e'].every(name => {
    const raw = reports[name], suites = raw?.suites ?? [];
    const files = suites.map(s => s.file.replaceAll('\\', '/'));
    const assertions = suites.flatMap(s => s.tests ?? []);
    return raw?.success === true && raw.failed === 0 && raw.skipped === 0 && raw.todo === 0 && raw.passed > 0 &&
      assertions.length === raw.passed && suites.length > 0 && suites.every(s => s.status === 'passed' && s.tests?.length > 0 && s.tests.every(t => t.status === 'passed')) &&
      required[name]?.length > 0 && required[name].every(file => files.includes(file));
  });
}
module.exports = { IDS, assessTests, assessRelease, assessS07, assessEn04 };
