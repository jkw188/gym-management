const { randomBytes } = require('node:crypto');
const { MongoClient } = require('mongodb');

function validateTestEnvironment(env) {
  if (env.NODE_ENV !== 'test') throw new Error('TEST_NODE_ENV_REQUIRED');
  if (!env.MONGODB_TEST_URI) throw new Error('MONGODB_TEST_URI_REQUIRED');
  let client;
  try { client = new MongoClient(env.MONGODB_TEST_URI); }
  catch { throw new Error('INVALID_MONGODB_TEST_URI'); }
  const base = client.options.dbName;
  if (!/^gym_test_[a-z0-9_]+$/.test(base) || base.length > 24) throw new Error('TEST_DATABASE_PREFIX_REQUIRED');
  if (base === env.MONGODB_DB) throw new Error('TEST_DATABASE_MATCHES_DEVELOPMENT');
  if (env.MONGODB_URI) {
    let development;
    try { development = new MongoClient(env.MONGODB_URI).options.dbName; }
    catch { throw new Error('INVALID_DEVELOPMENT_URI'); }
    if (base === development) throw new Error('TEST_DATABASE_MATCHES_DEVELOPMENT');
  }
  return base;
}

function testDatabaseName(base, runId, worker, suite) {
  if (!/^gym_test_[a-z0-9_]+$/.test(base) || base.length > 24 || !/^[a-f0-9]{12}$/.test(runId) ||
      !/^\d{1,3}$/.test(worker) || !/^[a-z0-9_]{1,12}$/.test(suite)) throw new Error('INVALID_TEST_DATABASE_ID');
  return `${base}_${runId}_${worker}_${suite}`;
}

// No caller can supply an arbitrary cleanup DB: each lease has an exact name and an ownership marker.
async function createTestDatabase(env, suite) {
  const base = validateTestEnvironment(env);
  const name = testDatabaseName(base, env.EN04_RUN_ID, env.JEST_WORKER_ID || '1', suite);
  const owner = randomBytes(24).toString('hex');
  const client = new MongoClient(env.MONGODB_TEST_URI, { serverSelectionTimeoutMS: 10000, socketTimeoutMS: 10000,
    runtimeAdapters: { os: require('node:os') } });
  try {
    await client.connect();
    const hello = await client.db('admin').command({ hello: 1 });
    if (!hello.setName || !hello.logicalSessionTimeoutMinutes) throw new Error('TEST_REPLICA_SET_REQUIRED');
    const db = client.db(name);
    // Refuse an existing database, including an incomplete run with a reused ID.
    if ((await db.listCollections({}, { nameOnly: true }).toArray()).length) throw new Error('TEST_DATABASE_ALREADY_EXISTS');
    await db.createCollection('__en04_owner');
    await db.collection('__en04_owner').insertOne({ _id: 'owner', owner });
    async function assertOwned() {
      validateTestEnvironment(env);
      if (process.env.NODE_ENV !== 'test' || testDatabaseName(base, env.EN04_RUN_ID, env.JEST_WORKER_ID || '1', suite) !== name ||
          (await db.collection('__en04_owner').findOne({ _id: 'owner' }))?.owner !== owner) throw new Error('TEST_DATABASE_NOT_OWNED');
    }
    return {
      name,
      async reset() {
        await assertOwned();
        for (const { name: collection } of await db.listCollections({}, { nameOnly: true }).toArray()) {
          if (collection !== '__en04_owner') await db.collection(collection).deleteMany({});
        }
      },
      async close() {
        try { await assertOwned(); await db.dropDatabase(); }
        finally { await client.close(); }
      },
    };
  } catch (error) { await client.close(); throw error; }
}

module.exports = { validateTestEnvironment, testDatabaseName, createTestDatabase };
