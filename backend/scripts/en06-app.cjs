// IPC-only test executable. Production main never imports this file.
if (process.env.NODE_ENV !== 'test' || process.env.EN06_CHILD !== '1' || !process.send ||
    !/^gym_test_[a-z0-9_]+$/.test(process.env.MONGODB_DB || '')) throw new Error('EN06_TEST_PROCESS_REQUIRED');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { getConnectionToken } = require('@nestjs/mongoose');
const { ServerClock } = require('../dist/common/utils/business-date');
const { DataGuardsService } = require('../dist/infrastructure/transaction/data-guards.service');
const { InventoryWriter } = require('../dist/modules/inventory/inventory-writer');
const { StockRepository } = require('../dist/modules/stock/stock.repository');
const { SettlementRepository } = require('../dist/modules/payments/settlement.repository');
const { NotificationsRepository } = require('../dist/modules/notifications/notifications.repository');
const { NotificationOutboxService } = require('../dist/modules/notifications/notification-outbox.service');
const { OrderExpiryWorker } = require('../dist/modules/orders/order-expiry.worker');
const { OperationRequestsRepository } = require('../dist/modules/operations/operation-requests.repository');
const { AccessCatalogService } = require('../dist/modules/users/access-catalog.service');
const { UsersRepository } = require('../dist/modules/users/users.repository');
const { PasswordService } = require('../dist/common/security/password.service');
const { ApplicationError } = require('../dist/common/errors/application-error');
let app, now = process.env.EN06_NOW, hook, release;
const clock = new ServerClock();
clock.now = () => new Date(now);
async function hit(point) {
  if (hook?.point !== point) return;
  const active = hook; hook = undefined;
  process.send({ event: 'hit', point });
  if (active.mode === 'pause') await new Promise(resolve => { release = resolve; });
  if (active.mode === 'rollback') throw new ApplicationError(503, 'EN06_INJECTED_ROLLBACK', 'Fixture rollback');
}
function wrap(target, method, point, before = false) {
  const original = target[method].bind(target);
  target[method] = async (...args) => {
    if (before) await hit(point);
    const result = await original(...args);
    if (!before) await hit(point);
    return result;
  };
}
async function main() {
  const { AppModule } = require('../dist/app.module');
  const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(ServerClock).useValue(clock).compile();
  app = module.createNestApplication({ logger: false, bodyParser: false });
  app.use((_request, response, next) => {
    const end = response.end;
    response.end = function (...args) {
      // Lose the HTTP response AFTER the real transaction has committed.
      if (hook?.point === 'response' && response.statusCode < 300) {
        hook = undefined; process.send({ event: 'hit', point: 'response' });
        response.socket?.destroy(); return response;
      }
      return end.apply(this, args);
    };
    next();
  });
  require('../dist/common/http/configure-http').configureHttp(app);
  const connection = app.get(getConnectionToken());
  await Promise.all(Object.values(connection.models).map(model => model.init()));
  await require('../dist/infrastructure/transaction/financial-integrity').ensureFinancialIntegrity(connection);
  await require('../dist/modules/catalog/retail-catalog.migration').ensureRetailCatalogIntegrity(connection);
  // Same singleton initializer as admin.cjs ensure-indexes, on the owned empty test DB.
  await connection.models.SecurityState.updateOne({ _id: 'account-administration' }, { $setOnInsert: { revision: 0n } }, { upsert: true });
  for (const model of Object.values(connection.models)) {
    const indexes = await model.collection.listIndexes().toArray();
    for (const [key, options] of model.schema.indexes()) {
      if (!indexes.some(index => JSON.stringify(index.key) === JSON.stringify(key) && Boolean(index.unique) === Boolean(options.unique) &&
          JSON.stringify(index.partialFilterExpression) === JSON.stringify(options.partialFilterExpression))) throw new Error('EN06_INDEX_MISSING');
    }
    if (['orders', 'order_items', 'payments', 'invoices', 'refunds', 'stock_movements', 'operation_requests'].includes(model.collection.name) &&
        indexes.some(index => index.expireAfterSeconds !== undefined)) throw new Error('EN06_FINANCIAL_TTL');
  }
  await app.init();
  await app.get(AccessCatalogService).seed();
  wrap(app.get(DataGuardsService), 'acquire', 'guard', true);
  wrap(app.get(InventoryWriter), 'lock', 'inventoryLock', true);
  wrap(app.get(InventoryWriter), 'insertMovement', 'movement');
  wrap(app.get(StockRepository), 'insertEvent', 'stockAudit');
  wrap(app.get(SettlementRepository), 'insertPayment', 'payment');
  wrap(app.get(SettlementRepository), 'insertInvoice', 'invoice');
  wrap(app.get(SettlementRepository), 'settle', 'settle');
  wrap(app.get(NotificationsRepository), 'insertRecipients', 'recipient');
  wrap(app.get(NotificationsRepository), 'insertOutbox', 'outbox');
  wrap(app.get(OperationRequestsRepository), 'insert', 'operation');
  wrap(connection.models.Refund, 'create', 'refund');
  wrap(connection.models.Payment, 'create', 'latePayment');
  wrap(connection.models.OrderEvent, 'create', 'orderAudit');
  await app.listen(0, '127.0.0.1');
  process.send({ event: 'ready', pid: process.pid, url: await app.getUrl() });
  process.on('message', async message => {
    try {
      let result = null;
      switch (message.command) {
        case 'clock':
          if (!Number.isFinite(Date.parse(message.value))) throw new Error('INVALID_CLOCK');
          now = message.value; break;
        case 'arm': hook = message.value; break;
        case 'release': release?.(); release = undefined; break;
        case 'clear': hook = undefined; release?.(); release = undefined; break;
        case 'outboxWorker': result = await app.get(NotificationOutboxService).runOnce(); break;
        case 'expiryWorker': result = await app.get(OrderExpiryWorker).runOnce(); break;
        case 'accounts': {
          const users = app.get(UsersRepository), hash = await app.get(PasswordService).hash(message.value.password);
          result = [];
          for (const [i, code] of ['ADMIN', 'STAFF', 'MEMBER', 'MEMBER'].entries()) {
            const role = await users.findRoleByCode(code);
            const account = await users.createAccount({ roleId: String(role.id), fullName: `EN06 fixture ${i}`,
              phone: `+8499906000${i}`, passwordHash: hash });
            result.push({ id: String(account._id), phone: account.phone, role: code });
          }
          break;
        }
        // US-41 nhóm A (TC01): thêm N tài khoản MEMBER để 20 Member khác nhau cùng tranh SKU cuối.
        case 'memberAccounts': {
          const users = app.get(UsersRepository), hash = await app.get(PasswordService).hash(message.value.password);
          const role = await users.findRoleByCode('MEMBER');
          result = [];
          for (let i = 0; i < message.value.count; i++) {
            const account = await users.createAccount({ roleId: String(role.id), fullName: `EN06 fixture member ${i}`,
              phone: `+849990610${String(i).padStart(2, '0')}`, passwordHash: hash });
            result.push({ id: String(account._id), phone: account.phone, role: 'MEMBER' });
          }
          break;
        }
        case 'validate': {
          result = {};
          for (const [name, model] of Object.entries(connection.models)) {
            const rows = await model.collection.find({}).toArray();
            for (const row of rows) await model.hydrate(row).validate();
            result[name] = rows.length;
          }
          break;
        }
        case 'close': await app.close(); process.send({ id: message.id, result }); process.disconnect(); return;
        default: throw new Error('EN06_UNKNOWN_COMMAND');
      }
      process.send({ id: message.id, result });
    } catch { process.send({ id: message.id, error: 'EN06_CHILD_COMMAND_FAILED' }); }
  });
}
process.on('disconnect', () => { release?.(); void app?.close().finally(() => process.exit(0)); });
main().catch(() => { process.send?.({ event: 'failed', error: 'EN06_APP_SETUP_FAILED' }); process.exitCode = 1; });
