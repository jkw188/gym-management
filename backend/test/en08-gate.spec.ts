import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
const { IDS, assessTests, assessRelease, assessS07, assessEn04 } = require('../../scripts/en08-evidence.cjs');
const root = path.resolve(__dirname, '../..');
const file = 'backend/test/en08-oracle.spec.ts';
function tests() {
  return { success: true, numPassedTests: 1, numFailedTests: 0, numFailedTestSuites: 0, numPendingTests: 0, numTodoTests: 0,
    testResults: [{ name: path.join(root, file), status: 'passed', assertionResults: [{ fullName: 'required oracle', status: 'passed' }] }] };
}
function release() {
  return { commit: 'a'.repeat(40), runId: 'b'.repeat(12), dirty: false, sourceUnchanged: true, node: 'v24.13.0', npm: '11.11.1',
    sourceSha256: 'c'.repeat(64), lockfiles: { backend: 'd'.repeat(64), frontend: 'e'.repeat(64) }, traceabilityReviewed: true, openCriticalDefects: 0,
    cases: Array.from({ length: 20 }, (_, i) => ({ id: `TC${String(i + 1).padStart(2, '0')}`, status: 'PASS', evidence: ['verified.json'] })),
    steps: ['EN04', 'EN05', 'EN06', 'S07', 'GATE_PROBE'].map(id => ({ id, status: 'PASS' })) };
}
describe('EN-08 strict evidence interpretation', () => {
  it('requires files, executed assertions and consistent counters; rejects skip/TODO even if success is true', () => {
    expect(assessTests(tests(), [file], root).passed).toBe(true);
    expect(assessTests(tests(), [file, 'missing.ts'], root).passed).toBe(false);
    expect(assessTests(null, [file], root).passed).toBe(false);
    for (const status of ['pending', 'skipped', 'todo', 'failed', 'disabled']) {
      const raw = tests(); raw.testResults[0].assertionResults[0].status = status;
      expect(assessTests(raw, [file], root).passed).toBe(false);
    }
    const raw = tests(); raw.testResults[0].assertionResults = [];
    expect(assessTests(raw, [file], root).passed).toBe(false);
    raw.numPassedTests = 0; expect(assessTests(raw, [file], root).passed).toBe(false);
  });
  it('requires frozen metadata, reviewed traceability, no critical defect and every mandatory gate', () => {
    expect(assessRelease(release()).acceptance).toBe('ACCEPTED');
    for (const extra of [{ dirty: true }, { sourceUnchanged: false }, { node: 'v22.0.0' }, { npm: '10' }, { commit: '' },
      { sourceSha256: '' }, { lockfiles: {} }, { traceabilityReviewed: false }, { openCriticalDefects: 1 }, { openCriticalDefects: null }]) {
      expect(assessRelease({ ...release(), ...extra }).exitCode).toBe(1);
    }
    const run = release(); run.steps.pop(); expect(assessRelease(run).exitCode).toBe(1);
    const duplicate = release(); duplicate.steps[0].id = 'EN05'; expect(assessRelease(duplicate).exitCode).toBe(1);
  });
  it.each(['BLOCKED', 'NOT_RUN', 'FAIL', 'PARTIAL', 'UNKNOWN', 'SKIP'])('never accepts %s or missing evidence as PASS', status => {
    const run = release(); run.cases[0].status = status;
    expect(assessRelease(run)).toMatchObject({ acceptance: 'NOT_ACCEPTED', exitCode: 1 });
    const noEvidence = release(); noEvidence.cases[0].evidence = []; expect(assessRelease(noEvidence).exitCode).toBe(1);
  });
  it('rejects missing/duplicate TC and foundation-only evidence', () => {
    const missing = release(); missing.cases.pop(); expect(assessRelease(missing).exitCode).toBe(1);
    const duplicate = release(); duplicate.cases[0].id = 'TC02'; expect(assessRelease(duplicate).exitCode).toBe(1);
    const foundation = release(); foundation.steps[2].status = 'PARTIAL'; expect(assessRelease(foundation).exitCode).toBe(1);
    expect(IDS).toHaveLength(20);
  });
  it('rejects removed mandatory suites and masked skip in inherited EN04 evidence', () => {
    const required = Object.fromEntries(['unit', 'frontend', 'integration', 'e2e'].map(name => [name, [file]]));
    const reports = Object.fromEntries(Object.keys(required).map(name => [name, { success: true, failed: 0, skipped: 0, todo: 0, passed: 1,
      suites: [{ file, status: 'passed', tests: [{ name: 'mandatory', status: 'passed' }] }] }]));
    const quality = { status: 'passed', commit: 'candidate', steps: [{ exitCode: 0 }] };
    expect(assessEn04(quality, reports, required, 'candidate')).toBe(true);
    expect(assessEn04(quality, reports, { ...required, integration: ['missing.ts'] }, 'candidate')).toBe(false);
    reports.integration.suites[0].tests[0].status = 'pending';
    expect(assessEn04(quality, reports, required, 'candidate')).toBe(false);
    expect(assessEn04(quality, reports, required, 'other-commit')).toBe(false);
  });
  it('requires two child processes, ten rounds and resolved request/DB evidence for S07', () => {
    const processes = { pids: [101, 102], parentPid: 100 };
    const report = { cases: ['S07-RETURN', 'S07-PAYOUT', 'S07-BROADCAST'].map(id => ({ id, status: 'PASS', rounds: Array.from({ length: 10 }, (_, round) => ({ round,
      status: 'PASS', before: { invariants: 'PASSED', returns: { invariants: 'PASS' } }, after: { invariants: 'PASSED', returns: { invariants: 'PASS' } }, requests: Array.from({ length: 20 }, (_, i) => ({ pid: i % 2 ? 101 : 102, resolved: true, status: 200 })) })) })) };
    expect(assessS07(report, processes)).toBe(true);
    expect(assessS07(report, { ...processes, pids: [101, 101] })).toBe(false);
    const fewer = structuredClone(report); fewer.cases[0].rounds.pop(); expect(assessS07(fewer, processes)).toBe(false);
    const unknown = structuredClone(report); unknown.cases[1].rounds[0].requests[0].resolved = false; expect(assessS07(unknown, processes)).toBe(false);
    const broken = structuredClone(report); broken.cases[0].rounds[0].after.invariants = 'FAILED'; expect(assessS07(broken, processes)).toBe(false);
  });
  it('records all S01-S08 requirement IDs and ACs without treating discovered files as coverage', () => {
    const matrix = JSON.parse(readFileSync(path.join(root, 'scripts/en08-matrix.json'), 'utf8')) as {
      requirements: { id: string; criteria: { id: string; condition: string }[]; status: string; coverage: string; sourceCandidates: string[]; testCandidates: string[] }[];
    };
    expect(new Set(matrix.requirements.map(row => row.id)).size).toBe(matrix.requirements.length);
    for (const row of matrix.requirements) {
      expect(row.criteria.length).toBeGreaterThan(0); expect(row.status).toBe('NOT_RUN'); expect(row.coverage).not.toBe('PASS');
      for (const ac of row.criteria) { expect(ac.id).toMatch(/^[A-Z0-9-]+-AC\d+$/); expect(ac.condition.length).toBeGreaterThan(0); }
      for (const candidate of [...row.sourceCandidates, ...row.testCandidates]) expect(existsSync(path.join(root, candidate))).toBe(true);
    }
    for (const id of ['EN-01', 'EN-08', 'US-50', 'US-51', 'US-52']) expect(matrix.requirements.some(row => row.id === id)).toBe(true);
  });
});
