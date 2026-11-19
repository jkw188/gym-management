const { assessEn06, PARTIAL, IDS } = require('../scripts/en06-report.cjs') as {
  assessEn06: (report: unknown, code: number, processes: unknown) => { foundationPassed: boolean; acceptancePassed: boolean };
  PARTIAL: string[]; IDS: string[];
};
const processes = { pids: [101, 102], parentPid: 100, expiryWorkers: [] as number[] };
function foundation() {
  return { cases: IDS.map(id => ({ id, status: PARTIAL.includes(id) ? 'PARTIAL' : 'BLOCKED', reason: 'Missing retail writer',
    rounds: PARTIAL.includes(id) ? Array.from({ length: 10 }, (_, round) => ({ round, assertion: 'PASSED', before: { invariants: 'PASSED' },
      after: { invariants: 'PASSED' }, batches: [{ size: 20, pids: [101, 102], hook: 'guard' }],
      requests: [{ pid: 101, resolved: true, outcome: 200 }, { pid: 102, resolved: true, outcome: 409 }] })) : [] })) };
}
describe('EN06 reporting fails closed; foundation is never acceptance', () => {
  it('allows known foundation coverage but refuses acceptance', () => {
    expect(assessEn06(foundation(), 0, processes)).toMatchObject({ foundationPassed: true, acceptancePassed: false });
  });
  it.each(['unknown', 'oracle', 'rounds', 'case', 'pid', 'exit', 'batch', 'foreignPid'])('rejects incomplete evidence: %s', problem => {
    const report = foundation(), apps = { ...processes };
    const partial = report.cases.find(tc => tc.rounds.length)!;
    if (problem === 'unknown') partial.rounds[0].requests[0].resolved = false;
    if (problem === 'oracle') partial.rounds[0].after.invariants = 'FAILED';
    if (problem === 'rounds') partial.rounds.pop();
    if (problem === 'case') report.cases.pop();
    if (problem === 'pid') apps.pids = [101, 101];
    if (problem === 'batch') partial.rounds[0].batches[0].size = 2;
    if (problem === 'foreignPid') partial.rounds[0].requests[0].pid = 999;
    expect(assessEn06(report, problem === 'exit' ? 1 : 0, apps)).toMatchObject({ foundationPassed: false, acceptancePassed: false });
  });
  it('requires both expiry workers even when all case labels claim pass', () => {
    const report = foundation(), example = report.cases.find(tc => tc.rounds.length)!.rounds;
    for (const tc of report.cases) { tc.status = 'PASSED'; tc.rounds = structuredClone(example); }
    expect(assessEn06(report, 0, processes).acceptancePassed).toBe(false);
    expect(assessEn06(report, 0, { ...processes, expiryWorkers: [101, 102] }).acceptancePassed).toBe(true);
  });
  // US-41 nhóm A: ca đã lên PASSED vẫn giữ foundation hợp lệ, nhưng phải đủ bằng chứng như PARTIAL; foundation không được lùi về BLOCKED.
  it('accepts a blocked or partial case promoted to PASSED with complete rounds, still not acceptance', () => {
    const report = foundation(), example = report.cases.find(tc => tc.rounds.length)!.rounds;
    for (const id of ['TC01', 'TC04']) Object.assign(report.cases.find(tc => tc.id === id)!, { status: 'PASSED', rounds: structuredClone(example) });
    expect(assessEn06(report, 0, processes)).toMatchObject({ foundationPassed: true, acceptancePassed: false });
  });
  it.each(['passedWithoutRounds', 'partialRegressedToBlocked'])('rejects promoted cases without evidence: %s', problem => {
    const report = foundation();
    if (problem === 'passedWithoutRounds') Object.assign(report.cases.find(tc => tc.id === 'TC01')!, { status: 'PASSED', rounds: [] });
    if (problem === 'partialRegressedToBlocked') Object.assign(report.cases.find(tc => tc.id === 'TC04')!, { status: 'BLOCKED', rounds: [] });
    expect(assessEn06(report, 0, processes).foundationPassed).toBe(false);
  });
  it('rejects malformed reports without throwing', () => {
    expect(assessEn06({}, 0, {}).acceptancePassed).toBe(false);
  });
});
