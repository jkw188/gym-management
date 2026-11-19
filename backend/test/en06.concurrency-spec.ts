import { ObjectId } from 'mongodb';
import { Call, En06Fixture, Outcome } from './helpers/en06-fixture';

describe('EN-06 / two processes / real MongoDB / available foundation only', () => {
  const f = new En06Fixture();
  const ok = (outcome: Outcome, status = 200) => expect({ status: outcome.status, error: outcome.body.error }).toEqual({ status, error: undefined });
  const codes = (outcomes: Outcome[]) => outcomes.forEach(outcome => expect([200, 409]).toContain(outcome.status));
  // US-41 nhóm A: đọc mã lỗi và số dư tồn của một SKU.
  const codeOf = (outcome: Outcome) => (outcome.body.error as { code?: string } | undefined)?.code;
  const balanceOf = async (productId: string) => {
    const [row] = await f.rows('inventory', { product_id: new ObjectId(productId) });
    return { onHand: Number(row.on_hand), reserved: Number(row.reserved) };
  };
  beforeAll(async () => f.start(), 120000);
  afterAll(async () => f.close());

  it('records stable TC IDs and missing production dependencies without skipped/pass placeholders', () => {
    f.blocked('TC02', 'US41/US53', 'POS writer exists and is covered in pos.integration-spec.ts; WEBSITE factory is absent, so the cross-channel race remains blocked.');
    f.blocked('TC11', 'US41', 'Real cancel/fulfill race is tested in order-cancellation.integration-spec.ts with persisted order/reservation fixtures; this end-to-end harness still lacks US41 factory.');
    f.blocked('TC12', 'US41', 'Two expiry workers are tested in US45; POS creation/payment/expiry is covered in US53; WEBSITE setup remains unavailable here.');
    f.blocked('TC13', 'US41', 'US43/44 verify prepare/fulfill deadlines; US53 verifies real POS payment deadline; WEBSITE checkout remains missing here.');
    f.blocked('TC14', 'US41', 'US45 covers real expiry catch-up/restart/batch50 with persisted orders; full factory-generated backlog remains unavailable.');
    f.blocked('TC15', 'US41', 'Real late receipt/refund obligation is covered by the US45 suite; this harness still needs US41-created cancelled orders.');
    f.blocked('TC16', 'US41', 'US45 covers mismatch/extra receipts and unique references; end-to-end checkout/payment setup is still missing.');
  });

  it('TC01: 20 Member khác nhau tranh SKU còn 1 qua hai app → đúng 1 đơn HELD, available không âm', async () => f.passed('TC01', 'US41',
    'US-41 website writer: 20 distinct linked Members race the last unit through two processes.', async round => {
      const { productIds: [sku] } = await f.shop('9000', 1);
      const calls: Call[] = [];
      for (const actor of f.crowd) {
        await f.memberProfile(actor);
        const ready = await f.readyCart(actor, [[sku, 1]]);
        calls.push(f.websiteCreate(actor, ready.app, ready.body));
      }
      const outcomes = await f.race(calls, round);
      expect(outcomes.filter(outcome => outcome.status === 201)).toHaveLength(1);
      for (const outcome of outcomes.filter(row => row.status !== 201)) { expect(outcome.status).toBe(409); expect(codeOf(outcome)).toBe('INSUFFICIENT_STOCK'); }
      expect(await balanceOf(sku)).toEqual({ onHand: 1, reserved: 1 });
      expect(await f.rows('orders', { channel: 'WEBSITE', reservation_state: 'HELD' })).toHaveLength(1);
      expect(await f.rows('stock_movements', { kind: 'ORDER_RESERVE' })).toHaveLength(1);
    }));

  it('TC03: hai checkout khác key cùng Member/cartVersion qua hai app → giỏ dùng 1 lần, 1 đơn, version đúng', async () => f.passed('TC03', 'US40/US41',
    'US-41 website writer: two keys for the same Member and cartVersion through two processes.', async round => {
      const { productIds: [sku] } = await f.shop('9000', 10);
      const member = f.members[0], memberId = await f.memberProfile(member);
      const ready = await f.readyCart(member, [[sku, 2]]);
      const outcomes = await f.race([f.websiteCreate(member, 0, ready.body), f.websiteCreate(member, 1, ready.body)], round);
      expect(outcomes.map(outcome => outcome.status).sort()).toEqual([201, 409]);
      expect(['CART_VERSION_CONFLICT', 'CART_EMPTY']).toContain(codeOf(outcomes.find(outcome => outcome.status === 409)!));
      expect(await f.rows('orders')).toHaveLength(1);
      expect(await f.rows('carts', { member_id: new ObjectId(memberId) })).toHaveLength(0);
      const [state] = await f.rows('cart_states', { _id: new ObjectId(memberId) });
      expect(Number(state.version)).toBe(ready.version + 1);
      expect(await balanceOf(sku)).toEqual({ onHand: 10, reserved: 2 });
    }));

  it('TC06: Admin đổi giá/ngừng danh mục cạnh tranh create → snapshot đúng quote hoặc STALE/UNAVAILABLE, không âm thầm đổi giá', async () => f.passed('TC06', 'US41',
    'US-41 website writer races real Admin catalog writes (price change on even rounds, category stop on odd rounds).', async round => {
      const shop = await f.shop('9000', 10), [sku] = shop.productIds;
      const member = f.members[0]; await f.memberProfile(member);
      const ready = await f.readyCart(member, [[sku, 1]]);
      const change: Call = round % 2
        ? { app: 1, actor: f.admin, path: `/admin/categories/${shop.categoryId}`, method: 'PATCH', key: f.key(), body: { version: 0, status: 'INACTIVE' } }
        : { app: 1, actor: f.admin, path: `/admin/products/${sku}`, method: 'PATCH', key: f.key(), body: { version: 0, price: '9500' } };
      const [created, changed] = await f.race([f.websiteCreate(member, 0, ready.body), change], round);
      ok(changed);
      if (created.status === 201) {
        const [line] = await f.rows('order_items');
        expect(String(line.unit_price)).toBe('9000');
        const [transaction] = await f.rows('transactions', { kind: 'RETAIL' });
        expect(String(transaction.amount_due)).toBe('9000');
        expect(await balanceOf(sku)).toEqual({ onHand: 10, reserved: 1 });
      } else {
        expect(created.status).toBe(409);
        expect(round % 2 ? ['PRODUCT_UNAVAILABLE', 'QUOTE_STALE'] : ['QUOTE_STALE']).toContain(codeOf(created));
        expect(await f.rows('orders')).toHaveLength(0);
        expect(await balanceOf(sku)).toEqual({ onHand: 10, reserved: 0 });
      }
    }));

  it('TC10: Member hủy và Staff thu tiền cạnh tranh qua hai app → hủy trước thì chặn thu; thu trước thì hủy kèm refund PENDING', async () => f.passed('TC10', 'US41/US45',
    'US-41 website order + US-22 RETAIL confirm race the US-45 own cancel through two processes.', async round => {
      const { productIds: [sku] } = await f.shop('9000', 10);
      const member = f.members[0]; await f.memberProfile(member);
      const ready = await f.readyCart(member, [[sku, 1]]);
      const created = await f.send(f.websiteCreate(member, 0, ready.body)); ok(created, 201);
      const orderId = String(created.body.id), transactionId = String(created.body.transactionId);
      const cancel: Call = { app: 1, actor: member, path: `/me/orders/${orderId}/cancel`, key: f.key(), operation: 'ORDER_CANCEL_OWN',
        body: { version: 0, reason: 'EN06 khách đổi ý hủy đơn' } };
      const [paid, cancelled] = await f.race([f.retailConfirm(transactionId, '9000', 0), cancel], round);
      const [transaction] = await f.rows('transactions', { _id: new ObjectId(transactionId) });
      const [order] = await f.rows('orders', { _id: new ObjectId(orderId) });
      const payments = await f.rows('payments', { transaction_id: new ObjectId(transactionId), status: 'SUCCEEDED' });
      if (transaction.status === 'SETTLED') {
        ok(paid); expect(payments).toHaveLength(1);
        if (order.status === 'CANCELLED') { ok(cancelled); expect(await f.rows('refunds', { status: 'PENDING' })).toHaveLength(1); }
        else { expect(cancelled.status).toBe(409); expect(order).toMatchObject({ status: 'PENDING', reservation_state: 'HELD' }); }
      } else {
        ok(cancelled); expect(paid.status).toBe(409);
        expect(transaction.status).toBe('CANCELLED'); expect(payments).toHaveLength(0);
        expect(await f.rows('invoices')).toHaveLength(0);
        expect(order).toMatchObject({ status: 'CANCELLED', reservation_state: 'RELEASED' });
        expect(await balanceOf(sku)).toEqual({ onHand: 10, reserved: 0 });
      }
    }));

  it('TC04: 20 receipt replays and transport loss preserve original IDs; 20 website create same key/payload → 1 order, replay IDs gốc', async () => f.passed('TC04', 'US41/US53',
    'Receipt idempotency plus US-41 website create: 20 same-key requests through two processes and a lost committed response.', async round => {
      const products = await f.catalog(), receipt = await f.receipt(products), key = f.key();
      const outcomes = await f.race(Array.from({ length: 20 }, (_, index) => f.postReceipt(String(receipt.id), index % 2, key)), round);
      await f.apps[0].arm('response');
      const original = await f.send(f.postReceipt(String(receipt.id), 0, key)); ok(original);
      outcomes.forEach(outcome => { ok(outcome); expect(outcome.body).toEqual(original.body); });
      expect(await f.rows('stock_movements')).toHaveLength(2);
      expect(await f.rows('stock_document_events', { action: 'POSTED' })).toHaveLength(1);
      // US-41 nhóm A: 20 lệnh tạo đơn WEBSITE cùng key/payload, rồi mất response sau commit.
      const member = f.members[0], memberId = await f.memberProfile(member);
      const shop = await f.shop('9000', 10), ready = await f.readyCart(member, [[shop.productIds[0], 2]]), webKey = f.key();
      const web = await f.race(Array.from({ length: 20 }, (_, index) => f.websiteCreate(member, index % 2, ready.body, webKey)), round);
      await f.apps[0].arm('response');
      const webOriginal = await f.send(f.websiteCreate(member, 0, ready.body, webKey)); ok(webOriginal, 201);
      web.forEach(outcome => { ok(outcome, 201); expect(outcome.body).toEqual(webOriginal.body); });
      expect(await f.rows('orders')).toHaveLength(1);
      expect(await f.rows('order_events', { action: 'CREATED' })).toHaveLength(1);
      expect(await f.rows('stock_movements', { kind: 'ORDER_RESERVE' })).toHaveLength(1);
      expect(await f.rows('operation_requests', { operation: 'ORDER_CREATE_WEBSITE' })).toHaveLength(1);
      const [state] = await f.rows('cart_states', { _id: new ObjectId(memberId) });
      expect(Number(state.version)).toBe(ready.version + 1);
    }));

  it('TC05: same key with changed version/target conflicts; website same key khác payload/quote → 409, không ý định thứ 2', async () => f.passed('TC05', 'US41/US53',
    'Operation fingerprint for receipts plus US-41 website create (recipient/quote changes) through two processes.', async round => {
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
      // US-41 nhóm A: cùng key, nửa số lệnh đổi người nhận → 10 thành công cùng body, 10 IDEMPOTENCY_CONFLICT; đổi quote cũng 409.
      const member = f.members[0]; await f.memberProfile(member);
      const shop = await f.shop('9000', 10), ready = await f.readyCart(member, [[shop.productIds[0], 1]]), webKey = f.key();
      const changed = { ...ready.body, recipientName: 'EN06 người nhận khác' };
      const webCalls = Array.from({ length: 20 }, (_, index) => f.websiteCreate(member, index % 2, index % 2 ? ready.body : changed, webKey));
      const web = await f.race(webCalls, round);
      expect(web.filter(row => row.status === 201)).toHaveLength(10);
      web.filter(row => row.status !== 201).forEach(row => { expect(row.status).toBe(409); expect(codeOf(row)).toBe('IDEMPOTENCY_CONFLICT'); });
      const webWinner = webCalls[web.findIndex(row => row.status === 201)];
      const quoteChanged = await f.send({ ...webWinner, body: { ...(webWinner.body as object), quoteToken: 'EN06-another-quote' } });
      expect(quoteChanged.status).toBe(409); expect(codeOf(quoteChanged)).toBe('IDEMPOTENCY_CONFLICT');
      expect(await f.rows('orders')).toHaveLength(1);
      expect(await f.rows('operation_requests', { operation: 'ORDER_CREATE_WEBSITE' })).toHaveLength(1);
    }));

  it('TC07 foundation: POSTED receipts race through shared inventory lock with readers', async () => f.partial('TC07', 'US41/US53',
    'Real receipt/reader/ledger race here; POS reservations covered in US53; WEBSITE reservation setup missing.', async round => {
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
    'GYM/PT payment uniqueness verified here; RETAIL dispatch exists and POS uniqueness is covered in US53; WEBSITE setup missing.', async round => {
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

  it('TC17: free GYM/PT invoice has no zero payment; free WEBSITE order SETTLED/invoice 0 nhưng vẫn PENDING + HELD', async () => f.passed('TC17', 'US41/US53',
    'Zero GYM/PT handler plus US-41 free website checkout (invoice 0 in the create session, no zero payment).', async () => {
      for (const [index, kind] of (['GYM', 'PT'] as const).entries()) {
        const sale = await f.sale(kind, '0', index);
        const call = f.confirm(sale.transactionId, index);
        const denied = await f.send({ ...call, body: { ...call.body, amount: '0' } });
        expect(denied.status).toBe(409);
      }
      // US-41 nhóm A: members[0] đã được sale() liên kết hồ sơ; đặt đơn WEBSITE 0 đồng rồi cố thu 0.
      const shop = await f.shop('0', 5), ready = await f.readyCart(f.members[0], [[shop.productIds[0], 2]]);
      const free = await f.send(f.websiteCreate(f.members[0], 1, ready.body)); ok(free, 201);
      expect(free.body).toMatchObject({ total: '0', transactionStatus: 'SETTLED', reservationState: 'HELD' });
      expect(typeof free.body.invoiceId).toBe('string');
      expect((await f.rows('orders'))[0]).toMatchObject({ status: 'PENDING', reservation_state: 'HELD' });
      expect([400, 409]).toContain((await f.send(f.retailConfirm(String(free.body.transactionId), '0', 0))).status);
      expect(await balanceOf(shop.productIds[0])).toEqual({ onHand: 5, reserved: 2 });
      expect(await f.rows('payments')).toHaveLength(0);
      expect(await f.rows('invoices')).toHaveLength(3);
      expect((await f.rows('invoices')).every(row => String(row.total_amount) === '0')).toBe(true);
    }));

  it('TC18 foundation: rollback after each existing write; lost committed response resolves by original key', async () => f.partial('TC18', 'US41/US45/US53',
    'Inventory/payment/invoice/audit/outbox/operation hooks verified; US45 refund/cancel faults have a separate suite; factory/order-items/cart faults still await US41.', async () => {
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

  it('TC20: GYM/PT terms, invoice buyer snapshots and WEBSITE order/invoice snapshots survive later edits', async () => f.passed('TC20', 'US40/US41/US53',
    'GYM/PT snapshots plus US-41 website order items and RETAIL invoice after catalog/profile edits.', async round => {
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
      // US-41 nhóm A: đơn WEBSITE đã thu; đổi tên/giá sản phẩm sau đó → dòng đơn và invoice RETAIL giữ snapshot.
      const shop = await f.shop('9000', 5), [sku] = shop.productIds, ready = await f.readyCart(f.members[0], [[sku, 1]]);
      const created = await f.send(f.websiteCreate(f.members[0], 0, ready.body)); ok(created, 201);
      const paid = await f.send(f.retailConfirm(String(created.body.transactionId), '9000', 1)); ok(paid);
      const retailBefore = await f.get(`/invoices/${paid.body.invoiceId}`); ok(retailBefore);
      const itemsBefore = await f.rows('order_items');
      ok(await f.send({ app: 1, actor: f.admin, path: `/admin/products/${sku}`, method: 'PATCH', key: f.key(), body: { version: 0, name: 'EN06 tên đã đổi', price: '99000' } }));
      const retailAfter = await f.get(`/invoices/${paid.body.invoiceId}`, f.staff, 1); ok(retailAfter);
      expect(retailAfter.body).toEqual(retailBefore.body);
      expect(await f.rows('order_items')).toEqual(itemsBefore);
    }));
});
