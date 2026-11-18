import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { ObjectId } from 'mongodb';
import { Call, En06Fixture, NOW, Outcome } from './helpers/en06-fixture';
import { inspectCommitted } from './helpers/en06-oracle';
import { inspectReturnSources } from './helpers/en08-source-oracle';

const extraCollections = ['returns', 'return_items', 'refund_attempts', 'notification_broadcasts', 'reminder_occurrences'];
interface RequestEvidence { pid: number; path: string; key?: string; payloadHash: string; status?: number; resolved: boolean }
interface RoundEvidence { round: number; before: unknown; after?: unknown; requests: RequestEvidence[]; status: string }
interface CaseEvidence { id: string; status: string; rounds: RoundEvidence[] }
class En08Fixture extends En06Fixture {
  readonly evidence: CaseEvidence[] = [];
  active?: RoundEvidence;
  override async reset() {
    await super.reset();
    for (const name of extraCollections) await this.db.collection(name).deleteMany({});
  }
  override async send(call: Call): Promise<Outcome> {
    const row: RequestEvidence = { pid: this.apps[call.app].child.pid!, path: call.path, key: call.key,
      payloadHash: createHash('sha256').update(JSON.stringify(call.body ?? {})).digest('hex'), resolved: false };
    this.active?.requests.push(row);
    const result = await super.send(call); row.status = result.status; row.resolved = true; return result;
  }
  async snapshot() {
    const base = await inspectCommitted(this.db, this.client);
    const extras: Record<string, { count: number; hash: string; ids: string[] }> = {};
    for (const name of extraCollections) {
      const rows = await this.rows(name);
      extras[name] = { count: rows.length, ids: rows.map(row => String(row._id)), hash: createHash('sha256').update(JSON.stringify(rows)).digest('hex') };
    }
    return { ...base, extras, returns: await inspectReturnSources(this.db) };
  }
  async run(id: string, work: (round: number) => Promise<void>) {
    const tc: CaseEvidence = { id, status: 'FAIL', rounds: [] }; this.evidence.push(tc);
    try {
      for (let round = 0; round < 10; round++) {
        await this.reset(); this.active = { round, before: await this.snapshot(), requests: [], status: 'FAIL' }; tc.rounds.push(this.active);
        await work(round);
        this.active.after = await this.snapshot(); await this.apps[0].rpc('validate');
        expect(this.active.requests.every(r => r.resolved)).toBe(true);
        expect(new Set(this.active.requests.map(r => r.pid)).size).toBe(2);
        this.active.status = 'PASS'; this.save();
      }
      tc.status = 'PASS';
    } finally { this.active = undefined; this.save(); }
  }
  save() { writeFileSync(path.join(process.env.EN06_REPORT_DIR!, 's07-cases.json'), JSON.stringify({ cases: this.evidence }, null, 2)); }
}

describe('EN-08 S07 source regression: two Node processes, 10 rounds, batches of 20', () => {
  const f = new En08Fixture();
  const ok = (row: Outcome, status = 200) => { expect(row.status).toBe(status); expect(row.body.error).toBeUndefined(); return row.body; };
  const post = (url: string, body: object, app = 0, operation?: string, key = f.key()): Call => ({ app, actor: f.staff, path: url, body, operation, key });
  beforeAll(async () => {
    await f.start();
    const build = await f.db.admin().command({ buildInfo: 1 }), hello = await f.db.admin().command({ hello: 1 });
    writeFileSync(path.join(process.env.EN06_REPORT_DIR!, 'environment.json'), JSON.stringify({ runId: process.env.EN04_RUN_ID,
      database: f.db.databaseName, mongoVersion: build.version, replicaSet: Boolean(hello.setName), timezone: 'Asia/Ho_Chi_Minh',
      clock: NOW, fixture: 'EN08 DEMO ONLY; real catalog/receipt/POS/payment/fulfill/return/payout/broadcast writers',
      rounds: 10, batchSize: 20, observedAt: new Date().toISOString() }, null, 2));
  }, 180000);
  afterAll(async () => { await f.close(); });
  async function delivered() {
    const products = await f.catalog(), receipt = await f.receipt(products, 3); ok(await f.send(f.postReceipt(String(receipt.id))));
    const intent = { buyerName: 'EN08 DEMO ONLY', preferredPaymentMethod: 'CASH', items: [{ productId: products[0], quantity: 1 }] };
    const quote = ok(await f.send(post('/pos/orders/preview', intent)));
    const order = ok(await f.send(post('/pos/orders', { ...intent, quoteToken: quote.quoteToken }, 0, 'ORDER_CREATE_POS')), 201);
    ok(await f.send(post(`/transactions/${order.transactionId}/confirm-payment`, { method: 'CASH', amount: '9000', evidenceNote: 'EN08 DEMO ONLY simulated cash receipt' }, 0, 'PAYMENT_CONFIRM')));
    const detail = ok(await f.get(`/orders/${order.id}`));
    ok(await f.send(post(`/pos/orders/${order.id}/fulfill`, { version: detail.version }, 0, 'ORDER_FULFILL_POS')));
    return ok(await f.get(`/orders/${order.id}`));
  }
  function returnCall(order: Record<string, unknown>, app: number, key = f.key()): Call {
    const items = order.items as { id: string }[];
    return post(`/orders/${order.id}/returns`, { version: order.version, reason: 'EN08 DEMO ONLY customer return',
      items: [{ orderItemId: items[0].id, quantity: 1, restockable: true, conditionNote: 'EN08 DEMO ONLY inspected intact goods' }] }, app, 'RETURN_RECEIVE', key);
  }
  function payout(id: unknown, app: number, key = f.key()): Call {
    return post(`/refunds/${id}/confirm`, { version: 0, method: 'CASH', amount: '9000', paidOutAt: NOW,
      evidenceNote: 'EN08 DEMO ONLY simulated payout voucher', cashVoucherReference: 'TEST_EN08_VOUCHER' }, app, 'REFUND_CONFIRM', key);
  }
  it('S07-RETURN: batch20 same-key and conflicting keys never receive/restock/refund twice', async () => f.run('S07-RETURN', async round => {
    const order = await delivered(), key = f.key();
    const calls = Array.from({ length: 20 }, (_, i) => returnCall(order, i % 2, round % 2 ? undefined : key));
    const results = await f.race(calls, round);
    if (round % 2) { expect(results.filter(r => r.status === 201)).toHaveLength(1); expect(results.filter(r => r.status === 409)).toHaveLength(19); }
    else results.forEach(r => { ok(r, 201); expect(r.body).toEqual(results[0].body); });
    expect(await f.rows('returns')).toHaveLength(1); expect(await f.rows('return_items')).toHaveLength(1); expect(await f.rows('refunds')).toHaveLength(1);
    expect(await f.rows('stock_movements', { kind: 'RETURN_RECEIVE' })).toHaveLength(1);
    const refund = (await f.rows('refunds'))[0]; expect(String(refund.amount)).toBe('9000'); expect(refund.status).toBe('PENDING');
  }));
  it('S07-PAYOUT: batch20 confirm and confirm/fail conflicts write one payout at most', async () => f.run('S07-PAYOUT', async round => {
    const order = await delivered(), received = ok(await f.send(returnCall(order, 0)), 201), key = f.key();
    const calls = Array.from({ length: 20 }, (_, i) => round % 2 && i % 2 ? post(`/refunds/${received.refundId}/fail`,
      { version: 0, failureReason: 'EN08 DEMO ONLY unconfirmed payout', evidenceNote: 'EN08 DEMO ONLY no debit observed' }, 1, 'REFUND_FAIL') : payout(received.refundId, i % 2, round % 2 ? undefined : key));
    const results = await f.race(calls, round);
    if (round % 2) { expect(results.filter(r => r.status === 200)).toHaveLength(1); expect(results.filter(r => r.status === 409)).toHaveLength(19); }
    else results.forEach(r => { ok(r); expect(r.body).toEqual(results[0].body); });
    expect(await f.rows('refund_attempts')).toHaveLength(1);
    const refund = (await f.rows('refunds'))[0]; expect(['SUCCEEDED', 'FAILED']).toContain(refund.status);
    expect(await f.rows('returns')).toHaveLength(1); expect(await f.rows('stock_movements', { kind: 'RETURN_RECEIVE' })).toHaveLength(1);
    expect(String(refund.amount)).toBe('9000');
  }));
  it('S07-BROADCAST: batch20 same/different keys keeps one event and a unique recipient per account', async () => f.run('S07-BROADCAST', async round => {
    const preview = ok(await f.send({ ...post('/admin/notification-broadcasts/preview', { audience: 'ROLES', roles: ['MEMBER'], title: 'EN08 DEMO ONLY', body: 'EN08 DEMO ONLY broadcast' }), actor: f.admin }), 201);
    const key = f.key();
    // Finite client barrier: all promises released together; no production HTTP fault endpoint.
    const results = await f.batch(Array.from({ length: 20 }, (_, i) => ({ ...post(`/admin/notification-broadcasts/${preview.previewId}/send`, { version: 0 }, i % 2,
      'NOTIFICATION_BROADCAST_SEND', round % 2 ? undefined : key), actor: f.admin })));
    if (round % 2) { expect(results.filter(r => r.status === 200)).toHaveLength(1); expect(results.filter(r => r.status === 409)).toHaveLength(19); }
    else results.forEach(r => { ok(r); expect(r.body).toEqual(results[0].body); });
    expect(await f.rows('notifications')).toHaveLength(1); expect(await f.rows('notification_outbox')).toHaveLength(1);
    const recipients = await f.rows('notification_recipients'); expect(recipients).toHaveLength(f.members.length);
    expect(new Set(recipients.map(r => String(r.account_id))).size).toBe(f.members.length);
    expect((await f.rows('notification_broadcasts', { _id: new ObjectId(String(preview.previewId)) }))[0].status).toBe('SENT');
  }));
});
