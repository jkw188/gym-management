import { Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { ServerClock } from '../../common/utils/business-date';
import { DataGuardsService } from '../../infrastructure/transaction/data-guards.service';
import { IdempotencyService, transactionRequestKey } from '../operations/idempotency.service';
import { ShiftIntervalService } from '../shifts/shift-interval.service';
import { AdminSessionQueryDto, CancelPublicSessionDto, CreatePublicSessionDto, PreviewPublicSessionDto, SessionVersionDto, UpdatePublicSessionDto } from './admin-public-sessions.dto';
import { AdminPublicSessionsRepository, draftFields } from './admin-public-sessions.repository';
import { toPublicSessionResponse } from './public-sessions.mapper';
import { PublicSessionsRepository } from './public-sessions.repository';
import { sessionDraft, sessionText } from './public-session.policy';
import { PublicSession } from './schemas/public-session.schema';
import { PublicSessionEvent, SessionSnapshot } from './schemas/public-session-event.schema';

@Injectable()
export class AdminPublicSessionsService {
  constructor(private readonly repository: AdminPublicSessionsRepository, private readonly publicRepository: PublicSessionsRepository,
    private readonly interval: ShiftIntervalService, private readonly guards: DataGuardsService,
    private readonly idempotency: IdempotencyService, private readonly clock: ServerClock) {}

  async list(query: AdminSessionQueryDto) {
    const result = await this.repository.list(query, this.interval.vietnamDateRange(query.fromDate, query.toDate, this.clock.now()));
    const names = await this.publicRepository.findTrainerNames(result.items.map(row => row.trainer_id));
    return { items: result.items.map(row => adminSessionResponse(row, names.get(String(row.trainer_id)) ?? null, this.clock.now())),
      total: result.total, page: query.page, limit: query.limit, totalPages: Math.ceil(result.total / query.limit) };
  }
  async detail(id: string) {
    const row = await this.repository.find(parseId(id));
    if (!row) throw notFound();
    const names = await this.publicRepository.findTrainerNames([row.trainer_id]);
    return adminSessionResponse(row, names.get(String(row.trainer_id)) ?? null, this.clock.now());
  }
  async preview(input: PreviewPublicSessionDto) {
    const draft = sessionDraft(input, this.interval);
    this.interval.assertFutureStart(draft.startAt, this.clock.now());
    const trainerId = parseId(draft.trainerId);
    const conflicts = await this.repository.conflicts(trainerId, draft.startAt, draft.endAt, input.sessionId ? parseId(input.sessionId) : undefined);
    if (!await this.repository.eligibleTrainer(trainerId)) conflicts.unshift('TRAINER_UNAVAILABLE');
    return { startAt: draft.startAt.toISOString(), endAt: draft.endAt.toISOString(), conflictCodes: conflicts };
  }
  async create(actorId: string, input: CreatePublicSessionDto, clientKey: string) {
    const draft = sessionDraft(input, this.interval);
    return this.idempotency.execute({ actorId, operation: 'PUBLIC_SESSION_CREATE', clientKey, payload: { ...draft } }, async session => {
      // Cùng thứ tự với quản trị account: khóa account trước, rồi khóa lịch. Recheck sau khi lấy khóa.
      await this.guards.acquire(session, { accountAdministration: true, schedule: true });
      const now = this.clock.now();
      this.interval.assertFutureStart(draft.startAt, now);
      if (!await this.repository.eligibleTrainer(parseId(draft.trainerId), session)) throw trainerUnavailable();
      const actor = new Types.ObjectId(actorId);
      const row = await this.repository.insert(draft, actor, now, session);
      await this.repository.insertEvent({ session_id: row._id, actor_id: actor, action: 'CREATED', after: snapshot(row),
        occurred_at: now, request_key: transactionRequestKey(actorId, 'PUBLIC_SESSION_CREATE', clientKey) }, session);
      return { status: 201, body: adminSessionResponse(row, null, now), resultIds: { sessionId: row._id } };
    });
  }
  update(actorId: string, id: string, input: UpdatePublicSessionDto, key: string) {
    const draft = sessionDraft(input, this.interval);
    return this.mutate(actorId, id, input, key, 'UPDATED', { ...draft }, draftFields(draft));
  }
  publish(actorId: string, id: string, input: SessionVersionDto, key: string) {
    return this.mutate(actorId, id, input, key, 'PUBLISHED', {}, { status: 'PUBLISHED' });
  }
  cancel(actorId: string, id: string, input: CancelPublicSessionDto, key: string) {
    const reason = sessionText(input.reason, 'reason', 10, 500);
    return this.mutate(actorId, id, input, key, 'CANCELLED', { reason }, { status: 'CANCELLED', cancellation_reason: reason });
  }
  private mutate(actorId: string, id: string, input: SessionVersionDto, key: string,
    action: Exclude<PublicSessionEvent['action'], 'CREATED'>, payload: Record<string, unknown>, changes: Partial<PublicSession>) {
    const sessionId = parseId(id);
    const operation = action === 'UPDATED' ? 'PUBLIC_SESSION_UPDATE' : action === 'PUBLISHED' ? 'PUBLIC_SESSION_PUBLISH' : 'PUBLIC_SESSION_CANCEL';
    return this.idempotency.execute({ actorId, operation, clientKey: key, targetId: sessionId.toHexString(), payload: { ...payload, version: input.version } }, async session => {
      await this.guards.acquire(session, { accountAdministration: action !== 'CANCELLED', schedule: true });
      const current = await this.repository.find(sessionId, session);
      if (!current) throw notFound();
      const now = this.clock.now();
      if (current.status === 'CANCELLED' || action === 'PUBLISHED' && current.status !== 'DRAFT') {
        throw new ApplicationError(409, 'INVALID_SESSION_STATE', 'Trạng thái lớp không cho phép thao tác này');
      }
      if (current.start_at <= now) throw new ApplicationError(409, 'SESSION_ALREADY_STARTED', 'Lớp đã bắt đầu, không thể thay đổi');
      if (current.version !== input.version) throw versionConflict();
      const actor = new Types.ObjectId(actorId);
      const next = { ...current, ...changes };
      if (action !== 'CANCELLED') {
        this.interval.assertFutureStart(next.start_at, now);
        // Revalidate cả dữ liệu legacy trước công bố (bộ môn được migration điền OTHER).
        sessionDraft({ title: next.title, location: next.location, trainerId: String(next.trainer_id), subjectCode: next.subject_code,
          startAt: next.start_at.toISOString(), endAt: next.end_at.toISOString() }, this.interval);
        if (!await this.repository.eligibleTrainer(next.trainer_id, session)) throw trainerUnavailable();
        if (next.status === 'PUBLISHED') {
          const conflicts = await this.repository.conflicts(next.trainer_id, next.start_at, next.end_at, sessionId, session);
          if (conflicts.length) throw new ApplicationError(409, conflicts[0], conflicts[0] === 'SESSION_OVERLAP' ? 'PT trùng giờ lớp đã công bố' : 'PT trùng giờ lịch đặt');
        }
      }
      const update = { ...changes,
        ...(action === 'PUBLISHED' ? { published_at: now } : {}),
        ...(action === 'CANCELLED' ? { cancelled_at: now, cancelled_by: actor } : {}) };
      const updated = await this.repository.change(current, update, actor, now, session);
      if (!updated) throw versionConflict();
      await this.repository.insertEvent({ session_id: sessionId, actor_id: actor, action, before: snapshot(current), after: snapshot(updated),
        ...(action === 'CANCELLED' ? { reason: updated.cancellation_reason } : {}),
        occurred_at: now, request_key: transactionRequestKey(actorId, operation, key) }, session);
      return { status: 200, body: adminSessionResponse(updated, null, now), resultIds: { sessionId } };
    });
  }
}
function snapshot(row: PublicSession): SessionSnapshot {
  return { title: row.title, trainer_id: row.trainer_id, subject_code: row.subject_code, location: row.location,
    start_at: row.start_at, end_at: row.end_at, status: row.status, version: row.version };
}
function adminSessionResponse(row: PublicSession, name: string | null, now: Date) {
  return { ...toPublicSessionResponse(row, name, now), version: row.version,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), createdBy: String(row.created_by), updatedBy: String(row.updated_by),
    ...(row.published_at ? { publishedAt: row.published_at.toISOString() } : {}),
    ...(row.cancelled_at ? { cancelledAt: row.cancelled_at.toISOString(), cancelledBy: String(row.cancelled_by), cancellationReason: row.cancellation_reason } : {}) };
}
function parseId(id: string) {
  if (!/^[a-f\d]{24}$/i.test(id)) throw new ApplicationError(400, 'INVALID_ID', 'Mã lớp hoặc PT không hợp lệ');
  return new Types.ObjectId(id);
}
const notFound = () => new ApplicationError(404, 'SESSION_NOT_FOUND', 'Không tìm thấy lớp');
const trainerUnavailable = () => new ApplicationError(409, 'TRAINER_UNAVAILABLE', 'PT hoặc tài khoản PT không khả dụng');
const versionConflict = () => new ApplicationError(409, 'VERSION_CONFLICT', 'Lớp đã thay đổi. Vui lòng tải lại');
