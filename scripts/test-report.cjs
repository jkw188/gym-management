const path = require('node:path');

// EN-04 owns the mandatory S01 files; later-sprint TODOs remain visible without being reported as skipped tests.
function assessQualityReport(raw, requiredFiles, root) {
  const executed = raw.testResults.map(suite => path.relative(root, suite.name).replaceAll('\\', '/'));
  const missingRequiredFiles = requiredFiles.filter(file => !executed.includes(file));
  let todo = 0, skipped = 0;
  const incompleteRequiredTests = [];
  for (const suite of raw.testResults) {
    const file = path.relative(root, suite.name).replaceAll('\\', '/');
    for (const test of suite.assertionResults) {
      if (test.status === 'todo') todo++;
      else if (['pending', 'skipped', 'disabled'].includes(test.status)) skipped++;
      if (requiredFiles.includes(file) && test.status !== 'passed') incompleteRequiredTests.push({ file, name: test.fullName, status: test.status });
    }
  }
  const tests = { passed: raw.numPassedTests, failed: raw.numFailedTests, skipped, todo,
    suitesPassed: raw.numPassedTestSuites, suitesFailed: raw.numFailedTestSuites };
  const passed = raw.success === true && raw.numFailedTests === 0 && raw.numFailedTestSuites === 0 && raw.numPassedTests > 0 &&
    !raw.testResults.some(suite => suite.status === 'failed') && raw.numPendingTests === skipped && (raw.numTodoTests ?? 0) === todo &&
    skipped === 0 && missingRequiredFiles.length === 0 && incompleteRequiredTests.length === 0;
  return { passed, tests, missingRequiredFiles, incompleteRequiredTests };
}

// Temporary, explicit incomplete scope. Any other BLOCKED/PARTIAL/NOT_RUN outcome fails regression too.
const EN05_INCOMPLETE = Object.freeze({
  TC07: { status: 'BLOCKED', reason: 'US-66 publish/update writer missing' },
  TC08: { status: 'BLOCKED', reason: 'US-66 publish writer missing' },
  TC10: { status: 'PARTIAL', reason: 'US-66 publish versus deactivate dependency missing; US-23/24/25/28 races executed' },
  TC13: { status: 'PARTIAL', reason: 'US-20 self-service adapter missing' },
});
function assessEn05Report(report, jestExitCode, clientExitCode) {
  const cases = report.cases;
  const completeRounds = tc => Array.isArray(tc.rounds) && tc.rounds.length === 10 && tc.rounds.every((round, index) =>
    round.round === index && round.assertion === 'PASSED' && round.before?.invariants === 'PASSED' && round.after?.invariants === 'PASSED');
  const ids = Array.from({ length: 20 }, (_, i) => `TC${String(i + 1).padStart(2, '0')}`);
  const valid = !report.setupFailed && jestExitCode === 0 && clientExitCode === 0 && Array.isArray(cases) && cases.length === 20 &&
    ids.every(id => cases.filter(tc => tc.id === id).length === 1);
  const acceptancePassed = valid && cases.every(tc => tc.status === 'PASSED' && completeRounds(tc));
  const regressionPassed = valid && cases.every(tc => {
    if (tc.status === 'PASSED') return completeRounds(tc);
    const known = EN05_INCOMPLETE[tc.id];
    if (!known || tc.status !== known.status) return false;
    return tc.status === 'BLOCKED' ? Array.isArray(tc.rounds) && tc.rounds.length === 0 : completeRounds(tc);
  });
  return { acceptancePassed, regressionPassed,
    incomplete: Array.isArray(cases) ? cases.filter(tc => tc.status !== 'PASSED').map(tc => ({ id: tc.id, status: tc.status,
      reason: tc.reason || EN05_INCOMPLETE[tc.id]?.reason })) : [] };
}

module.exports = { assessQualityReport, assessEn05Report };
