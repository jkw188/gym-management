import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession } from 'mongodb';
import { Connection, Model, Types } from 'mongoose';
import { Trainer } from './schemas/trainer.schema';
import { TrainerEvent } from './schemas/trainer-event.schema';
import { BlockerKind, TrainerBlockerQueryDto, TrainerListQueryDto } from './trainers.dto';

interface TrainerRow extends Trainer { full_name?: string; phone?: string; email?: string; account_status?: string; role_code?: string }
interface BlockerRow { _id: Types.ObjectId; kind: BlockerKind; start_at: Date; end_at: Date; status: string }
export type BlockerCounts = Record<BlockerKind, number>;
const SOURCES = [
  { kind: 'BOOKING', collection: 'pt_bookings', statuses: ['BOOKED'] },
  { kind: 'SHIFT', collection: 'work_shifts', statuses: ['SCHEDULED', 'CONFIRMED'] },
  { kind: 'PUBLIC_SESSION', collection: 'public_sessions', statuses: ['PUBLISHED'] },
] as const;

// Project account fields at the lookup boundary; credentials never enter a trainer response or replay record.
const accountStages = [
  { $lookup: { from: 'accounts', localField: 'account_id', foreignField: '_id', as: 'account',
    pipeline: [{ $project: { full_name: 1, phone: 1, email: 1, status: 1, role_id: 1 } }] } },
  { $unwind: { path: '$account', preserveNullAndEmptyArrays: true } },
  { $lookup: { from: 'roles', localField: 'account.role_id', foreignField: '_id', as: 'role', pipeline: [{ $project: { code: 1 } }] } },
  { $set: { full_name: '$account.full_name', phone: '$account.phone', email: '$account.email',
    account_status: '$account.status', role_code: { $first: '$role.code' } } },
  { $unset: ['account', 'role'] },
];

@Injectable()
export class TrainersRepository implements OnModuleInit {
  constructor(@InjectModel('Trainer') private readonly trainers: Model<Trainer>,
    @InjectModel('TrainerEvent') private readonly events: Model<TrainerEvent>,
    @InjectConnection() private readonly connection: Connection, private readonly config: ConfigService) {}

  async onModuleInit() {
    for (const model of [this.trainers, this.events] as Model<Trainer | TrainerEvent>[]) {
      if (this.config.get('nodeEnv') !== 'production') await model.createIndexes();
      const indexes = await model.collection.listIndexes().toArray();
      for (const [key, options] of model.schema.indexes()) {
        if (!indexes.some(index => JSON.stringify(index.key) === JSON.stringify(key) &&
          Boolean(index.unique) === Boolean(options.unique) && !index.partialFilterExpression && !index.sparse)) {
          throw new Error('DATABASE_INDEXES_REQUIRED: run npm run ensure-indexes');
        }
      }
    }
  }

  async list(query: TrainerListQueryDto) {
    const stages: object[] = [{ $match: query.status ? { status: query.status } : {} }, ...accountStages];
    if (query.q) {
      const term = query.q.trim();
      const digits = term.replace(/[\s.()\-]/g, '');
      // Accounts store +84 numbers. Domestic/partial phone searches follow the existing users list convention.
      const phoneTerm = /^\+?\d+$/.test(digits) ? digits.replace(/^0/, '+84').replace(/^84/, '+84') : term;
      const literal = (value: string) => ({ $regex: value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' });
      stages.push({ $match: { $or: [{ full_name: literal(term) }, { phone: literal(phoneTerm) }, { specialty: literal(term) }] } });
    }
    stages.push({ $sort: { full_name: 1, _id: 1 } }, { $facet: {
      items: [{ $skip: (query.page - 1) * query.limit }, { $limit: query.limit }], total: [{ $count: 'count' }],
    } });
    const [result] = await this.connection.db!.collection('trainers').aggregate<{ items: TrainerRow[]; total: { count: number }[] }>(
      stages, { maxTimeMS: 5000, collation: { locale: 'vi' } }).toArray();
    return { items: result.items, total: result.total[0]?.count ?? 0 };
  }

  async detail(id: Types.ObjectId, session?: ClientSession): Promise<TrainerRow | null> {
    const [row] = await this.connection.db!.collection('trainers').aggregate<TrainerRow>([
      { $match: { _id: id } }, ...accountStages,
    ], { session, maxTimeMS: 5000 }).toArray();
    return row ?? null;
  }
  find(id: Types.ObjectId, session: ClientSession) { return this.trainers.findById(id).session(session).lean().exec(); }

  async account(id: Types.ObjectId, session: ClientSession) {
    const account = await this.connection.db!.collection('accounts').findOne({ _id: id }, { session, projection: { status: 1, role_id: 1 } });
    if (!account) return null;
    const role = await this.connection.db!.collection('roles').findOne({ _id: account.role_id }, { session, projection: { code: 1 } });
    return { status: account.status as string, roleCode: role?.code as string | undefined };
  }
  linked(accountId: Types.ObjectId, session: ClientSession) { return this.trainers.exists({ account_id: accountId }).session(session).exec(); }
  async insert(data: Partial<Trainer>, session: ClientSession): Promise<Trainer> {
    const [row] = await this.trainers.create([data], { session });
    return row.toObject();
  }
  update(id: Types.ObjectId, version: number, data: Partial<Trainer>, session: ClientSession) {
    return this.trainers.findOneAndUpdate({ _id: id, version }, { $set: data, $inc: { version: 1 } },
      { session, returnDocument: 'after', runValidators: true, timestamps: false }).lean().exec();
  }
  async insertEvent(data: Omit<TrainerEvent, '_id'>, session: ClientSession) { await this.events.create([data], { session }); }

  async blockerCounts(id: Types.ObjectId, now: Date, session?: ClientSession): Promise<BlockerCounts> {
    const counts: BlockerCounts = { BOOKING: 0, SHIFT: 0, PUBLIC_SESSION: 0 };
    // One session: keep reads sequential in a transaction.
    for (const source of SOURCES) counts[source.kind] = await this.connection.db!.collection(source.collection).countDocuments({
      trainer_id: id, status: { $in: [...source.statuses] }, end_at: { $gt: now },
    }, { session, maxTimeMS: 5000 });
    return counts;
  }
  async blockers(id: Types.ObjectId, now: Date, query: TrainerBlockerQueryDto) {
    const sources = SOURCES.filter(source => !query.kind || source.kind === query.kind);
    const pipeline = (source: typeof SOURCES[number]) => [
      { $match: { trainer_id: id, status: { $in: [...source.statuses] }, end_at: { $gt: now } } },
      { $project: { _id: 1, kind: { $literal: source.kind }, start_at: 1, end_at: 1, status: 1 } },
    ];
    const stages: object[] = pipeline(sources[0]);
    for (const source of sources.slice(1)) stages.push({ $unionWith: { coll: source.collection, pipeline: pipeline(source) } });
    stages.push({ $sort: { kind: 1, start_at: 1, _id: 1 } }, { $skip: (query.page - 1) * query.limit }, { $limit: query.limit });
    return this.connection.db!.collection(sources[0].collection).aggregate<BlockerRow>(stages, { maxTimeMS: 5000 }).toArray();
  }
}

export function trainerResponse(row: TrainerRow, detail = true) {
  const summary = { id: row._id.toHexString(), accountId: row.account_id.toHexString(), fullName: row.full_name ?? '',
    specialty: row.specialty, status: row.status, version: Number(row.version) };
  return detail ? { ...summary, phone: row.phone ?? '', ...(row.email ? { email: row.email } : {}),
    accountStatus: row.account_status ?? null, roleCode: row.role_code ?? null,
    createdAt: row.created_at?.toISOString() ?? null, updatedAt: row.updated_at?.toISOString() ?? null } : summary;
}
