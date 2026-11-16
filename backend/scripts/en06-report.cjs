// Deliberately separate foundation regression from full EN06 acceptance.
const PARTIAL = Object.freeze(['TC04', 'TC05', 'TC07', 'TC08', 'TC09', 'TC17', 'TC18', 'TC19', 'TC20']);
const IDS = Object.freeze(Array.from({ length: 20 }, (_, i) => `TC${String(i + 1).padStart(2, '0')}`));
const FOUNDATION_BATCH20 = ['TC04', 'TC05', 'TC07', 'TC08', 'TC09'];
function assessEn06(report, jestCode, processes) {
  const cases = Array.isArray(report?.cases) ? report.cases : [];
  const twoApps = Array.isArray(processes?.pids) && processes.pids.length === 2 && new Set(processes.pids).size === 2 &&
    processes.pids.every(pid => Number.isInteger(pid) && pid > 0 && pid !== processes.parentPid);
  const valid = !report?.setupFailed && jestCode === 0 && twoApps && cases.length === 20 &&
    IDS.every(id => cases.filter(tc => tc.id === id).length === 1);
  const complete = tc => Array.isArray(tc.rounds) && tc.rounds.length === 10 && tc.rounds.every((round, i) =>
    round.round === i && round.assertion === 'PASSED' && round.before?.invariants === 'PASSED' && round.after?.invariants === 'PASSED' &&
    round.requests?.length > 0 && round.requests.every(request => request.resolved === true && Number.isInteger(request.outcome) &&
      request.outcome >= 200 && request.outcome < 600 && processes.pids.includes(request.pid)) &&
    new Set(round.requests.map(request => request.pid)).size === 2 &&
    Array.isArray(round.batches) && round.batches.every(batch => batch.size >= 1 && batch.size <= 20) &&
    (!FOUNDATION_BATCH20.includes(tc.id) || round.batches.some(batch => batch.size === 20 && batch.hook && new Set(batch.pids).size === 2)));
  const foundationPassed = valid && cases.every(tc => PARTIAL.includes(tc.id) ? tc.status === 'PARTIAL' && complete(tc) :
    tc.status === 'BLOCKED' && tc.rounds?.length === 0 && typeof tc.reason === 'string' && tc.reason.length > 0);
  const acceptancePassed = valid && Array.isArray(processes.expiryWorkers) && processes.expiryWorkers.length === 2 &&
    new Set(processes.expiryWorkers).size === 2 && processes.expiryWorkers.every(pid => Number.isInteger(pid) && pid > 0 && pid !== processes.parentPid) &&
    cases.every(tc => tc.status === 'PASSED' && complete(tc));
  return { foundationPassed, acceptancePassed, incomplete: cases.filter(tc => tc.status !== 'PASSED').map(tc =>
    ({ id: tc.id, status: tc.status, reason: tc.reason, owner: tc.owner })) };
}
module.exports = { assessEn06, PARTIAL, IDS };
