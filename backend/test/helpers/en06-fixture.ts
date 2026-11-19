import { ChildProcess, fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { Db, Document, MongoClient, ObjectId } from 'mongodb';
import { createTestDatabase, TestDatabase } from '../../scripts/test-database.cjs';
import { COLLECTIONS, inspectCommitted } from './en06-oracle';

export const NOW = '2035-11-14T17:00:00.000Z'; // 00:00 in Vietnam, previous UTC date.
export interface Actor { id: string; phone: string; role: string; tokens: string[] }
export interface Outcome { status: number; body: Record<string, unknown> }
export interface Call { app: number; actor?: Actor; path: string; body?: object; method?: string; key?: string; operation?: string }
interface Reply { id?: number; result?: unknown; error?: string; event?: string; url?: string; point?: string }
export class En06Process {
  child!: ChildProcess;
  url = '';
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private hits = new Set<string>();
  async start() {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.child.kill(); reject(new Error('EN06_CHILD_START_TIMEOUT')); }, 60000);
      this.child = fork(path.resolve('scripts/en06-app.cjs'), [], { env: { ...process.env, EN06_CHILD: '1' }, silent: true, windowsHide: true });
      this.child.stdout?.resume(); this.child.stderr?.resume(); // Never log raw driver errors.
      this.child.on('message', (message: Reply) => {
        if (message.event === 'ready') { clearTimeout(timer); this.url = message.url!; resolve(); }
        if (message.event === 'failed') { clearTimeout(timer); reject(new Error('EN06_CHILD_SETUP_FAILED')); }
        if (message.event === 'hit') this.hits.add(message.point!);
        if (message.id !== undefined) {
          const entry = this.pending.get(message.id); this.pending.delete(message.id);
          if (message.error) entry?.reject(new Error(message.error)); else entry?.resolve(message.result);
        }
      });
      this.child.on('error', () => { clearTimeout(timer); reject(new Error('EN06_CHILD_START_FAILED')); });
      this.child.on('exit', () => {
        clearTimeout(timer); reject(new Error('EN06_CHILD_EXITED'));
        for (const entry of this.pending.values()) entry.reject(new Error('EN06_CHILD_EXITED'));
        this.pending.clear();
      });
    });
  }
  rpc(command: string, value?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('EN06_RPC_TIMEOUT')); }, 30000);
      this.pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
      this.child.send({ id, command, value });
    });
  }
  async arm(point: string, mode = 'pause') { this.hits.delete(point); await this.rpc('arm', { point, mode }); }
  async hit(point: string) {
    const deadline = Date.now() + 15000;
    while (!this.hits.has(point)) {
      if (Date.now() > deadline) throw new Error(`EN06_HOOK_NOT_REACHED_${point}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  async close() {
    if (!this.child || this.child.exitCode !== null || !this.child.connected) return;
    const exited = new Promise<void>(resolve => this.child.once('exit', () => resolve()));
    try { await this.rpc('close'); } finally { this.child.kill(); await exited; }
  }
}
type Snapshot = Awaited<ReturnType<typeof inspectCommitted>>;
interface RequestEvidence {
  app: number; pid: number; path: string; method: string; key?: string; payloadHash: string; statuses: number[];
  lookups: number[]; outcome?: number; resolved: boolean; errorCode?: string; responseHash?: string;
}
export interface RoundEvidence { round: number; testRunId: string; startedAt: string; durationMs: number; before?: Snapshot; after?: Snapshot;
  checkpoints: { label: string; snapshot: Snapshot }[]; requests: RequestEvidence[];
  batches: { size: number; pids: number[]; hook?: string }[]; assertion: string; failureCode?: string }
export interface CaseEvidence { id: string; status: string; reason: string; owner: string; rounds: RoundEvidence[] }
export class En06Fixture {
  apps: En06Process[] = [];
  db!: Db;
  client!: MongoClient;
  private lease?: TestDatabase;
  private saved = { ...process.env };
  private owner = '';
  private current?: RoundEvidence;
  private sequence = 0;
  readonly cases: CaseEvidence[] = [];
  admin!: Actor; staff!: Actor; members!: Actor[];
  // US-41 nhóm A (TC01): 20 Member khác nhau; Member thứ i chỉ đăng nhập app i % 2 (giới hạn 20 lần đăng nhập/IP mỗi app).
  crowd!: Actor[];
  async start() {
    this.lease = await createTestDatabase({ ...process.env }, 'en06');
    Object.assign(process.env, { MONGODB_URI: process.env.MONGODB_TEST_URI, MONGODB_DB: this.lease.name, EN06_NOW: NOW });
    this.client = new MongoClient(process.env.MONGODB_TEST_URI!, { serverSelectionTimeoutMS: 10000, runtimeAdapters: { os: require('node:os') } });
    await this.client.connect(); this.db = this.client.db(this.lease.name);
    this.owner = String((await this.db.collection('__en04_owner').findOne({ _id: 'owner' as unknown as ObjectId }))!.owner);
    for (let i = 0; i < 2; i++) { const app = new En06Process(); this.apps.push(app); await app.start(); }
    if (new Set(this.apps.map(app => app.child.pid)).size !== 2 || this.apps.some(app => app.child.pid === process.pid)) throw new Error('EN06_TWO_PROCESSES_REQUIRED');
    const password = 'EN06 integration fixture 123';
    const actors = (await this.apps[0].rpc('accounts', { password }) as Omit<Actor, 'tokens'>[]).map(actor => ({ ...actor, tokens: [] as string[] }));
    for (const actor of actors) for (const app of this.apps) {
      const response = await fetch(`${app.url}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
        body: JSON.stringify({ phone: actor.phone, password }) });
      if (response.status !== 200) throw new Error('EN06_REAL_LOGIN_FAILED');
      actor.tokens.push((await response.json() as { accessToken: string }).accessToken);
    }
    [this.admin, this.staff] = actors; this.members = actors.slice(2);
    this.crowd = (await this.apps[0].rpc('memberAccounts', { password, count: 20 }) as Omit<Actor, 'tokens'>[]).map(actor => ({ ...actor, tokens: ['', ''] }));
    for (const [index, actor] of this.crowd.entries()) {
      const app = this.apps[index % 2];
      const response = await fetch(`${app.url}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
        body: JSON.stringify({ phone: actor.phone, password }) });
      if (response.status !== 200) throw new Error('EN06_REAL_LOGIN_FAILED');
      actor.tokens[index % 2] = (await response.json() as { accessToken: string }).accessToken;
    }
    const indexes = [];
    for (const name of COLLECTIONS) {
      const exists = (await this.db.listCollections({ name }, { nameOnly: true }).toArray()).length > 0;
      indexes.push({ collection: name, indexes: exists ? await this.db.collection(name).listIndexes().toArray() : [], exists });
    }
    // Missing S06 collections stay visible. Never create substitute order/refund indexes to pass.
    writeFileSync(path.join(process.env.EN06_REPORT_DIR!, 'processes-indexes.json'), JSON.stringify({ database: this.db.databaseName,
      pids: this.apps.map(app => app.child.pid), parentPid: process.pid, expiryWorkers: [], indexes }, null, 2));
  }
  key() { return randomUUID(); }
  async reset() {
    if (this.db.databaseName !== this.lease!.name ||
        String((await this.db.collection('__en04_owner').findOne({ _id: 'owner' as unknown as ObjectId }))?.owner) !== this.owner) throw new Error('TEST_DATABASE_NOT_OWNED');
    await Promise.all(this.apps.map(app => app.rpc('clear'))); await this.clock(NOW);
    for (const name of [...COLLECTIONS, 'categories', 'members', 'member_events', 'member_link_events', 'plans', 'plan_conversion_policies', 'notification_counters', 'carts']) { // carts: dòng giỏ US-40 (COLLECTIONS còn tên cũ cart_items)
      await this.db.collection(name).deleteMany({});
    }
    this.sequence = 0;
  }
  async clock(value: string) { await Promise.all(this.apps.map(app => app.rpc('clock', value))); }
  async send(call: Call): Promise<Outcome> {
    const evidence: RequestEvidence = { app: call.app, pid: this.apps[call.app].child.pid!, path: call.path, method: call.method ?? 'POST', key: call.key,
      payloadHash: createHash('sha256').update(JSON.stringify(call.body ?? {})).digest('hex'), statuses: [], lookups: [], resolved: false };
    this.current?.requests.push(evidence);
    const perform = async (): Promise<Outcome> => {
      const response = await fetch(`${this.apps[call.app].url}/api${call.path}`, { method: call.method ?? 'POST', signal: AbortSignal.timeout(20000),
        headers: { Origin: 'http://localhost:5173', 'Content-Type': 'application/json', ...(call.actor ? { Authorization: `Bearer ${call.actor.tokens[call.app]}` } : {}),
          ...(call.key ? { 'Idempotency-Key': call.key } : {}) }, ...(call.body ? { body: JSON.stringify(call.body) } : {}) });
      evidence.statuses.push(response.status);
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    let response: Outcome | undefined;
    try { response = await perform(); } catch { if (!call.key || !call.operation) throw new Error('EN06_TRANSPORT_UNRESOLVED'); }
    const unknown = () => !response || response.status === 503 && (response.body.error as { code?: string } | undefined)?.code === 'OPERATION_OUTCOME_UNKNOWN';
    for (let attempt = 0; attempt < 3 && unknown(); attempt++) {
      if (!call.key || !call.operation || !call.actor) break;
      try {
        const other = 1 - call.app;
        const lookup = await fetch(`${this.apps[other].url}/api/operations/${call.operation}/${call.key}`, {
          signal: AbortSignal.timeout(20000), headers: { Authorization: `Bearer ${call.actor.tokens[other]}` } });
        evidence.lookups.push(lookup.status);
        if (lookup.status === 200) {
          const found = await lookup.json() as { responseStatus: number; responseBody: Record<string, unknown> };
          response = { status: found.responseStatus, body: found.responseBody };
        } else if (lookup.status === 404) response = await perform();
        else if (lookup.status !== 503) throw new Error('EN06_LOOKUP_DENIED');
      } catch (error) { if (error instanceof Error && error.message === 'EN06_LOOKUP_DENIED') throw error; }
    }
    if (unknown() || !response) throw new Error('EN06_OUTCOME_UNRESOLVED');
    evidence.resolved = true; evidence.outcome = response.status;
    evidence.errorCode = (response.body.error as { code?: string } | undefined)?.code;
    evidence.responseHash = createHash('sha256').update(JSON.stringify(response.body)).digest('hex');
    return response;
  }
  async batch(calls: Call[], hook?: string) {
    if (calls.length > 20) throw new Error('EN06_BATCH_LIMIT');
    this.current?.batches.push({ size: calls.length, pids: [...new Set(calls.map(call => this.apps[call.app].child.pid!))], hook });
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const pending = calls.map(async call => { await barrier; return this.send(call); }); release();
    const settled = await Promise.allSettled(pending);
    const failed = settled.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    return settled.map(result => (result as PromiseFulfilledResult<Outcome>).value);
  }
  async race(calls: Call[], round: number, point = 'guard') {
    if (!calls.some(call => call.app === 0) || !calls.some(call => call.app === 1)) throw new Error('EN06_BOTH_APPS_REQUIRED');
    await Promise.all(this.apps.map(app => app.arm(point)));
    const pending = this.batch(round % 2 ? [...calls].reverse() : calls, point); void pending.catch(() => undefined);
    try { await Promise.all(this.apps.map(app => app.hit(point))); }
    finally { await Promise.all(this.apps.map(app => app.rpc('release'))); }
    const outcomes = await pending; return round % 2 ? outcomes.reverse() : outcomes;
  }
  async checkpoint(label: string) {
    const snapshot = await inspectCommitted(this.db, this.client);
    this.current?.checkpoints.push({ label, snapshot }); return snapshot;
  }
  // US-41 nhóm A: ca đã có writer thật cho cả phần WEBSITE → kết quả PASSED (vẫn 10 vòng, hai tiến trình, kiểm bất biến trước/sau).
  async passed(id: string, owner: string, reason: string, work: (round: number) => Promise<void>) {
    return this.partial(id, owner, reason, work, 'PASSED');
  }
  async partial(id: string, owner: string, reason: string, work: (round: number) => Promise<void>, finalStatus: 'PARTIAL' | 'PASSED' = 'PARTIAL') {
    const tc: CaseEvidence = { id, status: 'RUNNING', owner, reason, rounds: [] }; this.cases.push(tc);
    try {
      for (let round = 0; round < 10; round++) {
        await this.reset();
        const started = Date.now();
        this.current = { round, testRunId: `${process.env.EN04_RUN_ID}_${id}_${round}`, startedAt: new Date().toISOString(), durationMs: 0,
          requests: [], checkpoints: [], batches: [], assertion: 'RUNNING' }; tc.rounds.push(this.current);
        try {
          this.current.before = await inspectCommitted(this.db, this.client);
          await work(round);
          this.current.after = await inspectCommitted(this.db, this.client);
          await this.apps[0].rpc('validate');
          this.current.assertion = 'PASSED';
        } catch (error) {
          this.current.assertion = 'FAILED';
          this.current.failureCode = error instanceof Error && /^(EN06_|TEST_)/.test(error.message) ? error.message : 'EN06_ASSERTION_FAILED_SEE_JEST';
          throw error;
        } finally { this.current.durationMs = Date.now() - started; this.flush(); }
      }
      tc.status = finalStatus; // PARTIAL: foundation only, never retail acceptance. PASSED: WEBSITE writer covered too.
    } catch (error) { tc.status = 'FAILED'; throw error; }
    finally { this.current = undefined; this.flush(); }
  }
  blocked(id: string, owner: string, reason: string) { this.cases.push({ id, status: 'BLOCKED', owner, reason, rounds: [] }); this.flush(); }
  private flush() { writeFileSync(path.join(process.env.EN06_REPORT_DIR!, 'cases.json'), JSON.stringify({ cases: this.cases }, null, 2)); }
  async close() {
    const closed = await Promise.allSettled(this.apps.map(app => app.close()));
    try { await this.client?.close(); await this.lease?.close(); }
    finally { process.env = this.saved; }
    if (closed.some(result => result.status === 'rejected')) throw new Error('EN06_CLEANUP_FAILED');
  }
  get(url: string, actor = this.staff, app = 0) { return this.send({ app, actor, path: url, method: 'GET' }); }
  async create(url: string, body: object, actor = this.staff, operation?: string) {
    const response = await this.send({ app: 0, actor, path: url, body, key: this.key(), operation });
    expect(response.status).toBe(201); return response.body;
  }
  async catalog() {
    const category = await this.create('/admin/categories', { name: 'EN06 fixture active', status: 'ACTIVE' }, this.admin, 'CATEGORY_CREATE');
    const productIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const row = await this.create('/admin/products', { categoryId: category.id, sku: `EN06_${i}`, name: `EN06 SKU ${i}`, price: '9000', status: 'ACTIVE' }, this.admin, 'PRODUCT_CREATE');
      productIds.push(String(row.id));
    }
    return productIds;
  }
  async receipt(productIds: string[], quantity = 1) {
    return this.create('/stock-receipts', { reason: `EN06 FIXTURE ${process.env.EN04_RUN_ID} test goods`, sourceReference: `FIXTURE:${process.env.EN04_RUN_ID}`,
      items: productIds.map(productId => ({ productId, quantity, unitCost: '1000' })) }, this.staff, 'STOCK_RECEIPT_CREATE');
  }
  postReceipt(id: string, app = 0, key = this.key()): Call {
    return { app, actor: this.staff, path: `/stock-receipts/${id}/post`, body: { version: 0 }, key, operation: 'STOCK_RECEIPT_POST' };
  }
  async sale(kind: 'GYM' | 'PT' = 'GYM', price = '300000', member = 0) {
    const index = ++this.sequence;
    const profile = await this.create('/members', { fullName: `EN06 fixture member ${index}`, phone: this.members[member].phone }, this.staff, 'MEMBER_CREATE');
    const link = await this.send({ app: 0, actor: this.staff, path: `/members/${profile.id}/link`, key: this.key(), operation: 'MEMBER_LINK',
      body: { accountId: this.members[member].id, version: 0, verificationMethod: 'IN_PERSON_ACCOUNT', verificationNote: 'EN06 FIXTURE test identity checked' } });
    expect(link.status).toBe(200);
    const plan = await this.create('/admin/plans', { code: `EN06_${index}`, name: `EN06 ${kind} snapshot`, kind, durationDays: 30,
      sessionsQuota: kind === 'PT' ? 10 : 0, price, benefits: 'EN06 original benefits' }, this.admin);
    const sale = await this.create('/service-sales', { memberId: profile.id, planId: plan.id, planVersion: 0, startDate: '2035-11-15' }, this.staff, 'SALE_REGISTER');
    return { ...sale, transactionId: String(sale.transactionId), memberId: String(profile.id), planId: String(plan.id) };
  }
  confirm(transactionId: string, app = 0, key = this.key(), transferReference?: string): Call {
    return { app, actor: this.staff, path: `/transactions/${transactionId}/confirm-payment`, operation: 'PAYMENT_CONFIRM', key,
      body: { method: transferReference ? 'TRANSFER' : 'CASH', amount: '300000', evidenceNote: `EN06 FIXTURE ${process.env.EN04_RUN_ID} simulated receipt; no real money`,
        ...(transferReference ? { receivingAccountCode: 'GYM_MAIN', bankReference: transferReference, receivedAt: NOW } : {}) } };
  }
  async rows(name: string, filter: Document = {}) { return this.db.collection(name).find(filter).sort({ _id: 1 }).toArray(); }

  // ---------- US-41 nhóm A: helper đơn WEBSITE qua HTTP thật ----------
  // App mà actor đã đăng nhập (crowd chỉ có token ở một app; admin/staff/members có ở cả hai).
  appOf(actor: Actor, preferred = 0) { return actor.tokens[preferred] ? preferred : 1 - preferred; }
  // Hồ sơ hội viên mới + liên kết với account MEMBER (US-09/US-17), do Staff thực hiện.
  async memberProfile(actor: Actor) {
    const index = ++this.sequence;
    const profile = await this.create('/members', { fullName: `EN06 website member ${index}`, phone: actor.phone }, this.staff, 'MEMBER_CREATE');
    const link = await this.send({ app: 0, actor: this.staff, path: `/members/${profile.id}/link`, key: this.key(), operation: 'MEMBER_LINK',
      body: { accountId: actor.id, version: 0, verificationMethod: 'IN_PERSON_ACCOUNT', verificationNote: 'EN06 FIXTURE test identity checked' } });
    expect(link.status).toBe(200);
    return String(profile.id);
  }
  // Danh mục + sản phẩm ACTIVE giá price, nhập POSTED stock đơn vị (US-34/US-37).
  async shop(price = '9000', stock = 1, count = 1) {
    const category = await this.create('/admin/categories', { name: 'EN06 website category', status: 'ACTIVE' }, this.admin, 'CATEGORY_CREATE');
    const productIds: string[] = [];
    for (let i = 0; i < count; i++) {
      const row = await this.create('/admin/products', { categoryId: category.id, sku: `EN06_WEB_${i}`, name: `EN06 website SKU ${i}`, price, status: 'ACTIVE' },
        this.admin, 'PRODUCT_CREATE');
      productIds.push(String(row.id));
    }
    const receipt = await this.receipt(productIds, stock);
    const posted = await this.send(this.postReceipt(String(receipt.id)));
    expect(posted.status).toBe(200);
    return { categoryId: String(category.id), productIds };
  }
  // Member thêm giỏ (US-40) rồi preview (US-41) trên app đã đăng nhập; trả body tạo đơn hợp lệ.
  async readyCart(actor: Actor, lines: Array<[string, number]>, recipientName = 'EN06 người nhận') {
    const app = this.appOf(actor);
    const cart = await this.send({ app, actor, path: '/me/cart', method: 'GET' });
    expect(cart.status).toBe(200);
    let version = cart.body.version as number;
    for (const [productId, quantity] of lines) {
      const added = await this.send({ app, actor, path: '/me/cart/items', key: this.key(), operation: 'CART_ADD_ITEM', body: { version, productId, quantity } });
      expect(added.status).toBe(201);
      version = added.body.version as number;
    }
    const preview = await this.send({ app, actor, path: '/me/orders/preview', body: { cartVersion: version } });
    expect(preview.status).toBe(200);
    return { app, version, total: String(preview.body.total),
      body: { cartVersion: version, quoteToken: String(preview.body.quoteToken), recipientName, recipientPhone: '0901234567', preferredPaymentMethod: 'CASH' } };
  }
  websiteCreate(actor: Actor, app: number, body: object, key = this.key()): Call {
    return { app, actor, path: '/me/orders', body, key, operation: 'ORDER_CREATE_WEBSITE' };
  }
  // Staff thu đủ CASH cho giao dịch RETAIL (US-22 mở RETAIL).
  retailConfirm(transactionId: string, amount: string, app = 0, key = this.key()): Call {
    return { app, actor: this.staff, path: `/transactions/${transactionId}/confirm-payment`, operation: 'PAYMENT_CONFIRM', key,
      body: { method: 'CASH', amount, evidenceNote: `EN06 FIXTURE ${process.env.EN04_RUN_ID} simulated receipt; no real money` } };
  }
}
