// Tầng kiểm thử backend (Jest + MongoDB thật trong bộ nhớ): EN-02 bước 2 (kiểm tra môi trường giao dịch).
// Chỉ kiểm tra TC02 phần "thiếu index": thiếu unique index của operation_requests thì kiểm tra môi trường phải fail.
import 'reflect-metadata';
import { MongoMemoryReplSet, MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { Connection } from 'mongoose';
import * as os from 'node:os';
// Hợp đồng test đặt ra cho Builder: class EnvironmentCheck có constructor(connection) và assertReady().
import { EnvironmentCheck } from '../src/infrastructure/environment/environment-check';
import { ensureFinancialIntegrity } from '../src/infrastructure/transaction/financial-integrity';

const mongoBinary = { version: '8.0.17' };
const requiredKeys = { actor_id: 1, operation: 1, client_key: 1 };

describe('EN-02 bước 2: kiểm tra môi trường trên replica set', () => {
  let mongo: MongoMemoryReplSet;
  let connection: Connection;
  let check: EnvironmentCheck;

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ binary: mongoBinary, replSet: { count: 1, storageEngine: 'wiredTiger', dbName: 'gym_management_test_en02_env' } });
    connection = await mongoose.createConnection(mongo.getUri(), { dbName: 'gym_management_test_en02_env', runtimeAdapters: { os } }).asPromise();
    check = new EnvironmentCheck(connection);
  }, 600000);

  afterAll(async () => {
    await connection?.close();
    await mongo?.stop();
  });

  beforeEach(async () => {
    await connection.collection('operation_requests').drop().catch(() => undefined);
  });

  // Đối chứng: đủ replica set và đủ unique index thì phải qua, nếu không các test "fail" bên dưới không có ý nghĩa.
  it('EN-02-TC01/02: đủ mọi index, ghi và rollback probe không để lại record', async () => {
    await ensureFinancialIntegrity(connection);

    await expect(check.assertReady()).resolves.toBeUndefined();
    expect(await connection.collection('operation_requests').countDocuments()).toBe(0);
  });

  it('EN-02-TC02: thiếu index tài chính khác vẫn fail dù có operation_requests', async () => {
    await ensureFinancialIntegrity(connection);
    await connection.collection('payments').dropIndex('payments_succeeded_transaction_unique');
    await expect(check.assertReady()).rejects.toThrow('payments_succeeded_transaction_unique');
    expect(await connection.collection('operation_requests').countDocuments()).toBe(0);
  });

  it('EN-02-D01: operation_requests có TTL bị từ chối, không tự xóa index để chữa', async () => {
    await ensureFinancialIntegrity(connection);
    await connection.collection('operation_requests').createIndex({ committed_at: 1 }, { expireAfterSeconds: 3600 });
    await expect(check.assertReady()).rejects.toThrow('operation_requests');
    await expect(ensureFinancialIntegrity(connection)).rejects.toThrow('EN02_INDEX_CONFLICT');
    expect((await connection.collection('operation_requests').indexes()).some(index => index.expireAfterSeconds === 3600)).toBe(true);
  });

  it('EN-02-TC02: thiếu hẳn collection operation_requests (chưa tạo index) thì fail', async () => {
    await expect(check.assertReady()).rejects.toThrow();
  });

  it('EN-02-TC02: collection có nhưng thiếu unique index (actor_id, operation, client_key) thì fail', async () => {
    await connection.collection('operation_requests').insertOne({ note: 'tạo collection nhưng chưa có index' });

    await expect(check.assertReady()).rejects.toThrow();
  });

  it('EN-02-TC02: có index đúng ba trường nhưng không unique thì fail', async () => {
    await connection.collection('operation_requests').createIndex(requiredKeys);

    await expect(check.assertReady()).rejects.toThrow();
  });

  it('EN-02-TC02: có unique index nhưng thiếu trường client_key thì fail', async () => {
    await connection.collection('operation_requests').createIndex({ actor_id: 1, operation: 1 }, { unique: true });

    await expect(check.assertReady()).rejects.toThrow();
  });

  // Fail là dừng hẳn: kiểm tra môi trường không được tự tạo index hay ghi dữ liệu để "chữa" lỗi.
  it('EN-02-TC02: khi fail không tự tạo index và không ghi dữ liệu nào', async () => {
    await connection.collection('operation_requests').insertOne({ note: 'giữ nguyên' });

    await check.assertReady().catch(() => undefined);

    const indexes = await connection.collection('operation_requests').indexes();
    expect(indexes.map((index) => index.name)).toEqual(['_id_']);
    expect(await connection.collection('operation_requests').countDocuments()).toBe(1);
  });
});

describe('EN-02 bước 2: kiểm tra môi trường trên MongoDB standalone', () => {
  let standalone: MongoMemoryServer;
  let connection: Connection;
  let check: EnvironmentCheck;

  beforeAll(async () => {
    standalone = await MongoMemoryServer.create({ binary: mongoBinary });
    connection = await mongoose.createConnection(standalone.getUri(), { dbName: 'gym_management_test_en02_env_standalone', runtimeAdapters: { os } }).asPromise();
    check = new EnvironmentCheck(connection);
  }, 600000);

  afterAll(async () => {
    await connection?.close();
    await standalone?.stop();
  });

  // Dù đã có đủ index, standalone vẫn không đủ điều kiện (không có transaction).
  it('EN-02-TC02: standalone dù đủ unique index vẫn fail', async () => {
    await connection.collection('operation_requests').createIndex(requiredKeys, { unique: true });

    await expect(check.assertReady()).rejects.toThrow();
  });
});
