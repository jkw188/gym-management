import { ChildProcess, fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { Db, Decimal128, Long, MongoClient, ObjectId } from 'mongodb';
import { createTestDatabase, TestDatabase } from '../../scripts/test-database.cjs';
import { captureFailure, inspectCommitted } from './en05-oracle';

export const NOW = '2035-11-14T17:00:00.000Z'; // 00:00 VN, UTC is the previous date.
export const DAY = '2035-11-16';
export const at = (hour: string, day = DAY) => `${day}T${hour}:00+07:00`;
export const reason = 'EN05 kiểm thử thay đổi lịch';
export interface Actor { id: string; phone: string; role: string; tokens: string[] }
export interface Outcome { status: number; body: Record<string, unknown> }
export interface Call { app: number; actor?: Actor; path: string; body?: object; method?: string; key?: string; operation?: string }
interface Reply { id?: number; result?: unknown; error?: string; event?: string; pid?: number; url?: string; point?: string }

export class AppProcess {
  child!: ChildProcess;
  url = '';
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private hits = new Set<string>();
  private listeners = new Map<string, () => void>();
  async start() {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('EN05_CHILD_START_TIMEOUT')), 60000);
      this.child = fork(path.resolve('scripts/en05-app.cjs'), [], { env: { ...process.env, EN05_CHILD: '1' },
        silent: true, windowsHide: true });
      // Never forward raw app/driver output, which could contain credentials.
      this.child.stdout?.resume(); this.child.stderr?.resume();
      this.child.on('message', (message: Reply) => {
        if (message.event === 'ready') { clearTimeout(timer); this.url = message.url!; resolve(); }
        if (message.event === 'failed') { clearTimeout(timer); reject(new Error(message.error)); }
        if (message.event === 'hit') { this.hits.add(message.point!); this.listeners.get(message.point!)?.(); }
        if (message.id !== undefined) {
          const entry = this.pending.get(message.id); this.pending.delete(message.id);
          if (message.error) entry?.reject(new Error(message.error)); else entry?.resolve(message.result);
        }
      });
      this.child.on('error', () => { clearTimeout(timer); reject(new Error('EN05_CHILD_START_FAILED')); });
      this.child.on('exit', () => {
        clearTimeout(timer); reject(new Error('EN05_CHILD_EXITED'));
        for (const entry of this.pending.values()) entry.reject(new Error('EN05_CHILD_EXITED'));
        this.pending.clear();
      });
    });
  }
  rpc(command: string, value?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('EN05_RPC_TIMEOUT')); }, 30000);
      this.pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
      this.child.send({ id, command, value });
    });
  }
  async arm(point: string, mode = 'pause', nextNow?: string) {
    this.hits.delete(point); await this.rpc('arm', { point, mode, nextNow });
  }
  async hit(point: string) {
    if (this.hits.has(point)) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.listeners.delete(point); reject(new Error(`EN05_HOOK_NOT_REACHED_${point}`)); }, 15000);
      this.listeners.set(point, () => { clearTimeout(timer); this.listeners.delete(point); resolve(); });
    });
  }
  async close() {
    if (this.child?.exitCode !== null || !this.child?.connected) return;
    const exited = new Promise<void>(resolve => this.child.once('exit', () => resolve()));
    try { await this.rpc('close'); } finally { this.child.kill(); await exited; }
  }
}

type Snapshot = Awaited<ReturnType<typeof inspectCommitted>>;
interface RoundEvidence { round: number; testRunId: string; startedAt: string; durationMs: number; before?: Snapshot; after?: Snapshot;
  failureDb?: Awaited<ReturnType<typeof captureFailure>>;
  checkpoints?: { label: string; snapshot: Snapshot }[];
  requests: { app: number; pid: number; method: string; path: string; key?: string; statuses: number[]; outcome?: number; resolved?: boolean;
    errorCode?: string; payloadHash?: string; responseHash?: string }[];
  assertion: string }
interface CaseEvidence { id: string; status: string; reason?: string; rounds: RoundEvidence[] }
export class En05Fixture {
  apps: AppProcess[] = [];
  actors: Actor[] = [];
  db!: Db;
  private client?: MongoClient;
  private lease?: TestDatabase;
  private saved = { ...process.env };
  private owner = '';
  private sequence = 0;
  private namespace = '';
  private current?: RoundEvidence;
  readonly cases: CaseEvidence[] = [];
  admin!: Actor; staff!: Actor; pts!: Actor[]; members!: Actor[];
  trainers: ObjectId[] = []; memberIds: ObjectId[] = []; memberships: ObjectId[] = []; shifts: ObjectId[] = [];
  async start() {
    this.lease = await createTestDatabase({ ...process.env }, 'en05');
    Object.assign(process.env, { MONGODB_URI: process.env.MONGODB_TEST_URI, MONGODB_DB: this.lease.name, EN05_NOW: NOW });
    this.client = new MongoClient(process.env.MONGODB_TEST_URI!, { serverSelectionTimeoutMS: 10000,
      runtimeAdapters: { os: require('node:os') } });
    await this.client.connect(); this.db = this.client.db(this.lease.name);
    this.owner = String((await this.db.collection('__en04_owner').findOne({ _id: 'owner' as unknown as ObjectId }))!.owner);
    for (let i = 0; i < 2; i++) { const app = new AppProcess(); this.apps.push(app); await app.start(); }
    if (new Set(this.apps.map(app => app.child.pid)).size !== 2 || this.apps.some(app => app.child.pid === process.pid)) throw new Error('EN05_TWO_PROCESSES_REQUIRED');
    const password = 'EN05 integration fixture 123';
    this.actors = (await this.apps[0].rpc('accounts', { password }) as Omit<Actor, 'tokens'>[]).map(actor => ({ ...actor, tokens: [] }));
    for (const actor of this.actors) for (const app of this.apps) {
      const response = await fetch(`${app.url}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
        body: JSON.stringify({ phone: actor.phone, password }) });
      if (response.status !== 200) throw new Error('EN05_REAL_LOGIN_FAILED');
      actor.tokens.push((await response.json() as { accessToken: string }).accessToken);
    }
    [this.admin, this.staff] = this.actors; this.pts = this.actors.slice(2, 4); this.members = this.actors.slice(4);
    const indexes = await Promise.all(['pt_bookings', 'operation_requests', 'booking_events', 'notifications', 'notification_recipients', 'notification_outbox']
      .map(async name => ({ collection: name, indexes: await this.db.collection(name).listIndexes().toArray() })));
    writeFileSync(path.join(process.env.EN05_REPORT_DIR!, 'processes-indexes.json'), JSON.stringify({ database: this.db.databaseName,
      pids: this.apps.map(app => app.child.pid), parentPid: process.pid, indexes }, null, 2));
  }
  oid(label: string) { return new ObjectId(createHash('sha256').update(`${process.env.EN04_RUN_ID}|${this.namespace}|${label}`).digest('hex').slice(0, 24)); }
  key() { return randomUUID(); }
  async reset(id: string, round: number, quota = 2) {
    if (this.db.databaseName !== this.lease!.name ||
      String((await this.db.collection('__en04_owner').findOne({ _id: 'owner' as unknown as ObjectId }))?.owner) !== this.owner) throw new Error('TEST_DATABASE_NOT_OWNED');
    await Promise.all(this.apps.map(app => app.rpc('clear'))); await this.clock(NOW);
    this.namespace = `${process.env.EN04_RUN_ID}_${id}_${round}`; this.sequence = 0;
    const collections = ['members', 'trainers', 'plans', 'plan_conversion_policies', 'transactions', 'service_sales', 'memberships', 'work_shifts',
      'shift_events', 'pt_bookings', 'booking_events', 'public_sessions', 'notifications', 'notification_recipients', 'notification_outbox', 'operation_requests', 'payments', 'invoices'];
    for (const name of collections) await this.db.collection(name).deleteMany({});
    await this.db.collection('schedule_guards').updateOne({ _id: 'global' as unknown as ObjectId }, { $set: { revision: Long.ZERO } }, { upsert: true });
    await this.db.collection('security_state').updateOne({ _id: 'account-administration' as unknown as ObjectId }, { $set: { revision: Long.ZERO } }, { upsert: true });
    this.trainers = []; this.memberIds = []; this.memberships = []; this.shifts = [];
    for (const [i, actor] of this.pts.entries()) {
      const trainer = await this.insert('trainers', { account_id: new ObjectId(actor.id), specialty: 'EN05', status: 'ACTIVE', version: 0 });
      this.trainers.push(trainer); this.shifts.push(await this.shift(i, '00:00', '22:00'));
    }
    for (const [i, actor] of this.members.entries()) {
      const member = await this.insert('members', { member_code: `${id}-${round}-${i}`, full_name: `EN05 member ${i}`, phone: actor.phone,
        account_id: new ObjectId(actor.id), version: 0, service_revision: Long.ZERO, created_by: new ObjectId(this.staff.id), updated_by: new ObjectId(this.staff.id) });
      this.memberIds.push(member); this.memberships.push(await this.plan(member, quota));
    }
    // Inert, valid fixture statuses on a separate day. DRAFT/CANCELLED must never block or be public.
    await this.shift(0, '08:00', '09:00', 'SCHEDULED', '2035-11-18');
    await this.shift(0, '09:00', '10:00', 'CANCELLED', '2035-11-18');
    await this.session(1, '08:00', '09:00', 'DRAFT', '2035-11-18');
    await this.session(1, '10:00', '11:00', 'PUBLISHED', '2035-11-18');
  }
  async insert(collection: string, data: Record<string, unknown>) {
    const id = this.oid(`${collection}_${++this.sequence}`), now = new Date(NOW);
    const timestamps = ['members', 'trainers', 'plans', 'plan_conversion_policies', 'work_shifts', 'public_sessions'].includes(collection);
    await this.db.collection(collection).insertOne({ _id: id, id, created_at: now, ...(timestamps ? { updated_at: now } : {}), ...data,
      ...(collection === 'members' ? { member_code: `HV-${id}` } : {}) }); return id;
  }
  async plan(member: ObjectId, quota = 2, start = '2035-11-15', end = '2035-12-14') {
    const money = Decimal128.fromString('900000');
    const duration = (new Date(end).getTime() - new Date(start).getTime()) / 86400000 + 1;
    const plan = await this.insert('plans', { code: `EN05_${this.sequence}`, name: 'EN05 PT', kind: 'PT', duration_days: duration,
      session_quota: quota, price: money, benefits: 'EN05', status: 'ACTIVE', version: 0, guard_revision: Long.ZERO,
      created_by: new ObjectId(this.admin.id), updated_by: new ObjectId(this.admin.id) });
    const transaction = await this.insert('transactions', { code: `EN05_${this.sequence}`, member_id: member, kind: 'PT', amount_due: money,
      status: 'SETTLED', request_key: createHash('sha256').update(`${this.namespace}_${this.sequence}`).digest('hex'), version: 0, guard_revision: Long.ZERO, created_by: new ObjectId(this.staff.id) });
    const sale = await this.insert('service_sales', { transaction_id: transaction, member_id: member, plan_id: plan, operation: 'REGISTER', channel: 'COUNTER',
      start_date: start, end_date: end, plan_name_snapshot: 'EN05 PT', benefits_snapshot: 'EN05', kind_snapshot: 'PT', duration_days_snapshot: duration,
      sessions_snapshot: quota, list_price_snapshot: money, credit_amount: Decimal128.fromString('0'), policy_snapshot: 'Giá niêm yết', plan_version_snapshot: 0 });
    return this.insert('memberships', { service_sale_id: sale, status: 'ACTIVE', sessions_used: 0, version: 0 });
  }
  shift(pt: number, start: string, end: string, status = 'CONFIRMED', day = DAY) {
    const startAt = new Date(at(start, day)), endAt = new Date(at(end, day));
    if (end === '00:00' && endAt <= startAt) endAt.setUTCDate(endAt.getUTCDate() + 1);
    return this.insert('work_shifts', { trainer_id: this.trainers[pt], start_at: startAt, end_at: endAt,
      location: 'EN05', status, version: 0, created_by: new ObjectId(this.pts[pt].id), updated_by: new ObjectId(this.pts[pt].id),
      ...(status === 'CONFIRMED' ? { confirmed_at: new Date(NOW) } : {}) });
  }
  session(pt: number, start: string, end: string, status = 'PUBLISHED', day = DAY) {
    return this.insert('public_sessions', { trainer_id: this.trainers[pt], title: 'EN05 class', location: 'EN05', subject_code: 'YOGA',
      start_at: new Date(at(start, day)), end_at: new Date(at(end, day)), status, version: 0,
      created_by: new ObjectId(this.admin.id), updated_by: new ObjectId(this.admin.id),
      ...(status === 'PUBLISHED' ? { published_at: new Date(NOW) } : {}),
      ...(status === 'CANCELLED' ? { cancelled_at: new Date(NOW), cancelled_by: new ObjectId(this.admin.id), cancellation_reason: reason } : {}) });
  }
  book(member = 0, hour = '08:00', pt = 0, app = 0, key = this.key(), membership = this.memberships[member], shift = this.shifts[pt], day = DAY): Call {
    return { app, actor: this.members[member], path: '/me/pt-bookings', operation: 'PT_BOOKING_CREATE', key,
      body: { membershipId: String(membership), trainerId: String(this.trainers[pt]), shiftId: String(shift), startAt: at(hour, day) } };
  }
  cancel(booking: string, app = 0, actor = this.members[0], key = this.key(), version = 0): Call {
    const own = actor.role === 'MEMBER';
    return { app, actor, path: `${own ? '/me' : ''}/pt-bookings/${booking}/cancel`, operation: own ? 'PT_BOOKING_CANCEL_OWN' : 'PT_BOOKING_CANCEL_SUPPORT',
      key, body: { version, reason } };
  }
  async clock(value: string) { await Promise.all(this.apps.map(app => app.rpc('clock', value))); }
  async send(call: Call): Promise<Outcome> {
    const evidence = { app: call.app, pid: this.apps[call.app].child.pid!, method: call.method ?? 'POST', path: call.path,
      key: call.key, payloadHash: createHash('sha256').update(JSON.stringify(call.body ?? {})).digest('hex'), responseHash: '',
      statuses: [] as number[], outcome: undefined as number | undefined, resolved: false, errorCode: undefined as string | undefined };
    this.current?.requests.push(evidence);
    const perform = async (): Promise<Outcome> => {
      const response = await fetch(`${this.apps[call.app].url}/api${call.path}`, { method: call.method ?? 'POST',
        signal: AbortSignal.timeout(20000), headers: { Origin: 'http://localhost:5173', 'Content-Type': 'application/json',
          ...(call.actor ? { Authorization: `Bearer ${call.actor.tokens[call.app]}` } : {}), ...(call.key ? { 'Idempotency-Key': call.key } : {}) },
        ...(call.body ? { body: JSON.stringify(call.body) } : {}) });
      evidence.statuses.push(response.status);
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    let response: Outcome | undefined;
    try { response = await perform(); } catch { if (!call.key || !call.operation) throw new Error('EN05_TRANSPORT_UNRESOLVED'); }
    const unknown = () => !response || response.status === 503 && (response.body.error as { code?: string } | undefined)?.code === 'OPERATION_OUTCOME_UNKNOWN';
    for (let attempt = 0; attempt < 3 && unknown(); attempt++) {
      if (!call.key || !call.operation || !call.actor) break;
      const lookup = await fetch(`${this.apps[1 - call.app].url}/api/operations/${call.operation}/${call.key}`,
        { signal: AbortSignal.timeout(20000), headers: { Authorization: `Bearer ${call.actor.tokens[1 - call.app]}` } });
      if (lookup.status === 200) {
        const body = await lookup.json() as { responseStatus: number; responseBody: Record<string, unknown> };
        response = { status: body.responseStatus, body: body.responseBody }; evidence.resolved = true;
      } else if (lookup.status === 404) { response = await perform(); evidence.resolved = response.status !== 503; }
      else throw new Error('EN05_LOOKUP_UNRESOLVED');
    }
    if (!response) throw new Error('EN05_OUTCOME_UNRESOLVED');
    if (response.status === 503 && (response.body.error as { code?: string } | undefined)?.code === 'OPERATION_OUTCOME_UNKNOWN') throw new Error('EN05_503_UNRESOLVED');
    evidence.outcome = response.status; evidence.errorCode = (response.body.error as { code?: string } | undefined)?.code;
    evidence.responseHash = createHash('sha256').update(JSON.stringify(response.body)).digest('hex');
    return response;
  }
  async batch(calls: Call[]) {
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const pending = calls.map(async call => { await barrier; return this.send(call); });
    release();
    const results = await Promise.allSettled(pending);
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    return results.map(result => (result as PromiseFulfilledResult<Outcome>).value);
  }
  async race(calls: Call[], round: number) {
    await Promise.all(this.apps.map(app => app.arm('guard')));
    const pending = this.batch(round % 2 ? [...calls].reverse() : calls);
    // Observe errors immediately, then await the original promise after releasing hooks.
    void pending.catch(() => undefined);
    try { await Promise.all(this.apps.map(app => app.hit('guard'))); }
    finally { await Promise.all(this.apps.map(app => app.rpc('release'))); }
    return pending;
  }
  blocked(id: string, why: string) { this.cases.push({ id, status: 'BLOCKED', reason: why, rounds: [] }); this.flush(); }
  async checkpoint(label: string) {
    const snapshot = await inspectCommitted(this.db);
    this.current?.checkpoints?.push({ label, snapshot });
    return snapshot;
  }
  async run(id: string, work: (round: number) => Promise<void>, quota = 2, partial?: string) {
    const tc: CaseEvidence = { id, status: 'RUNNING', rounds: [], ...(partial ? { reason: partial } : {}) }; this.cases.push(tc);
    try {
      for (let round = 0; round < 10; round++) {
        await this.reset(id, round, quota);
        const started = Date.now();
        const entry: RoundEvidence = { round, testRunId: this.namespace, startedAt: new Date().toISOString(), durationMs: 0, requests: [], checkpoints: [], assertion: 'RUNNING' };
        tc.rounds.push(entry); this.current = entry;
        try {
          await this.apps[0].rpc('validate');
          entry.before = await inspectCommitted(this.db); await work(round);
          await this.apps[0].rpc('validate');
          entry.after = await inspectCommitted(this.db); entry.assertion = 'PASSED';
        }
        catch (error) {
          entry.assertion = error instanceof Error && /^EN05_/.test(error.message) ? error.message : 'ASSERTION_FAILED';
          entry.failureDb = await captureFailure(this.db); throw error;
        }
        finally { entry.durationMs = Date.now() - started; this.flush(); }
      }
      tc.status = partial ? 'PARTIAL' : 'PASSED';
    } catch (error) { tc.status = 'FAILED'; throw error; }
    finally { this.current = undefined; this.flush(); }
  }
  flush() { writeFileSync(path.join(process.env.EN05_REPORT_DIR!, 'cases.json'), JSON.stringify({ cases: this.cases }, null, 2)); }
  async close() {
    const results = await Promise.allSettled(this.apps.map(app => app.close()));
    await this.client?.close();
    if (this.lease) { process.env.MONGODB_DB = this.saved.MONGODB_DB; await this.lease.close(); }
    process.env = this.saved;
    if (results.some(result => result.status === 'rejected')) throw new Error('EN05_CLEANUP_FAILED');
  }
}
