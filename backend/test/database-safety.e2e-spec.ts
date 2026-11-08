import { MongoClient } from 'mongodb';
import * as os from 'node:os';
import { createTestDatabase } from '../scripts/test-database.cjs';

describe('EN-04 TC05/06: real database ownership and independent runs', () => {
  it('two leases keep fixtures isolated; cleanup cannot delete another run or a DB without its marker', async () => {
    const env = { ...process.env };
    const [left, right] = await Promise.all([createTestDatabase(env, 'left'), createTestDatabase(env, 'right')]);
    const client = new MongoClient(env.MONGODB_TEST_URI!, { runtimeAdapters: { os }, serverSelectionTimeoutMS: 10000 });
    try {
      await client.connect();
      await client.db(left.name).collection('probe').insertOne({ value: 'left' });
      await client.db(right.name).collection('probe').insertOne({ value: 'right' });
      expect(left.name).not.toBe(right.name);
      await left.reset();
      expect(await client.db(left.name).collection('probe').countDocuments()).toBe(0);
      expect(await client.db(right.name).collection('probe').countDocuments()).toBe(1);
      const marker = await client.db(right.name).collection('__en04_owner').findOne({});
      await client.db(right.name).collection('__en04_owner').updateOne({}, { $set: { owner: 'foreign-run' } });
      await expect(right.reset()).rejects.toThrow('TEST_DATABASE_NOT_OWNED');
      expect(await client.db(right.name).collection('probe').countDocuments()).toBe(1);
      await client.db(right.name).collection('__en04_owner').updateOne({}, { $set: { owner: marker!.owner } });
      const savedNodeEnv = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = 'development';
        await expect(left.reset()).rejects.toThrow('TEST_DATABASE_NOT_OWNED');
      } finally { process.env.NODE_ENV = savedNodeEnv; }
      await expect(createTestDatabase(env, 'right')).rejects.toThrow('TEST_DATABASE_ALREADY_EXISTS');
    } finally {
      const cleanup = await Promise.allSettled([left.close(), right.close()]);
      await client.close();
      const failure = cleanup.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    }
  });
});
