// Opt-in demo data uses the same authenticated REST writers as UAT; no guards or clocks are bypassed.
async function seedDemo(env) {
  require('reflect-metadata');
  const { assertUat } = require('./uat.cjs');
  assertUat(env, true);
  const { NestFactory } = require('@nestjs/core');
  const { getConnectionToken } = require('@nestjs/mongoose');
  const { randomUUID } = require('node:crypto');
  const { AppModule } = require('../dist/app.module');
  const { configureHttp } = require('../dist/common/http/configure-http');
  const { EnvironmentCheck } = require('../dist/infrastructure/environment/environment-check');
  const { SeedAdminService } = require('../dist/modules/users/seed-admin.service');
  const { AccessCatalogService } = require('../dist/modules/users/access-catalog.service');
  const { normalizePhone } = require('../dist/common/utils/normalization');
  const { PasswordService } = require('../dist/common/security/password.service');
  const credentials = { ADMIN: { phone: env.SEED_ADMIN_PHONE, password: env.SEED_ADMIN_PASSWORD } };
  for (const role of ['STAFF', 'TRAINER', 'MEMBER']) credentials[role] = { phone: env[`DEMO_${role}_PHONE`], password: env[`DEMO_${role}_PASSWORD`] };
  for (const credential of Object.values(credentials)) {
    credential.phone = normalizePhone(credential.phone);
    new PasswordService().validate(credential.password);
  }
  if (new Set(Object.values(credentials).map(row => row.phone)).size !== 4) throw new Error('UAT_DEMO_DISTINCT_ACCOUNTS_REQUIRED');
  const app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
  let claimed = false, fixture;
  try {
    configureHttp(app); await app.init();
    const connection = app.get(getConnectionToken()), db = connection.db;
    await new EnvironmentCheck(connection).assertReady();
    fixture = db.collection('_uat_fixtures');
    const existing = await fixture.findOne({ _id: 'en07-demo-v1' });
    if (existing?.status === 'COMPLETED') { console.info(JSON.stringify({ code: 'UAT_DEMO_UNCHANGED' })); return; }
    if (existing) throw new Error('UAT_DEMO_PARTIAL_REQUIRES_REVIEW');
    const allowed = new Set(['accounts', 'roles', 'permissions', 'role_permissions', 'security_state', 'notification_counters', 'catalog_state', 'schedule_guards']);
    for (const row of await db.listCollections({}, { nameOnly: true }).toArray()) {
      if (!allowed.has(row.name) && await db.collection(row.name).countDocuments({}, { limit: 1 })) throw new Error('UAT_DEMO_FRESH_DATABASE_REQUIRED');
    }
    const accounts = await db.collection('accounts').find().toArray();
    if (accounts.length > 1 || accounts.some(row => row.phone !== credentials.ADMIN.phone)) throw new Error('UAT_DEMO_FRESH_DATABASE_REQUIRED');
    await fixture.insertOne({ _id: 'en07-demo-v1', status: 'RUNNING', startedAt: new Date(), results: {} }); claimed = true;
    await app.get(SeedAdminService).run({ ...credentials.ADMIN, fullName: env.SEED_ADMIN_NAME, email: env.SEED_ADMIN_EMAIL || undefined });
    await app.get(AccessCatalogService).seed();
    await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${app.getHttpServer().address().port}/api`;
    const tokens = {}, sessions = [], results = {};
    async function call(role, route, body, method = 'POST') {
      const response = await fetch(`${base}${route}`, { method, signal: AbortSignal.timeout(15000),
        headers: { Origin: env.FRONTEND_ORIGIN, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(),
          ...(tokens[role] ? { Authorization: `Bearer ${tokens[role]}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const suffix = /^[A-Z_]+$/.test(payload?.error?.code || '') ? payload.error.code : 'HTTP_FAILED';
        throw new Error(`UAT_DEMO_${suffix}`);
      }
      return payload;
    }
    async function login(role) {
      const result = await call(role, '/auth/login', credentials[role]);
      tokens[role] = result.accessToken; sessions.push(role);
      return result.user;
    }
    async function record(name, result) {
      results[name] = result;
      await fixture.updateOne({ _id: 'en07-demo-v1', status: 'RUNNING' }, { $set: { [`results.${name}`]: result } });
      return result;
    }
    const admin = await login('ADMIN'); await record('adminId', admin.id);
    try {
      const users = {};
      for (const role of ['STAFF', 'TRAINER', 'MEMBER']) {
        users[role] = await call('ADMIN', '/users', { ...credentials[role], fullName: `DEMO ONLY ${role}`, roleCode: role });
        await record(`${role.toLowerCase()}Id`, users[role].id); await login(role);
      }
      const member = await call('STAFF', '/members', { fullName: 'DEMO ONLY Member', phone: credentials.MEMBER.phone });
      await record('memberId', member.id);
      await call('STAFF', `/members/${member.id}/link`, { accountId: users.MEMBER.id, version: 0,
        verificationMethod: 'IN_PERSON_ACCOUNT', verificationNote: 'DEMO ONLY: fixture tổng hợp, không phải xác minh người thật' });
      const trainer = await call('ADMIN', '/trainers', { accountId: users.TRAINER.id, specialty: 'DEMO ONLY Fitness', status: 'ACTIVE' });
      await record('trainerId', trainer.id);
      const today = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
      for (const kind of ['GYM', 'PT']) {
        const plan = await call('ADMIN', '/admin/plans', { code: `DEMO_${kind}`, name: `DEMO ONLY ${kind}`, kind,
          durationDays: 30, sessionsQuota: kind === 'PT' ? 8 : 0, price: '100000', benefits: 'DEMO ONLY, không thu tiền thật' });
        await record(`${kind.toLowerCase()}PlanId`, plan.id);
        const sale = await call('STAFF', '/service-sales', { memberId: member.id, planId: plan.id, planVersion: plan.version, startDate: today });
        await record(`${kind.toLowerCase()}SaleId`, sale.saleId);
        await call('STAFF', `/transactions/${sale.transactionId}/confirm-payment`, { method: 'CASH', amount: '100000', evidenceNote: 'DEMO ONLY: tiền mô phỏng, không nhận tiền thật' });
      }
      const tomorrow = new Date(Date.now() + 86400000 + 7 * 3600000).toISOString().slice(0, 10);
      const shift = await call('TRAINER', '/me/work-shifts', { startAt: `${tomorrow}T08:00:00+07:00`, endAt: `${tomorrow}T11:00:00+07:00`, location: 'DEMO ONLY PT' });
      await record('shiftId', shift.id); await call('TRAINER', `/me/work-shifts/${shift.id}/confirm`, { version: 0 });
      // Ownership comes from the activated sale; memberships do not store member_id or kind.
      const { ObjectId } = require('mongodb');
      const ptSale = await db.collection('service_sales').findOne({ _id: new ObjectId(results.ptSaleId) });
      const ptMembership = await db.collection('memberships').findOne({ service_sale_id: ptSale._id });
      if (!ptMembership) throw new Error('UAT_DEMO_MEMBERSHIP_MISSING');
      const booking = await call('MEMBER', '/me/pt-bookings', { membershipId: String(ptMembership._id), trainerId: trainer.id, shiftId: shift.id, startAt: `${tomorrow}T08:00:00+07:00` });
      await record('bookingId', booking.id);
      const session = await call('ADMIN', '/admin/public-sessions', { title: 'DEMO ONLY Yoga', trainerId: trainer.id, subjectCode: 'YOGA', location: 'DEMO ONLY Studio',
        startAt: `${tomorrow}T14:00:00+07:00`, endAt: `${tomorrow}T15:00:00+07:00` });
      await record('publicSessionId', session.id); await call('ADMIN', `/admin/public-sessions/${session.id}/publish`, { version: 0 });
      const category = await call('ADMIN', '/admin/categories', { name: 'DEMO ONLY Retail', status: 'ACTIVE' });
      const product = await call('ADMIN', '/admin/products', { categoryId: category.id, sku: 'DEMO_WATER', name: 'DEMO ONLY Water', price: '25000', status: 'ACTIVE' });
      await record('productId', product.id);
      const receipt = await call('STAFF', '/stock-receipts', { reason: 'DEMO ONLY: nhập hàng mô phỏng', items: [{ productId: product.id, quantity: 20, unitCost: '10000' }] });
      await record('receiptId', receipt.id); await call('STAFF', `/stock-receipts/${receipt.id}/post`, { version: 0 });
      const intent = { memberId: member.id, preferredPaymentMethod: 'CASH', items: [{ productId: product.id, quantity: 2 }] };
      const quote = await call('STAFF', '/pos/orders/preview', intent);
      const order = await call('STAFF', '/pos/orders', { ...intent, quoteToken: quote.quoteToken });
      await record('posOrderId', order.id);
      await call('STAFF', `/transactions/${order.transactionId}/confirm-payment`, { method: 'CASH', amount: '50000', evidenceNote: 'DEMO ONLY: thu tiền mô phỏng tại quầy' });
      const detail = await call('STAFF', `/orders/${order.id}`, undefined, 'GET');
      await call('STAFF', `/pos/orders/${order.id}/fulfill`, { version: detail.version });
      const completed = await call('STAFF', `/orders/${order.id}`, undefined, 'GET');
      const returned = await call('STAFF', `/orders/${order.id}/returns`, { version: completed.version, reason: 'DEMO ONLY: trả một sản phẩm mô phỏng',
        items: [{ orderItemId: completed.items[0].id, quantity: 1, restockable: true, conditionNote: 'DEMO ONLY: hàng còn nguyên' }] });
      await record('returnId', returned.returnId); await record('refundId', returned.refundId);
      await call('STAFF', `/refunds/${returned.refundId}/confirm`, { version: 0, method: 'CASH', amount: '25000', paidOutAt: new Date().toISOString(),
        cashVoucherReference: 'DEMO_ONLY_EN07', evidenceNote: 'DEMO ONLY: chi tiền mô phỏng, không chi tiền thật' });
      await fixture.updateOne({ _id: 'en07-demo-v1' }, { $set: { status: 'COMPLETED', completedAt: new Date(),
        blockedDependencies: ['WEBSITE_CHECKOUT_NOT_IMPLEMENTED', 'REPORTS_NOT_IMPLEMENTED'] } });
      console.info(JSON.stringify({ code: 'UAT_DEMO_SEEDED', fixture: 'en07-demo-v1', blockedDependencies: ['WEBSITE_CHECKOUT_NOT_IMPLEMENTED', 'REPORTS_NOT_IMPLEMENTED'] }));
    } finally {
      for (const role of sessions) await call(role, '/auth/logout', {}).catch(() => undefined);
    }
  } catch (error) {
    if (claimed) await fixture.updateOne({ _id: 'en07-demo-v1' }, { $set: { status: 'FAILED', failedAt: new Date() } }).catch(() => undefined);
    throw error;
  } finally { await app.close(); }
}
module.exports = { seedDemo };
