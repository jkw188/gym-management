import { Injectable } from '@nestjs/common';
import { MongoServerError } from 'mongodb';
import { Types } from 'mongoose';
import { ApplicationError, invalidField } from '../../common/errors/application-error';
import { ServerClock } from '../../common/utils/business-date';
import { DataGuardsService } from '../../infrastructure/transaction/data-guards.service';
import { IdempotencyService, transactionRequestKey } from '../operations/idempotency.service';
import { Trainer, TrainerStatus } from './schemas/trainer.schema';
import { TrainerEvent, TrainerSnapshot } from './schemas/trainer-event.schema';
import { CreateTrainerDto, TrainerBlockerQueryDto, TrainerListQueryDto, UpdateTrainerDto } from './trainers.dto';
import { TrainersRepository, trainerResponse } from './trainers.repository';

@Injectable()
export class TrainersService {
  constructor(private readonly repository: TrainersRepository, private readonly guards: DataGuardsService,
    private readonly idempotency: IdempotencyService, private readonly clock: ServerClock) {}

  async list(query: TrainerListQueryDto) {
    const result = await this.repository.list(query);
    return { items: result.items.map(row => trainerResponse(row, false)), page: query.page, limit: query.limit,
      total: result.total, totalPages: Math.ceil(result.total / query.limit) };
  }
  async detail(id: string) {
    const row = await this.repository.detail(parseId(id));
    if (!row) throw notFound();
    return trainerResponse(row);
  }
  async blockers(id: string, query: TrainerBlockerQueryDto) {
    const trainerId = parseId(id);
    if (!await this.repository.detail(trainerId)) throw notFound();
    const now = this.clock.now();
    const counts = await this.repository.blockerCounts(trainerId, now);
    const rows = await this.repository.blockers(trainerId, now, query);
    const total = query.kind ? counts[query.kind] : Object.values(counts).reduce((sum, count) => sum + count, 0);
    return { items: rows.map(row => ({ id: row._id.toHexString(), kind: row.kind,
      startAt: row.start_at.toISOString(), endAt: row.end_at.toISOString(), status: row.status,
      ...(row.kind === 'BOOKING' ? { managementUrl: '/admin/pt-bookings' } : {}),
    })), counts, asOf: now.toISOString(), page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) };
  }
  async create(actorId: string, input: CreateTrainerDto, clientKey: string) {
    const accountId = parseId(input.accountId);
    const specialty = normalizeSpecialty(input.specialty);
    const status = normalizeStatus(input.status);
    try {
      return await this.idempotency.execute({ actorId, operation: 'TRAINER_CREATE', clientKey,
        payload: { accountId: accountId.toHexString(), specialty, status } }, async session => {
        // US-07/08 lock comes before S04-G01. Link and account eligibility are checked in this same transaction.
        await this.guards.acquire(session, { accountAdministration: true, schedule: true });
        const account = await this.repository.account(accountId, session);
        if (!account) throw new ApplicationError(404, 'ACCOUNT_NOT_FOUND', 'Không tìm thấy tài khoản');
        if (account.status !== 'ACTIVE' || account.roleCode !== 'TRAINER') {
          throw new ApplicationError(409, 'ACCOUNT_NOT_ELIGIBLE', 'Chọn tài khoản PT đang hoạt động');
        }
        if (await this.repository.linked(accountId, session)) throw alreadyLinked();
        const now = this.clock.now();
        const actor = new Types.ObjectId(actorId);
        const row = await this.repository.insert({ account_id: accountId, specialty, status, version: 0,
          created_by: actor, updated_by: actor, created_at: now, updated_at: now }, session);
        await this.repository.insertEvent({ trainer_id: row._id, actor_id: actor, action: 'CREATED', after: snapshot(row),
          occurred_at: now, request_key: transactionRequestKey(actorId, 'TRAINER_CREATE', clientKey) }, session);
        const detail = await this.repository.detail(row._id, session);
        return { status: 201, body: { ...trainerResponse(detail!) }, resultIds: { trainerId: row._id } };
      });
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000 && error.keyPattern?.account_id) throw alreadyLinked();
      throw error;
    }
  }
  async update(actorId: string, id: string, input: UpdateTrainerDto, clientKey: string) {
    const trainerId = parseId(id);
    if (input.specialty === undefined && input.status === undefined) invalidField('fields', 'Cần gửi chuyên môn hoặc trạng thái');
    const specialty = input.specialty === undefined ? undefined : normalizeSpecialty(input.specialty);
    const status = input.status === undefined ? undefined : normalizeStatus(input.status);
    return this.idempotency.execute({ actorId, operation: 'TRAINER_UPDATE', clientKey, targetId: trainerId.toHexString(),
      payload: { version: input.version, specialty, status } }, async session => {
      await this.guards.acquire(session, { schedule: true });
      const current = await this.repository.find(trainerId, session);
      if (!current) throw notFound();
      if (Number(current.version) !== input.version) throw versionConflict();
      if (current.version >= 2147483647) throw versionConflict();
      const next = { specialty: specialty ?? current.specialty, status: status ?? current.status };
      if (next.specialty === current.specialty && next.status === current.status) invalidField('fields', 'Cần ít nhất một thay đổi');
      const now = this.clock.now();
      if (current.status === 'ACTIVE' && next.status === 'INACTIVE') {
        const counts = await this.repository.blockerCounts(trainerId, now, session);
        if (Object.values(counts).some(count => count > 0)) {
          // EN01-D03 details keep the established field/message shape; no member identities in conflicts.
          throw new ApplicationError(409, 'TRAINER_HAS_ACTIVE_SCHEDULE', 'PT còn lịch chưa kết thúc. Hãy xử lý trở ngại trước', [
            ...Object.entries(counts).map(([kind, count]) => ({ field: `counts.${kind}`, message: String(count) })),
            { field: 'blockersUrl', message: `/api/trainers/${id}/deactivation-blockers` },
            { field: 'managementUrl', message: '/admin/pt-bookings' },
          ]);
        }
      }
      const actor = new Types.ObjectId(actorId);
      const updated = await this.repository.update(trainerId, input.version, { ...next, updated_by: actor, updated_at: now }, session);
      if (!updated) throw versionConflict();
      const action: TrainerEvent['action'] = current.status === next.status ? 'UPDATED' : next.status === 'INACTIVE' ? 'DEACTIVATED' : 'REACTIVATED';
      await this.repository.insertEvent({ trainer_id: trainerId, actor_id: actor, action, before: snapshot(current), after: snapshot(updated),
        occurred_at: now, request_key: transactionRequestKey(actorId, 'TRAINER_UPDATE', clientKey) }, session);
      const detail = await this.repository.detail(trainerId, session);
      return { status: 200, body: { ...trainerResponse(detail!) }, resultIds: { trainerId } };
    });
  }
}
function parseId(value: string) {
  if (!/^[a-f\d]{24}$/i.test(value)) throw new ApplicationError(400, 'INVALID_ID', 'ID không hợp lệ');
  return new Types.ObjectId(value);
}
function normalizeSpecialty(value: string) {
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > 255) invalidField('specialty', 'Chuyên môn phải có 1–255 ký tự');
  return value.trim();
}
function normalizeStatus(value: TrainerStatus): TrainerStatus {
  if (!['ACTIVE', 'INACTIVE'].includes(value)) invalidField('status', 'Trạng thái không hợp lệ');
  return value;
}
function snapshot(row: Trainer): TrainerSnapshot { return { specialty: row.specialty, status: row.status, version: Number(row.version) }; }
const notFound = () => new ApplicationError(404, 'TRAINER_NOT_FOUND', 'Không tìm thấy hồ sơ PT');
const alreadyLinked = () => new ApplicationError(409, 'ACCOUNT_ALREADY_LINKED', 'Tài khoản đã liên kết hồ sơ PT');
const versionConflict = () => new ApplicationError(409, 'VERSION_CONFLICT', 'Hồ sơ PT đã thay đổi. Vui lòng tải lại');
