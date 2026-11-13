// Tầng nghiệp vụ (US-24 bước 2, US-25 bước 2): PT tạo, sửa, xem, công bố và hủy ca của chính mình.
// Mỗi lệnh ghi chạy trong MỘT transaction: khóa lịch S04-G01 (DataGuardsService) → tìm PT → kiểm luật → ghi ca → audit → operation_requests (EN-02).
import { Injectable } from '@nestjs/common';
import { ClientSession } from 'mongodb';
import { Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { DataGuardsService } from '../../infrastructure/transaction/data-guards.service';
import { IdempotencyService, WorkResult } from '../operations/idempotency.service';
import { Operation } from '../operations/schemas/operation-request.schema';
import { ShiftSnapshot } from './schemas/shift-event.schema';
import { WorkShift } from './schemas/work-shift.schema';
import { ShiftIntervalService } from './shift-interval.service';
import { ShiftTransitionService } from './shift-transition.service';
import { CancelShiftDto, ConfirmShiftDto, CreateShiftDto, ShiftListQueryDto, UpdateShiftDto } from './shifts.dto';
import { toShiftResponse } from './shifts.mapper';
import { ShiftsRepository, TrainerProfile } from './shifts.repository';
import { ShiftDetail, ShiftPage } from './shifts.types';

const OBJECT_ID = /^[0-9a-f]{24}$/i;

@Injectable()
export class ShiftsService {
  constructor(
    private readonly repository: ShiftsRepository,
    private readonly interval: ShiftIntervalService,
    private readonly transition: ShiftTransitionService,
    private readonly idempotency: IdempotencyService,
    // US-28-G02: writer ca lấy cùng khóa lịch schedule_guards với đặt lịch PT (S04-G01), không tự upsert guard riêng.
    private readonly guards: DataGuardsService,
  ) {}

  // POST /api/me/work-shifts: tạo ca SCHEDULED version 0 thuộc PT của principal (US-24-TC01).
  async create(accountId: string, dto: CreateShiftDto, clientKey: string) {
    // US-24-TC03, US-24-TC04: sai định dạng thì 400 ngay, chưa mở transaction nên không ghi gì.
    const draft = this.interval.parseDraft(dto);
    const actorId = new Types.ObjectId(accountId);

    return this.idempotency.execute(
      { actorId: accountId, operation: 'SHIFT_CREATE', clientKey, payload: { ...draft } },
      async (session): Promise<WorkResult> => {
        // US-24-TC03: kiểm "bắt đầu ở tương lai" TRONG callback: callback chỉ chạy khi key chưa có kết quả,
        // nên gửi lại cùng key sau giờ bắt đầu vẫn nhận 201 gốc (US-24-TC10, EN-02). Lấy giờ server ở mỗi lần chạy.
        this.interval.assertFutureStart(draft.startAt, new Date());
        // US-24-F05: tăng guard TRƯỚC khi kiểm chồng ca (US-24-TC09).
        await this.guards.acquire(session, { schedule: true });
        const trainer = await this.requireActiveTrainer(actorId, session);
        // US-24-TC05: chồng ca còn hiệu lực của chính PT → 409. Lớp PUBLISHED không chặn (US-24-TC08).
        if (await this.repository.hasOverlap(trainer._id, draft, null, session)) throw overlap();

        const shift = await this.repository.insertShift(trainer._id, draft, actorId, session);
        await this.repository.insertEvent({
          shiftId: shift._id, actorId, action: 'CREATED', after: snapshotOf(shift),
          occurredAt: new Date(), requestKey: requestKey('SHIFT_CREATE', accountId, clientKey),
        }, session);
        // US-24-TC01: ca nháp chưa công bố nên KHÔNG tạo thông báo cho Member.
        const body = toShiftResponse(shift);
        return { status: 201, body: { ...body }, resultIds: { shiftId: shift._id } };
      },
    );
  }

  // PATCH /api/me/work-shifts/:id: sửa ca nháp chưa bắt đầu, đúng version (US-24-F04).
  async update(accountId: string, shiftId: string, dto: UpdateShiftDto, clientKey: string) {
    const id = parseShiftId(shiftId);
    // US-24-TC03: sai định dạng thì 400, ca giữ nguyên.
    const draft = this.interval.parseDraft(dto);
    const actorId = new Types.ObjectId(accountId);

    return this.idempotency.execute(
      // Hash gồm resourceId (targetId) và version theo mục idempotency của spec.
      { actorId: accountId, operation: 'SHIFT_UPDATE', clientKey, payload: { ...draft, version: dto.version }, targetId: shiftId },
      async (session): Promise<WorkResult> => {
        // Giống create: kiểm giờ mới TRONG callback để gửi lại cùng key vẫn nhận 200 gốc (EN-02).
        this.interval.assertFutureStart(draft.startAt, new Date());
        await this.guards.acquire(session, { schedule: true });
        const trainer = await this.requireActiveTrainer(actorId, session);
        // US-24-TC02: ca của PT khác hoặc không tồn tại → 404, không lộ ca đó có hay không.
        const current = await this.repository.findOwnShift(id, trainer._id, session);
        if (!current) throw notFound();

        // US-24-TC07: chỉ sửa ca SCHEDULED chưa bắt đầu; CONFIRMED/COMPLETED/CANCELLED bất biến ở route này.
        // Lấy giờ server ở mỗi lần chạy (driver có thể chạy lại callback).
        if (current.status !== 'SCHEDULED' || current.start_at.getTime() <= Date.now()) {
          throw new ApplicationError(409, 'SHIFT_NOT_EDITABLE', 'Chỉ sửa được ca nháp chưa bắt đầu');
        }
        // US-24-TC10: client đang xem bản cũ → 409, giao diện cho tải lại ca.
        if (current.version !== dto.version) throw versionConflict();
        // US-24-TC07: nháp có BOOKED là dữ liệu bất thường, chặn để đối chiếu, không đổi giờ.
        if (await this.repository.hasBookedReferences(id, session)) {
          throw new ApplicationError(409, 'SHIFT_HAS_BOOKINGS', 'Ca đang có lịch đặt, không thể sửa');
        }
        // US-24-TC05, US-24-TC06: kiểm chồng với ca khác, loại chính ca đang sửa.
        if (await this.repository.hasOverlap(trainer._id, draft, id, session)) throw overlap();

        // US-24-TC10: CAS theo version; null nghĩa là đã có người ghi trước.
        const updated = await this.repository.updateDraft(id, dto.version, draft, actorId, session);
        if (!updated) throw versionConflict();
        await this.repository.insertEvent({
          shiftId: id, actorId, action: 'UPDATED', before: snapshotOf(current), after: snapshotOf(updated),
          occurredAt: new Date(), requestKey: requestKey('SHIFT_UPDATE', accountId, clientKey),
        }, session);
        return { status: 200, body: { ...toShiftResponse(updated) }, resultIds: { shiftId: id } };
      },
    );
  }

  // POST /api/me/work-shifts/:id/confirm: công bố ca nháp SCHEDULED → CONFIRMED (US-25-F01).
  async confirm(accountId: string, shiftId: string, dto: ConfirmShiftDto, clientKey: string) {
    const id = parseShiftId(shiftId);
    const actorId = new Types.ObjectId(accountId);

    return this.idempotency.execute(
      // Hash gồm resourceId (targetId) và version.
      { actorId: accountId, operation: 'SHIFT_CONFIRM', clientKey, payload: { version: dto.version }, targetId: shiftId },
      async (session): Promise<WorkResult> => {
        // US-25-F04: tăng guard TRƯỚC khi kiểm trạng thái và chồng ca.
        await this.guards.acquire(session, { schedule: true });
        // US-25-TC02: recheck hồ sơ PT ở mỗi lệnh, không dùng dữ liệu form cũ.
        const trainer = await this.requireActiveTrainer(actorId, session);
        // US-25-TC02: ca của PT khác hoặc không tồn tại → 404.
        const current = await this.repository.findOwnShift(id, trainer._id, session);
        if (!current) throw notFound();

        // US-25-TC01, US-25-TC03: luật trạng thái và giờ; lấy giờ server ở mỗi lần chạy callback.
        const plan = this.transition.planConfirm(toTransitionShift(current), new Date());
        // US-25-TC03: client đang xem bản cũ → 409.
        if (current.version !== dto.version) throw versionConflict();
        // US-25-F01: ca không được chồng ca còn hiệu lực khác của cùng PT (loại chính ca này).
        const interval = { startAt: current.start_at, endAt: current.end_at, location: current.location };
        if (await this.repository.hasOverlap(trainer._id, interval, id, session)) throw overlap();

        // US-25-TC10: CAS theo version; null nghĩa là lệnh khác đã ghi trước.
        const updated = await this.repository.confirmShift(id, dto.version, plan, actorId, session);
        if (!updated) throw versionConflict();
        await this.repository.insertEvent({
          shiftId: id, actorId, action: 'CONFIRMED', before: snapshotOf(current), after: snapshotOf(updated),
          occurredAt: plan.updatedAt, requestKey: requestKey('SHIFT_CONFIRM', accountId, clientKey),
        }, session);
        // US-25-F05: công bố không gửi broadcast cho Member.
        return { status: 200, body: { ...toShiftResponse(updated) }, resultIds: { shiftId: id } };
      },
    );
  }

  // POST /api/me/work-shifts/:id/cancel: hủy ca SCHEDULED/CONFIRMED chưa bắt đầu, không còn BOOKED (US-25-F02).
  async cancel(accountId: string, shiftId: string, dto: CancelShiftDto, clientKey: string) {
    const id = parseShiftId(shiftId);
    // US-25-TC04: lý do sai → 400 ngay, chưa mở transaction nên không ghi key.
    const reason = this.transition.normalizeReason(dto.reason);
    const actorId = new Types.ObjectId(accountId);

    return this.idempotency.execute(
      // Hash gồm resourceId, version và lý do đã trim.
      { actorId: accountId, operation: 'SHIFT_CANCEL', clientKey, payload: { version: dto.version, reason }, targetId: shiftId },
      async (session): Promise<WorkResult> => {
        // US-25-F04: guard trước khi kiểm trạng thái và đếm BOOKED, để booking song song phải chờ (US-25-TC09).
        await this.guards.acquire(session, { schedule: true });
        const trainer = await this.requireActiveTrainer(actorId, session);
        const current = await this.repository.findOwnShift(id, trainer._id, session);
        if (!current) throw notFound();

        // US-25-TC05: đếm BOOKED trong cùng transaction, không tin số liệu GET trước đó.
        const bookedCount = await this.repository.countBookedReferences(id, session);
        // US-25-TC04, US-25-TC05, US-25-TC07: luật trạng thái, giờ và BOOKED.
        const plan = this.transition.planCancel(toTransitionShift(current), { reason, bookedCount }, new Date());
        if (current.version !== dto.version) throw versionConflict();

        // US-25-TC10: CAS theo version. Không tự hủy booking hay trả quota (US-25-TC05).
        const updated = await this.repository.cancelShift(id, dto.version, plan, actorId, session);
        if (!updated) throw versionConflict();
        await this.repository.insertEvent({
          shiftId: id, actorId, action: 'CANCELLED', before: snapshotOf(current), after: snapshotOf(updated), reason,
          occurredAt: plan.updatedAt, requestKey: requestKey('SHIFT_CANCEL', accountId, clientKey),
        }, session);
        // US-25-F05: ca đã trống BOOKED nên không phát thông báo hủy ca cho Member.
        return { status: 200, body: { ...toShiftResponse(updated) }, resultIds: { shiftId: id } };
      },
    );
  }

  // GET /api/me/work-shifts/:id: chỉ ca của chính PT (US-24-TC02), kèm bookedCount (US-25).
  async getOwn(accountId: string, shiftId: string): Promise<ShiftDetail> {
    const id = parseShiftId(shiftId);
    const trainer = await this.repository.findTrainerByAccount(new Types.ObjectId(accountId));
    // Chưa có hồ sơ PT thì không có ca nào thuộc mình → 404.
    if (!trainer) throw notFound();
    const shift = await this.repository.findOwnShift(id, trainer._id);
    if (!shift) throw notFound();
    // US-25-TC05, US-25-TC08: chỉ đếm BOOKED; booking CANCELLED/COMPLETED là lịch sử, không chặn.
    const bookedCount = await this.repository.countBookedReferences(id);
    return { ...toShiftResponse(shift), bookedCount };
  }

  // GET /api/me/work-shifts: lịch của chính PT theo khoảng ngày Việt Nam, có phân trang.
  async listOwn(accountId: string, query: ShiftListQueryDto): Promise<ShiftPage> {
    // US-24-TC03: ngày không có thật hoặc quá 31 ngày → 400.
    const range = this.interval.vietnamDateRange(query.fromDate, query.toDate, new Date());
    const trainer = await this.repository.findTrainerByAccount(new Types.ObjectId(accountId));
    // US-24-TC02: account TRAINER chưa liên kết hồ sơ PT → 200 profileLinked=false, danh sách rỗng.
    if (!trainer) return { profileLinked: false, items: [], page: query.page, limit: query.limit, total: 0, totalPages: 0 };

    const { items, total } = await this.repository.listOwn(trainer._id, range, query.status, query.page, query.limit);
    return {
      profileLinked: true,
      items: items.map(toShiftResponse),
      page: query.page,
      limit: query.limit,
      total,
      // Danh sách rỗng thì totalPages = 0.
      totalPages: Math.ceil(total / query.limit),
    };
  }

  // US-24-F01, US-24-TC02: PT phải có hồ sơ và đang ACTIVE mới được ghi ca.
  private async requireActiveTrainer(accountId: Types.ObjectId, session: ClientSession): Promise<TrainerProfile> {
    const trainer = await this.repository.findTrainerByAccount(accountId, session);
    if (!trainer) throw new ApplicationError(409, 'PROFILE_REQUIRED', 'Tài khoản chưa có hồ sơ PT');
    if (trainer.status !== 'ACTIVE') throw new ApplicationError(409, 'TRAINER_UNAVAILABLE', 'Hồ sơ PT đang ngừng hoạt động');
    return trainer;
  }
}

// Id sai định dạng là dữ liệu sai → 400; đúng định dạng mà không thuộc mình → 404.
function parseShiftId(value: string): Types.ObjectId {
  if (!OBJECT_ID.test(value)) throw new ApplicationError(400, 'INVALID_ID', 'Mã ca không hợp lệ');
  return new Types.ObjectId(value);
}

// shift_events.request_key: mỗi lệnh (thao tác + người gửi + key) chỉ có một audit.
function requestKey(operation: Operation, accountId: string, clientKey: string): string {
  return `${operation}:${accountId}:${clientKey}`;
}

// Đổi document ca sang đầu vào của ShiftTransitionService (tên field camelCase).
function toTransitionShift(shift: WorkShift) {
  return { status: shift.status, startAt: shift.start_at, endAt: shift.end_at, version: shift.version };
}

// Ảnh chụp ca lưu vào before/after của audit.
function snapshotOf(shift: WorkShift): ShiftSnapshot {
  return { start_at: shift.start_at, end_at: shift.end_at, location: shift.location, status: shift.status, version: shift.version };
}

const notFound = () => new ApplicationError(404, 'SHIFT_NOT_FOUND', 'Không tìm thấy ca làm việc');
const overlap = () => new ApplicationError(409, 'SHIFT_OVERLAP', 'Ca bị trùng giờ với một ca khác của bạn');
const versionConflict = () => new ApplicationError(409, 'VERSION_CONFLICT', 'Ca đã được thay đổi. Vui lòng tải lại');
