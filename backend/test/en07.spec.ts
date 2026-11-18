import { readConfiguration, readMongoConfiguration } from '../src/config/configuration';
import { assertRestoreTarget, assertUat, compareSnapshots, indexContract, UatSnapshot } from '../scripts/uat.cjs';

const env = { NODE_ENV: 'production', DEPLOYMENT_ENV: 'uat', PORT: '3000', FRONTEND_ORIGIN: 'https://uat.example.invalid',
  MONGODB_URI: 'mongodb://127.0.0.1:27017', MONGODB_DB: 'gym_uat_fixture', UAT_DATA_CLASSIFICATION: 'DEMO_ONLY',
  RETAIL_QUOTE_SECRET: 'q'.repeat(40), JWT_ACCESS_SECRET: 'j'.repeat(40), PICKUP_LOCATION: 'DEMO ONLY Counter' };
const baseline: UatSnapshot = { version: 1, capturedAt: '', collections: { orders: { count: 1, sha256: 'original', indexes: [] } },
  finance: { receipts: { amount: '25000', count: 1 }, payouts: { amount: '0', count: 0 } }, inventory: { checked: 0, consistent: true, issues: [] }, sourceIssues: [] };

describe('EN-07 fail-closed UAT configuration and recovery guards', () => {
  it('keeps production settings and requires a separate UAT DB, HTTPS, demo label and quote configuration', () => {
    expect(readConfiguration(env)).toMatchObject({ nodeEnv: 'production', deploymentEnvironment: 'uat', trustProxyHops: 0 });
    for (const extra of [{ NODE_ENV: 'development' }, { MONGODB_DB: 'gym_management' }, { MONGODB_DB: 'gym_management_test' },
      { FRONTEND_ORIGIN: 'http://uat.example.invalid' }, { UAT_DATA_CLASSIFICATION: '' }, { RETAIL_QUOTE_SECRET: '' },
      { RETAIL_QUOTE_SECRET: env.JWT_ACCESS_SECRET }, { PICKUP_LOCATION: '' }, { EN06_NOW: '2035-01-01' }, { TRUST_PROXY_HOPS: 'true' },
      { TRUST_PROXY_HOPS: '2' }, { DEPLOYMENT_ENV: 'invalid' }]) expect(() => readConfiguration({ ...env, ...extra })).toThrow();
    expect(readConfiguration({ ...env, TRUST_PROXY_HOPS: '1' }).trustProxyHops).toBe(1);
    expect(() => readMongoConfiguration({ ...env, MONGODB_DB: 'gym_management' })).toThrow('MONGODB_DB');
  });
  it('does not print secret values in configuration errors', () => {
    try { readConfiguration({ ...env, MONGODB_URI: 'sensitive-uri', FRONTEND_ORIGIN: 'https://user:sensitive-password@host' }); }
    catch (error) { expect(String(error)).toContain('MONGODB_URI'); expect(String(error)).not.toContain('sensitive'); }
  });
  it('requires two opt-in flags before connecting for demo seed and forbids restore databases', () => {
    expect(() => assertUat(env, true)).toThrow('UAT_DEMO_OPT_IN_REQUIRED');
    expect(() => assertUat({ ...env, UAT_DEMO_SEED: 'ALLOW_DEMO_ONLY' }, true)).not.toThrow();
    for (const extra of [{ NODE_ENV: 'test' }, { DEPLOYMENT_ENV: 'production' }, { MONGODB_DB: 'gym_management' }, { MONGODB_DB: 'gym_uat_restore_abc' }]) {
      expect(() => assertUat({ ...env, ...extra })).toThrow('UAT_ENVIRONMENT_REQUIRED');
    }
  });
  it('only permits isolated restore destinations and never the source', () => {
    for (const target of ['gym_uat_fixture', 'gym_management', 'gym_uat_restore_', 'gym_uat_restore_a.b']) expect(() => assertRestoreTarget(env.MONGODB_DB, target)).toThrow();
    expect(() => assertRestoreTarget(env.MONGODB_DB, 'gym_uat_restore_release1')).not.toThrow();
  });
  it('detects changed source bytes, missing collections, indexes, finances and broken stock ledgers', () => {
    expect(compareSnapshots(baseline, structuredClone(baseline)).matched).toBe(true);
    for (const mutate of [
      (value: UatSnapshot) => { value.collections.orders.sha256 = 'changed'; },
      (value: UatSnapshot) => { delete value.collections.orders; },
      (value: UatSnapshot) => { value.collections.orders.indexes.push({ unique: false }); },
      (value: UatSnapshot) => { value.finance.receipts.amount = '0'; },
      (value: UatSnapshot) => { value.inventory.consistent = false; },
      (value: UatSnapshot) => { value.sourceIssues.push({ relation: 'orders.transaction_id', count: 1 }); },
    ]) { const changed = structuredClone(baseline); mutate(changed); expect(compareSnapshots(baseline, changed).matched).toBe(false); }
  });
  it('preserves compound-index key order while ignoring server index metadata', () => {
    expect(indexContract({ v: 2, ns: 'old.orders', name: 'compound', key: { a: 1, b: -1 }, unique: true }))
      .toEqual(indexContract({ v: 3, ns: 'new.orders', name: 'compound', key: { a: 1, b: -1 }, unique: true }));
    expect(indexContract({ name: 'compound', key: { a: 1, b: -1 } })).not.toEqual(indexContract({ name: 'compound', key: { b: -1, a: 1 } }));
  });
});
