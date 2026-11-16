import { ObjectId } from 'mongodb';
import { Call, En06Fixture, Outcome } from './helpers/en06-fixture';

describe('EN-06 / two processes / real MongoDB / available foundation only', () => {
  const f = new En06Fixture();
  const ok = (outcome: Outcome, status = 200) => expect({ status: outcome.status, error: outcome.body.error }).toEqual({ status, error: undefined });
  const codes = (outcomes: Outcome[]) => outcomes.forEach(outcome => expect([200, 409]).toContain(outcome.status));
  beforeAll(async () => f.start(), 120000);
  afterAll(async () => f.close());

  it('records stable TC IDs and missing production dependencies without skipped/pass placeholders', () => {
    f.blocked('TC01', 'US41', 'No website order/quote/cart writer: cannot race 20 Member checkouts for SKU1.');
    f.blocked('TC02', 'US41/US53', 'No shared WEBSITE/POS Order Factory or reservation writer.');
    f.blocked('TC03', 'US40/US41', 'No cart/cartVersion checkout writer.');
    f.blocked('TC06', 'US41', 'Catalog writer exists; quote/create consumer missing.');
    f.blocked('TC10', 'US41/US45', 'No retail normal settlement/cancel/refund transition. GYM cancel is not retail cancel.');
    f.blocked('TC11', 'US44/US45', 'No fulfill/cancel order writers.');
    f.blocked('TC12', 'US45', 'No expiry service: two real expiry workers cannot be started.');
    f.blocked('TC13', 'US41/US44', 'Prepare deadline checks have a separate US43 integration suite; retail normal payment/fulfill writers and end-to-end create fixtures are still missing.');
    f.blocked('TC14', 'US45', 'No expiry backlog/restart service; outbox worker is not an expiry substitute.');
    f.blocked('TC15', 'US45', 'No late receipt endpoint/refund obligation writer.');
    f.blocked('TC16', 'US45', 'No late receipt amount/second-payment reconciliation handler.');
  });

  it('TC04 foundation: 20 receipt replays and transport loss preserve original IDs', async () => f.partial('TC04', 'US41/US53',
    'Receipt idempotency verified; order/reserve/cart clear replay unavailable.', async round => {
      const products = await f.catalog(), receipt = await f.receipt(products), key = f.key();
      const outcomes = await f.race(Array.from({ length: 20 }, (_, index) => f.postReceipt(String(receipt.id), index % 2, key)), round);
      await f.apps[0].arm('response');
      const original = await f.send(f.postReceipt(String(receipt.id), 0, key)); ok(original);
      outcomes.forEach(outcome => { ok(outcome); expect(outcome.body).toEqual(original.body); });
      expect(await f.rows('stock_movements')).toHaveLength(2);
      expect(await f.rows('stock_document_events', { action: 'POSTED' })).toHaveLength(1);
    }));

  it('TC05 foundation: same key with changed version/target conflicts', async () => f.partial('TC05', 'US41/US53',
    'Existing operation fingerprint checked; retail quote/channel fingerprint unavailable.', async round => {
      const products = await f.catalog(), a = await f.receipt(products), b = await f.receipt(products), key = f.key();
      const calls = Array.from({ length: 20 }, (_, index) => f.postReceipt(String(index % 2 ? a.id : b.id), index % 2, key));
      const outcomes = await f.race(calls, round); codes(outcomes);
      expect(outcomes.filter(row => row.status === 200)).toHaveLength(10);
      expect(outcomes.filter(row => row.status === 409)).toHaveLength(10);
      outcomes.filter(row => row.status === 409).forEach(row => expect(row.body.error).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' }));
      const winner = calls[outcomes.findIndex(row => row.status === 200)];
      const conflict = await f.send({ ...winner, body: { version: 1 } });
      expect(conflict.status).toBe(409); expect(conflict.body.error).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      expect(await f.rows('stock_movements')).toHaveLength(2);
    }));

  it('TC07 foundation: POSTED receipts race through shared inventory lock with readers', async () => f.partial('TC07', 'US41/US53',
    'Real receipt/reader/ledger race; S06 reservation side missing.', async round => {
      const products = await f.catalog(), a = await f.receipt(products, 1), b = await f.receipt(products, 2);
      const draft = await f.checkpoint('draft_receipts_do_not_add_stock');
      expect(draft.inventory.every(row => row.onHand === 0 && row.version === 0)).toBe(true);
      const calls: Call[] = Array.from({ length: 16 }, (_, index) => f.postReceipt(String(index % 2 ? a.id : b.id), index % 2));
      calls.push(...Array.from({ length: 4 }, (_, index) => ({ app: index % 2, actor: f.staff, path: `/inventory/${products[index % 2]}`, method: 'GET' })));
      const outcomes = await f.race(calls, round); outcomes.forEach(row => ok(row));
      for (const row of outcomes.slice(16)) {
        const { onHand, reserved, available, version } = row.body;
        expect(reserved).toBe(0); expect(available).toBe(onHand);
        expect(version === 0 ? onHand === 0 : version === 1 ? onHand === 1 || onHand === 2 : version === 2 && onHand === 3).toBe(true);
      }
      const after = await f.checkpoint('two_posted_receipts');
      expect(after.inventory.every(row => row.onHand === 3 && row.reserved === 0 && row.version === 2)).toBe(true);
    }));

  it('TC08 foundation: two transactions compete for one bank reference', async () => f.partial('TC08', 'US41',
    'GYM/PT successful payment uniqueness verified; retail dispatch absent.', async round => {
      const a = await f.sale('GYM', '300000', 0), b = await f.sale('PT', '300000', 1);
      const reference = `FIXTURE:${process.env.EN04_RUN_ID}:${round}`;
      const calls = Array.from({ length: 20 }, (_, index) => f.confirm(index % 2 ? a.transactionId : b.transactionId, index % 2, f.key(), reference));
      const outcomes = await f.race(calls, round); codes(outcomes);
      expect(outcomes.filter(row => row.status === 200)).toHaveLength(1);
      expect(await f.rows('payments', { status: 'SUCCEEDED' })).toHaveLength(1);
      expect(await f.rows('invoices')).toHaveLength(1); expect(await f.rows('refunds')).toHaveLength(0);
      expect(await f.rows('transactions', { status: 'PENDING' })).toHaveLength(1);
    }));

  it('TC09 foundation: 20 different confirmation keys settle one transaction once', async () => f.partial('TC09', 'US41',
    'GYM/PT confirmation race verified; retail must retain HELD and avoid fulfillment.', async round => {
      const sale = await f.sale(round % 2 ? 'PT' : 'GYM');
      const calls = Array.from({ length: 20 }, (_, index) => f.confirm(sale.transactionId, index % 2));
      const outcomes = await f.race(calls, round); codes(outcomes);
      expect(outcomes.filter(row => row.status === 200)).toHaveLength(1);
      const winner = outcomes.findIndex(row => row.status === 200);
      const replay = await f.send({ ...calls[winner], app: 1 - calls[winner].app }); ok(replay);
      expect(replay.body).toEqual(outcomes[winner].body);
      for (const name of ['payments', 'invoices', 'memberships']) expect(await f.rows(name)).toHaveLength(1);
      expect(await f.rows('operation_requests', { operation: 'PAYMENT_CONFIRM' })).toHaveLength(1);
    }));

  it('TC17 foundation: free GYM/PT invoice has no zero payment', async () => f.partial('TC17', 'US41/US53',
    'Existing zero GYM/PT handler verified; free WEBSITE/POS HELD orders missing.', async () => {
      for (const [index, kind] of (['GYM', 'PT'] as const).entries()) {
        const sale = await f.sale(kind, '0', index);
        const call = f.confirm(sale.transactionId, index);
        const denied = await f.send({ ...call, body: { ...call.body, amount: '0' } });
        expect(denied.status).toBe(409);
      }
      expect(await f.rows('payments')).toHaveLength(0);
      expect(await f.rows('invoices')).toHaveLength(2);
      expect((await f.rows('invoices')).every(row => String(row.total_amount) === '0')).toBe(true);
    }));

  it('TC18 foundation: rollback after each existing write; lost committed response resolves by original key', async () => f.partial('TC18', 'US41/US45/US53',
    'Inventory/payment/invoice/audit/outbox/operation hooks verified; order/items/cart/refund hooks await their writers.', async () => {
      const products = await f.catalog(), receipt = await f.receipt(products);
      for (const point of ['movement', 'stockAudit', 'operation']) {
        const before = await f.checkpoint(`before_stock_${point}`);
        await f.apps[0].arm(point, 'rollback');
        expect((await f.send(f.postReceipt(String(receipt.id)))).status).toBe(503);
        const after = await f.checkpoint(`after_stock_${point}`);
        expect(after.hashes).toEqual(before.hashes);
        expect(after.guardHashes).toEqual(before.guardHashes);
      }
      ok(await f.send(f.postReceipt(String(receipt.id))));
      const sale = await f.sale();
      for (const point of ['payment', 'invoice', 'settle', 'recipient', 'outbox', 'operation']) {
        const before = await f.checkpoint(`before_payment_${point}`);
        await f.apps[0].arm(point, 'rollback');
        expect((await f.send(f.confirm(sale.transactionId))).status).toBe(503);
        const after = await f.checkpoint(`after_payment_${point}`);
        expect(after.hashes).toEqual(before.hashes);
        expect(after.guardHashes).toEqual(before.guardHashes);
      }
      const key = f.key(); await f.apps[0].arm('response');
      const result = await f.send(f.confirm(sale.transactionId, 0, key)); ok(result);
      const replay = await f.send(f.confirm(sale.transactionId, 1, key)); ok(replay); expect(replay.body).toEqual(result.body);
      expect(await f.rows('payments')).toHaveLength(1);
    }));

  it('TC19 foundation: offline outbox, IDOR, current guards and own projections', async () => f.partial('TC19', 'US42/US45',
    'Real GYM/PT JWT/session/IDOR, offline REST and two outbox workers; retail own routes/link changes/socket duplicates missing.', async () => {
      const sale = await f.sale();
      const guest = await f.send({ app: 1, path: `/transactions/${sale.transactionId}`, method: 'GET' }); expect(guest.status).toBe(401);
      const denied = await f.get(`/transactions/${sale.transactionId}`, f.members[0], 1); expect(denied.status).toBe(403);
      const result = await f.send(f.confirm(sale.transactionId)); ok(result);
      const own = await f.get(`/me/invoices/${result.body.invoiceId}`, f.members[0], 1); ok(own);
      expect(JSON.stringify(own.body)).not.toMatch(/bankReference|receivingAccount|evidenceNote|verifiedBy|FIXTURE:/);
      expect((await f.get(`/me/invoices/${result.body.invoiceId}`, f.members[1], 1)).status).toBe(404);
      const jobs = await f.rows('notification_outbox'); expect(jobs).toHaveLength(1);
      const ownInbox = await f.get('/notifications/sync', f.members[0], 1); ok(ownInbox);
      expect(JSON.stringify(ownInbox.body)).not.toMatch(/bank_reference|bankReference|recipientPhone|password/);
      await Promise.all(f.apps.map(app => app.rpc('outboxWorker')));
      expect(await f.rows('payments')).toHaveLength(1); expect(await f.rows('notification_outbox')).toHaveLength(1);
      // Account lock fixture exercises actual Guard on replay and lookup; restore for subsequent rounds.
      await f.db.collection('accounts').updateOne({ _id: new ObjectId(f.staff.id) }, { $set: { status: 'LOCKED' } });
      try {
        expect((await f.send(f.confirm(sale.transactionId))).status).toBe(401);
        expect((await f.get(`/operations/PAYMENT_CONFIRM/${f.key()}`)).status).toBe(401);
      } finally { await f.db.collection('accounts').updateOne({ _id: new ObjectId(f.staff.id) }, { $set: { status: 'ACTIVE' } }); }
    }));

  it('TC20 foundation: GYM/PT terms and invoice buyer snapshots survive later edits', async () => f.partial('TC20', 'US40/US41/US53',
    'Real GYM/PT snapshot regression; retail snapshots and POS cart invariance await order/cart writers.', async round => {
      const sale = await f.sale(round % 2 ? 'PT' : 'GYM');
      const terms = await f.send({ app: 1, actor: f.admin, path: `/admin/plans/${sale.planId}`, method: 'PATCH',
        body: { version: 0, name: 'EN06 changed', price: '999999', benefits: 'Changed terms', status: 'INACTIVE' } }); ok(terms);
      const result = await f.send(f.confirm(sale.transactionId, round % 2)); ok(result);
      const before = await f.get(`/invoices/${result.body.invoiceId}`); ok(before);
      const changed = await f.send({ app: 1, actor: f.staff, path: `/members/${sale.memberId}`, method: 'PATCH', body: { version: 1, fullName: 'EN06 changed profile' } }); ok(changed);
      const after = await f.get(`/invoices/${result.body.invoiceId}`, f.staff, 1); ok(after);
      expect(after.body).toEqual(before.body);
      expect(after.body).toMatchObject({ totalAmount: '300000', serviceLine: { benefits: 'EN06 original benefits' } });
      const memberships = await f.get('/me/memberships', f.members[0], 1); ok(memberships);
      expect(await f.rows('memberships')).toHaveLength(1);
    }));
});
