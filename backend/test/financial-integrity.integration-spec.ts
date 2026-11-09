import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { Long, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose, { Connection } from 'mongoose';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { ApplicationError } from '../src/common/errors/application-error';
import { toVndDecimal } from '../src/common/utils/vnd-money';
import { DataGuardsService } from '../src/infrastructure/transaction/data-guards.service';
import { ensureFinancialIntegrity, FINANCIAL_INDEXES, hasFinancialIndex } from '../src/infrastructure/transaction/financial-integrity';
import { TransactionRunner } from '../src/infrastructure/transaction/transaction-runner';
import { IdempotencyService, transactionRequestKey } from '../src/modules/operations/idempotency.service';
import { OperationRequestsRepository } from '../src/modules/operations/operation-requests.repository';
import { OperationRequest, OperationRequestSchema } from '../src/modules/operations/schemas/operation-request.schema';

// These are infrastructure contract probes, not implementations/acceptance of US-09/12/14/22.
describe('EN-02: real indexes and ordered writes across two connections', () => {
  let mongo: MongoMemoryReplSet;
  let connections: Connection[];
  let runners: TransactionRunner[];
  let guards: DataGuardsService[];
  let commands: IdempotencyService[];
  const actorId = new ObjectId().toHexString();
  let member: ObjectId;
  let plan: ObjectId;

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
    connections = await Promise.all([0, 1].map(() => mongoose.createConnection(mongo.getUri(), {
      dbName: 'gym_management_test_en02_integrity', autoIndex: false, runtimeAdapters: { os },
    }).asPromise()));
    await ensureFinancialIntegrity(connections[0]);
    runners = connections.map(connection => new TransactionRunner(connection));
    guards = connections.map(connection => new DataGuardsService(connection));
    commands = connections.map((connection, index) => new IdempotencyService(runners[index],
      new OperationRequestsRepository(connection.model<OperationRequest>('OperationRequest', OperationRequestSchema), new ConfigService({ nodeEnv: 'test' }))));
  }, 600000);
  afterAll(async () => {
    for (const connection of connections ?? []) await connection.close();
    await mongo?.stop();
  });
  beforeEach(async () => {
    for (const collection of ['plans', 'members', 'transactions', 'service_sales', 'memberships', 'payments', 'invoices', 'operation_requests', 'notifications', 'security_state']) {
      await connections[0].collection(collection).deleteMany({});
    }
    member = new ObjectId(); plan = new ObjectId();
    await connections[0].collection('members').insertOne({ _id: member, service_revision: Long.ZERO });
    await connections[0].collection('plans').insertOne({ _id: plan, guard_revision: Long.ZERO, status: 'ACTIVE', version: 0, price: toVndDecimal('150000') });
  });

  async function register(instance: number, key: string) {
    const connection = connections[instance];
    return commands[instance].execute({ actorId, operation: 'SALE_REGISTER', clientKey: key, payload: { memberId: member.toHexString(), planId: plan.toHexString() } }, async session => {
      await guards[instance].acquire(session, { plans: [plan], members: [member] });
      const currentPlan = await connection.collection('plans').findOne({ _id: plan }, { session });
      if (currentPlan!.status !== 'ACTIVE') throw new ApplicationError(409, 'PLAN_UNAVAILABLE', 'Plan unavailable');
      if (await connection.collection('service_sales').findOne({ member_id: member, status: 'PENDING' }, { session })) {
        throw new ApplicationError(409, 'PENDING_SALE_EXISTS', 'Pending sale');
      }
      const transaction = await connection.collection('transactions').insertOne({
        request_key: transactionRequestKey(actorId, 'SALE_REGISTER', key), status: 'PENDING', version: 0, guard_revision: Long.ZERO,
      }, { session });
      const sale = await connection.collection('service_sales').insertOne({ transaction_id: transaction.insertedId,
        member_id: member, status: 'PENDING', price_snapshot: currentPlan!.price }, { session });
      return { status: 201, body: { transactionId: transaction.insertedId.toHexString(), saleId: sale.insertedId.toHexString() },
        resultIds: { transactionId: transaction.insertedId, saleId: sale.insertedId } };
    });
  }

  it('TC05: concurrent same intent across connections commits one result, replay preserves body', async () => {
    const key = randomUUID();
    const results = await Promise.all([register(0, key), register(1, key.toUpperCase())]);
    expect(results[0]).toEqual(results[1]);
    expect(await connections[0].collection('service_sales').countDocuments()).toBe(1);
    expect(await connections[0].collection('operation_requests').countDocuments()).toBe(1);
    expect(await register(1, key)).toEqual(results[0]);
  });

  it('TC09: different keys serialize on the member revision; only one pending sale', async () => {
    const results = await Promise.allSettled([register(0, randomUUID()), register(1, randomUUID())]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(failure.reason).toMatchObject({ code: 'PENDING_SALE_EXISTS' });
    expect(await connections[0].collection('transactions').countDocuments()).toBe(1);
    const raw = await connections[0].db!.collection('members').findOne({ _id: member }, { promoteLongs: false });
    expect(raw!.service_revision).toBeInstanceOf(Long);
    expect(raw!.service_revision.toString()).toBe('1'); // aborted increments are rolled back
  });

  it('TC10: stop-selling and sale share the plan write, with no business version bump for locking', async () => {
    const results = await Promise.allSettled([register(0, randomUUID()), runners[1].run(async session => {
      await guards[1].acquire(session, { plans: [plan] });
      await connections[1].collection('plans').updateOne({ _id: plan }, { $set: { status: 'INACTIVE' }, $inc: { version: 1 } }, { session });
    })]);
    expect(results[1].status).toBe('fulfilled');
    expect((await connections[0].collection('plans').findOne({ _id: plan }))!.version).toBe(1);
    const sales = await connections[0].collection('service_sales').find().toArray();
    expect(sales.length).toBe(results[0].status === 'fulfilled' ? 1 : 0);
    if (sales.length) expect(sales[0].price_snapshot.toString()).toBe('150000');
  });

  it('TC11: confirm/cancel and two confirms cannot both win the same transaction', async () => {
    for (const actions of [['SETTLED', 'CANCELLED'], ['SETTLED', 'SETTLED']]) {
      const transaction = await connections[0].collection('transactions').insertOne({ request_key: transactionRequestKey(actorId, 'SALE_REGISTER', randomUUID()), status: 'PENDING', version: 0, guard_revision: Long.ZERO });
      const results = await Promise.allSettled(actions.map((status, index) => runners[index].run(async session => {
        await guards[index].acquire(session, { members: [member], transactions: [transaction.insertedId] });
        const record = await connections[index].collection('transactions').findOne({ _id: transaction.insertedId }, { session });
        if (record!.status !== 'PENDING') throw new ApplicationError(409, 'STATE_CONFLICT', 'State conflict');
        if (status === 'SETTLED') {
          await connections[index].collection('payments').insertOne({ transaction_id: transaction.insertedId, reference: randomUUID(), status: 'SUCCEEDED', amount: toVndDecimal('150000') }, { session });
        }
        await connections[index].collection('transactions').updateOne({ _id: transaction.insertedId }, { $set: { status }, $inc: { version: 1 } }, { session });
      })));
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(await connections[0].collection('payments').countDocuments({ transaction_id: transaction.insertedId })).toBeLessThanOrEqual(1);
      expect((await connections[0].collection('transactions').findOne({ _id: transaction.insertedId }))!.version).toBe(1);
    }
  });

  it('TC12: same reference on different transactions rolls back the losing invoice and payment', async () => {
    const results = await Promise.allSettled([0, 1].map(index => runners[index].run(async session => {
      const id = new ObjectId();
      await connections[index].collection('invoices').insertOne({ transaction_id: id, invoice_no: randomUUID() }, { session });
      await connections[index].collection('payments').insertOne({ transaction_id: id, reference: 'SHARED-REFERENCE', status: 'SUCCEEDED' }, { session });
    })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(await connections[0].collection('invoices').countDocuments()).toBe(1);
    expect(await connections[0].collection('payments').countDocuments()).toBe(1);
  });

  it('TC02: every required index is installed, succeeded partial index preserves payment history', async () => {
    for (const { collection, index } of FINANCIAL_INDEXES) expect(await hasFinancialIndex(connections[0], collection, index)).toBe(true);
    const transaction = new ObjectId();
    for (const status of ['PENDING', 'FAILED', 'SUCCEEDED']) {
      await connections[0].collection('payments').insertOne({ transaction_id: transaction, reference: randomUUID(), status });
    }
    await expect(connections[0].collection('payments').insertOne({ transaction_id: transaction, reference: randomUUID(), status: 'SUCCEEDED' })).rejects.toMatchObject({ code: 11000 });
  });

  it.each(FINANCIAL_INDEXES)('TC09–12: $collection / $index.name rejects an actual duplicate write', async ({ collection, index }) => {
    const data = Object.fromEntries(Object.keys(index.key).map(field => [field, field.endsWith('_id') ? new ObjectId() : 'same-key']));
    Object.assign(data, index.partialFilterExpression ?? {});
    await connections[0].collection(collection).insertOne({ ...data });
    await expect(connections[1].collection(collection).insertOne({ ...data })).rejects.toMatchObject({ code: 11000 });
  });

  it('migration backfills only missing revisions as Int64, rerun preserves existing revision/data', async () => {
    const old = await connections[0].collection('members').insertOne({ full_name: 'Existing member' });
    await ensureFinancialIntegrity(connections[0]);
    await runners[0].run(session => guards[0].acquire(session, { members: [old.insertedId] }));
    await ensureFinancialIntegrity(connections[0]);
    const saved = await connections[0].db!.collection('members').findOne({ _id: old.insertedId }, { promoteLongs: false });
    expect(saved!.service_revision.toString()).toBe('1');
    expect(saved!.full_name).toBe('Existing member');
  });

  it('migration detects duplicates before creating indexes or backfilling', async () => {
    await connections[0].collection('payments').dropIndex('payments_reference_unique');
    await connections[0].collection('payments').insertMany([{ reference: 'DUP' }, { reference: 'DUP' }]);
    const old = await connections[0].collection('members').insertOne({ full_name: 'Keep' });
    await expect(ensureFinancialIntegrity(connections[0])).rejects.toThrow('EN02_DUPLICATE_DATA');
    expect((await connections[0].collection('members').findOne({ _id: old.insertedId }))!.service_revision).toBeUndefined();
    await connections[0].collection('payments').deleteMany({});
    await ensureFinancialIntegrity(connections[0]);
  });

  it('migration canonicalizes legacy UUID case without changing response/hash, refuses logical duplicates', async () => {
    const key = randomUUID();
    const original = await register(0, key);
    const requests = connections[0].collection('operation_requests');
    await requests.updateOne({}, { $set: { client_key: key.toUpperCase() } });
    const old = await requests.findOne({});
    await ensureFinancialIntegrity(connections[0]);
    expect(await register(1, key)).toEqual(original);
    const normalized = await requests.findOne({});
    expect(normalized!.client_key).toBe(key);
    expect(normalized!.request_hash).toBe(old!.request_hash);
    expect(normalized!.response_body).toEqual(old!.response_body);
    const { _id, ...copy } = normalized!;
    await requests.insertOne({ ...copy, client_key: key.toUpperCase() });
    await expect(ensureFinancialIntegrity(connections[0])).rejects.toThrow('EN02_DUPLICATE_DATA: operation_requests');
  });

  it('TC16: sensitive or non-JSON response causes business writes and operation record to roll back', async () => {
    for (const body of [{ password: 'do-not-persist' }, { nested: { accessToken: 'do-not-persist' } }, { amount: NaN }]) {
      await expect(commands[0].execute({ actorId, operation: 'MEMBER_CREATE', clientKey: randomUUID(), payload: {} }, async session => {
        await connections[0].collection('members').insertOne({ service_revision: Long.ZERO }, { session });
        return { status: 201, body, resultIds: {} };
      })).rejects.toThrow('OPERATION_RESULT_');
    }
    expect(await connections[0].collection('members').countDocuments()).toBe(1); // the beforeEach fixture only
    expect(await connections[0].collection('operation_requests').countDocuments()).toBe(0);
  });

  it('guards fail outside transaction and reuse the real account-administration document', async () => {
    const session = await connections[0].startSession();
    try { await expect(guards[0].acquire(session, { members: [member] })).rejects.toThrow('DATA_GUARD_TRANSACTION_REQUIRED'); }
    finally { await session.endSession(); }
    await connections[0].db!.collection<{ _id: string; revision: Long }>('security_state').insertOne({ _id: 'account-administration', revision: Long.ZERO });
    await runners[0].run(session => guards[0].acquire(session, { accountAdministration: true, plans: [plan], members: [member] }));
    const state = await connections[0].db!.collection<{ _id: string; revision: number }>('security_state').findOne({ _id: 'account-administration' });
    expect(state!.revision).toBe(1);
  });

  it('opposite input orders still acquire member locks in the same sorted order across connections', async () => {
    const second = new ObjectId();
    await connections[0].collection('members').insertOne({ _id: second, service_revision: Long.ZERO });
    await Promise.all([runners[0].run(session => guards[0].acquire(session, { members: [member, second] })),
      runners[1].run(session => guards[1].acquire(session, { members: [second, member] }))]);
    for (const id of [member, second]) {
      expect((await connections[0].collection('members').findOne({ _id: id }))!.service_revision).toBe(2);
    }
  });

  it('invalid or exhausted revisions fail closed and roll back earlier plan lock writes', async () => {
    for (const revision of [0, Long.MAX_VALUE]) {
      await connections[0].collection('members').updateOne({ _id: member }, { $set: { service_revision: revision } });
      await expect(runners[0].run(session => guards[0].acquire(session, { plans: [plan], members: [member] })))
        .rejects.toMatchObject({ code: 'DATA_GUARD_NOT_READY' });
      expect((await connections[0].collection('plans').findOne({ _id: plan }))!.guard_revision).toBe(0);
    }
  });
});
