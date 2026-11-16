import path from 'node:path';

interface TestResult { fullName: string; status: string }
interface RawReport {
  success: boolean; numPassedTests: number; numFailedTests: number; numPendingTests: number; numTodoTests: number;
  numPassedTestSuites: number; numFailedTestSuites: number;
  testResults: { name: string; status: string; assertionResults: TestResult[] }[];
}
interface Round { round: number; assertion: string; before: { invariants: string }; after: { invariants: string } }
interface En05Case { id: string; status: string; rounds: Round[] }
const { assessQualityReport, assessEn05Report } = require('../../scripts/test-report.cjs') as {
  assessQualityReport: (raw: RawReport, required: string[], root: string) => {
    passed: boolean; tests: { skipped: number; todo: number }; missingRequiredFiles: string[];
  };
  assessEn05Report: (report: { cases: En05Case[]; setupFailed?: boolean }, jestCode: number, clientCode: number) => {
    acceptancePassed: boolean; regressionPassed: boolean; incomplete: { id: string; status: string }[];
  };
};
const root = path.resolve(__dirname, '../..'), required = ['backend/test/auth.integration-spec.ts'];
function quality(): RawReport {
  return { success: true, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
    numPassedTestSuites: 1, numFailedTestSuites: 0,
    testResults: [{ name: path.join(root, required[0]), status: 'passed', assertionResults: [{ fullName: 'real auth', status: 'passed' }] }] };
}
function en05(): { cases: En05Case[]; setupFailed?: boolean } {
  return { cases: Array.from({ length: 20 }, (_, i) => ({ id: `TC${String(i + 1).padStart(2, '0')}`, status: 'PASSED',
    rounds: Array.from({ length: 10 }, (_, round) => ({ round, assertion: 'PASSED', before: { invariants: 'PASSED' }, after: { invariants: 'PASSED' } })) })) };
}
function incomplete() {
  const report = en05();
  report.cases.find(tc => tc.id === 'TC13')!.status = 'PARTIAL';
  return report;
}

describe('EN-04 CI report interpretation', () => {
  it('requires all mandatory files and rejects genuine failures even if another aggregate says success', () => {
    expect(assessQualityReport(quality(), required, root).passed).toBe(true);
    const missing = quality(); missing.testResults = [];
    expect(assessQualityReport(missing, required, root).passed).toBe(false);
    const failed = quality(); failed.testResults[0].status = 'failed';
    expect(assessQualityReport(failed, required, root).passed).toBe(false);
  });
  it('reports later-sprint TODO separately from skipped tests, using the actual Jest/Vitest counters', () => {
    const raw = quality(); raw.numTodoTests = 1;
    raw.testResults.push({ name: path.join(root, 'backend/test/future.integration-spec.ts'), status: 'passed',
      assertionResults: [{ fullName: 'future requirement', status: 'todo' }] });
    expect(assessQualityReport(raw, required, root)).toMatchObject({ passed: true, tests: { todo: 1, skipped: 0 } });
    raw.testResults[1].assertionResults[0].status = 'pending'; raw.numTodoTests = 0; raw.numPendingTests = 1;
    expect(assessQualityReport(raw, required, root).passed).toBe(false);
  });
  it('never permits TODO in a mandatory S01 file or an inconsistent report', () => {
    const raw = quality(); raw.numTodoTests = 1; raw.testResults[0].assertionResults.push({ fullName: 'missing auth check', status: 'todo' });
    expect(assessQualityReport(raw, required, root).passed).toBe(false);
    const inconsistent = quality(); inconsistent.numPendingTests = 1;
    expect(assessQualityReport(inconsistent, required, root).passed).toBe(false);
  });
});

describe('EN-05 regression is distinct from full acceptance', () => {
  it('passes full acceptance only with twenty complete committed-state cases', () => {
    expect(assessEn05Report(en05(), 0, 0)).toMatchObject({ acceptancePassed: true, regressionPassed: true, incomplete: [] });
  });
  it('allows only documented missing scope in regression and still rejects full acceptance', () => {
    expect(assessEn05Report(incomplete(), 0, 0)).toMatchObject({ acceptancePassed: false, regressionPassed: true });
    expect(assessEn05Report(incomplete(), 0, 0).incomplete).toHaveLength(1);
  });
  it.each(['FAILED', 'NOT_RUN', 'BLOCKED', 'PARTIAL'])('fails regression when an implemented case becomes %s', status => {
    const report = incomplete(); report.cases[0].status = status;
    expect(assessEn05Report(report, 0, 0).regressionPassed).toBe(false);
  });
  it('rejects setup/runner/client failures and a missing or duplicated TC', () => {
    for (const [jestCode, clientCode] of [[1, 0], [0, 1]]) expect(assessEn05Report(incomplete(), jestCode, clientCode).regressionPassed).toBe(false);
    const setup = incomplete(); setup.setupFailed = true; expect(assessEn05Report(setup, 0, 0).regressionPassed).toBe(false);
    const missing = incomplete(); missing.cases.pop(); expect(assessEn05Report(missing, 0, 0).regressionPassed).toBe(false);
    const duplicate = incomplete(); duplicate.cases[0].id = 'TC02'; expect(assessEn05Report(duplicate, 0, 0).regressionPassed).toBe(false);
  });
  it('requires all ten rounds, passed assertions and DB evidence even for the partial US-16 case', () => {
    const report = incomplete(), partial = report.cases.find(tc => tc.id === 'TC13')!;
    partial.rounds.pop(); expect(assessEn05Report(report, 0, 0).regressionPassed).toBe(false);
    const failed = incomplete(); failed.cases[0].rounds[0].assertion = 'FAILED';
    expect(assessEn05Report(failed, 0, 0).regressionPassed).toBe(false);
    const noDb = incomplete(); noDb.cases[0].rounds[0].after.invariants = 'FAILED';
    expect(assessEn05Report(noDb, 0, 0).regressionPassed).toBe(false);
  });
  it('requires ten rounds and real DB evidence for the completed US-23/66 races', () => {
    const report = incomplete(), partial = report.cases.find(tc => tc.id === 'TC10')!;
    partial.rounds.pop(); expect(assessEn05Report(report, 0, 0).regressionPassed).toBe(false);
    partial.status = 'BLOCKED'; partial.rounds = [];
    expect(assessEn05Report(report, 0, 0).regressionPassed).toBe(false);
  });
});
