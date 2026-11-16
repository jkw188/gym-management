// Test executable only: never imported by src/main or shipped as an HTTP hook.
if (process.env.NODE_ENV !== 'test' || process.env.EN05_CHILD !== '1' || !process.send ||
    !/^gym_test_[a-z0-9_]+$/.test(process.env.MONGODB_DB || '')) throw new Error('EN05_TEST_PROCESS_REQUIRED');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { getConnectionToken } = require('@nestjs/mongoose');
const { ServerClock } = require('../dist/common/utils/business-date');
const { DataGuardsService } = require('../dist/infrastructure/transaction/data-guards.service');
const { BookingRepository } = require('../dist/modules/bookings/booking.repository');
const { AdminPublicSessionsRepository } = require('../dist/modules/public-sessions/admin-public-sessions.repository');
const { NotificationsRepository } = require('../dist/modules/notifications/notifications.repository');
const { NotificationOutboxService } = require('../dist/modules/notifications/notification-outbox.service');
const { OperationRequestsRepository } = require('../dist/modules/operations/operation-requests.repository');
const { AccessCatalogService } = require('../dist/modules/users/access-catalog.service');
const { UsersRepository } = require('../dist/modules/users/users.repository');
const { PasswordService } = require('../dist/common/security/password.service');
const { ApplicationError } = require('../dist/common/errors/application-error');
const { MongoServerError } = require('mongodb');
let app, now, hook, release;
const clock = new ServerClock();
clock.now = () => new Date(now);

function wrap(target, method, point) {
  const original = target[method].bind(target);
  target[method] = async (...args) => {
    if (point === 'guard') await hit(point);
    const result = await original(...args);
    if (point !== 'guard') await hit(point);
    return result;
  };
}
async function hit(point) {
  if (!hook || hook.point !== point) return;
  const active = hook; hook = undefined;
  process.send({ event: 'hit', point });
  if (active.mode === 'pause') await new Promise(resolve => { release = resolve; });
  if (active.mode === 'rollback') throw new ApplicationError(503, 'EN05_INJECTED_ROLLBACK', 'Test rollback');
  if (active.mode === 'retry') {
    now = active.nextNow;
    const error = new MongoServerError({ message: 'EN05 transient transaction', code: 112 });
    error.addErrorLabel('TransientTransactionError');
    throw error;
  }
}

async function main() {
  now = process.env.EN05_NOW;
  const { AppModule } = require('../dist/app.module');
  const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(ServerClock).useValue(clock).compile();
  app = module.createNestApplication({ logger: false, bodyParser: false });
  app.use((_request, response, next) => {
    const end = response.end;
    response.end = function (...args) {
      if (hook?.point === 'responseUnknown' && response.statusCode < 300) {
        hook = undefined;
        process.send({ event: 'hit', point: 'responseUnknown' });
        response.statusCode = 503;
        response.removeHeader('Content-Length');
        return end.call(this, JSON.stringify({ error: { code: 'OPERATION_OUTCOME_UNKNOWN', message: 'EN05 test response' } }));
      }
      if (hook?.point === 'response' && response.statusCode < 300) {
        hook = undefined;
        process.send({ event: 'hit', point: 'response' });
        response.socket?.destroy();
        return response;
      }
      return end.apply(this, args);
    };
    next();
  });
  require('../dist/common/http/configure-http').configureHttp(app);
  const connection = app.get(getConnectionToken());
  await Promise.all(Object.values(connection.models).map(model => model.init()));
  await require('../dist/infrastructure/transaction/financial-integrity').ensureFinancialIntegrity(connection);
  await require('../dist/modules/scheduling/scheduling-migration').ensureSchedulingIntegrity(connection);
  await app.init();
  await app.get(AccessCatalogService).seed();
  wrap(app.get(DataGuardsService), 'acquire', 'guard');
  wrap(app.get(BookingRepository), 'insertBooking', 'booking');
  wrap(app.get(BookingRepository), 'insertBookingEvent', 'audit');
  wrap(app.get(AdminPublicSessionsRepository), 'insertEvent', 'classAudit');
  wrap(app.get(NotificationsRepository), 'insertRecipients', 'recipient');
  wrap(app.get(NotificationsRepository), 'insertOutbox', 'outbox');
  wrap(app.get(OperationRequestsRepository), 'insert', 'key');
  // Crash after emit but BEFORE marking DONE, exercising the real lease/worker recovery.
  const repo = app.get(NotificationsRepository), markDone = repo.markJobDone.bind(repo);
  repo.markJobDone = async (...args) => { await hit('afterEmit'); return markDone(...args); };
  await app.listen(0, '127.0.0.1');
  process.send({ event: 'ready', pid: process.pid, url: await app.getUrl(), indexes: true });
  process.on('message', async message => {
    try {
      let result = null;
      switch (message.command) {
        case 'clock': now = message.value; break;
        case 'arm': hook = message.value; break;
        case 'release': release?.(); release = undefined; break;
        case 'clear': hook = undefined; release?.(); release = undefined; break;
        case 'worker': result = await app.get(NotificationOutboxService).runOnce(); break;
        case 'validate': {
          result = {};
          for (const name of ['Member', 'Trainer', 'TrainerEvent', 'Plan', 'WorkShift', 'PublicSession', 'PublicSessionEvent', 'Membership', 'ServiceSale', 'Transaction', 'PtBooking']) {
            const model = connection.models[name];
            const rows = await model.collection.find({}).toArray();
            for (const row of rows) await model.hydrate(row).validate();
            result[name] = rows.length;
          }
          break;
        }
        case 'accounts': {
          const users = app.get(UsersRepository), hash = await app.get(PasswordService).hash(message.value.password);
          result = [];
          for (const [i, code] of ['ADMIN', 'STAFF', 'TRAINER', 'TRAINER', 'MEMBER', 'MEMBER', 'MEMBER'].entries()) {
            const role = await users.findRoleByCode(code);
            const account = await users.createAccount({ roleId: String(role.id), fullName: `EN05 fixture ${i}`,
              phone: `+8499900000${i}`, passwordHash: hash });
            result.push({ id: String(account._id), phone: account.phone, role: code });
          }
          break;
        }
        case 'close': await app.close(); process.send({ id: message.id, result }); process.disconnect(); return;
        default: throw new Error('EN05_UNKNOWN_COMMAND');
      }
      process.send({ id: message.id, result });
    } catch { process.send({ id: message.id, error: 'EN05_CHILD_COMMAND_FAILED' }); }
  });
}
process.on('disconnect', () => { release?.(); void app?.close().finally(() => process.exit(0)); });
main().catch(() => { process.send?.({ event: 'failed', error: 'EN05_APP_SETUP_FAILED' }); process.exitCode = 1; });
