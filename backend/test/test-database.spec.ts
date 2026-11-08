import { randomBytes } from 'node:crypto';
import { validateTestEnvironment, testDatabaseName } from '../scripts/test-database.cjs';

const valid = { NODE_ENV: 'test', MONGODB_TEST_URI: 'mongodb://127.0.0.1:27018/gym_test_s01' };

describe('EN-04 test database safety (without MongoDB)', () => {
  it('accepts only an explicit test environment and test URI; never falls back to development', () => {
    expect(validateTestEnvironment(valid)).toBe('gym_test_s01');
    for (const env of [
      { ...valid, NODE_ENV: 'development' }, { ...valid, NODE_ENV: undefined },
      { NODE_ENV: 'test', MONGODB_URI: valid.MONGODB_TEST_URI },
      { ...valid, MONGODB_TEST_URI: 'mongodb://127.0.0.1:27018' },
      { ...valid, MONGODB_TEST_URI: 'mongodb://127.0.0.1:27018/gym_management' },
      { ...valid, MONGODB_TEST_URI: 'mongodb://127.0.0.1:27018/gym_management_test' },
      { ...valid, MONGODB_TEST_URI: 'mongodb://127.0.0.1:27018/gym_test_' },
      { ...valid, MONGODB_TEST_URI: 'mongodb://127.0.0.1:27018/gym_test_' + 'a'.repeat(25) },
      { ...valid, MONGODB_TEST_URI: 'not-a-uri-with-private-password' },
      { ...valid, MONGODB_DB: 'gym_test_s01' },
      { ...valid, MONGODB_URI: valid.MONGODB_TEST_URI },
    ]) {
      expect(() => validateTestEnvironment(env)).toThrow();
      try { validateTestEnvironment(env); }
      catch (error) { expect((error as Error).message).not.toMatch(/mongodb:|password|27018/); }
    }
  });

  it('assigns distinct bounded names to each run, worker and suite', () => {
    const run = randomBytes(6).toString('hex');
    const names = [testDatabaseName('gym_test_s01', run, '1', 's01'), testDatabaseName('gym_test_s01', run, '2', 's01'),
      testDatabaseName('gym_test_s01', randomBytes(6).toString('hex'), '1', 's01'), testDatabaseName('gym_test_s01', run, '1', 'safety')];
    expect(new Set(names).size).toBe(4);
    for (const name of names) expect(name).toMatch(/^gym_test_[a-z0-9_]+$/);
    expect(testDatabaseName('gym_test_' + 'a'.repeat(15), run, '999', 'a'.repeat(12)).length).toBeLessThan(64);
    for (const args of [['gym_management', run, '1', 's01'], ['gym_test_s01', '../dev', '1', 's01'],
      ['gym_test_s01', run, '../', 's01'], ['gym_test_s01', run, '1', '../dev']]) {
      expect(() => testDatabaseName(...args as [string, string, string, string])).toThrow('INVALID_TEST_DATABASE_ID');
    }
  });
});
