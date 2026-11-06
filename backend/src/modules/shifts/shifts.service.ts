// Tầng nghiệp vụ (US-24 bước 2): PT tạo, sửa, xem ca nháp của chính mình.
// Mỗi lệnh ghi chạy trong MỘT transaction: guard S04-G01 → tìm PT → kiểm luật → ghi ca → audit → operation_requests (EN-02).
import { Injectable } from '@nestjs/common';
import { ClientSession } from 'mongodb';
import { Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { IdempotencyService, WorkResult } from '../operations/idempotency.service';
import { Operation } from '../operations/schemas/operation-request.schema';
import { ShiftSnapshot } from './schemas/shift-event.schema';
import { WorkShift } from './schemas/work-shift.schema';
import { ShiftIntervalService } from './shift-interval.service';
import { CreateShiftDto, ShiftListQueryDto, UpdateShiftDto } from './shifts.dto';
import { toShiftResponse } from './shifts.mapper';
import { ShiftsRepository, TrainerProfile } from './shifts.repository';
import { ShiftPage, ShiftResponse } from './shifts.types';

const OBJECT_ID = /^[0-9a-f]{24}$/i;

@Injectable()
export class ShiftsService {
  constructor(
    private readonly repository: ShiftsRepository,
    private readonly interval: ShiftIntervalService,
    private readonly idempotency: IdempotencyService,
  ) {}

  // POST /api/me/work-shifts: tạo ca SCHEDULED version 0 thuộc PT của principal (US-24-TC01).
  async create(accountId: string, dto: CreateShiftDto, clientKey: string) {
    // US-24-TC03, US-24-TC04: dữ liệu sai thì 400 ngay, chưa mở transaction nên không ghi gì.
    const draft = this.interval.validateDraft(dto, new Date());
    const actorId = new Types.ObjectId(accountId);

    return this.idempotency.execute(
      { actorId: accountId, operation: 'SHIFT_CREATE', clientKey, payload: { ...draft } },
      async (session): Promise<WorkResult> => {
        // US-24-F05: tăng guard TRƯỚC khi kiểm chồng ca (US-24-TC09).
        await this.repository.bumpScheduleGuard(session);
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
    // US-24-TC03: dữ liệu sai thì 400, ca giữ nguyên.
    const draft = this.interval.validateDraft(dto, new Date());
    const actorId = new Types.ObjectId(accountId);

    return this.idempotency.execute(
      // Hash gồm resourceId (targetId) và version theo mục idempotency của spec.
      { actorId: accountId, operation: 'SHIFT_UPDATE', clientKey, payload: { ...draft, version: dto.version }, targetId: shiftId },
      async (session): Promise<WorkResult> => {
        await this.repository.bumpScheduleGuard(session);
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

  // GET /api/me/work-shifts/:id: chỉ ca của chính PT (US-24-TC02).
  async getOwn(accountId: string, shiftId: string): Promise<ShiftResponse> {
    const id = parseShiftId(shiftId);
    const trainer = await this.repository.findTrainerByAccount(new Types.ObjectId(accountId));
    // Chưa có hồ sơ PT thì không có ca nào thuộc mình → 404.
    if (!trainer) throw notFound();
    const shift = await this.repository.findOwnShift(id, trainer._id);
    if (!shift) throw notFound();
    return toShiftResponse(shift);
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

// Ảnh chụp ca lưu vào before/after của audit.
function snapshotOf(shift: WorkShift): ShiftSnapshot {
  return { start_at: shift.start_at, end_at: shift.end_at, location: shift.location, status: shift.status, version: shift.version };
}

const notFound = () => new ApplicationError(404, 'SHIFT_NOT_FOUND', 'Không tìm thấy ca làm việc');
const overlap = () => new ApplicationError(409, 'SHIFT_OVERLAP', 'Ca bị trùng giờ với một ca khác của bạn');
const versionConflict = () => new ApplicationError(409, 'VERSION_CONFLICT', 'Ca đã được thay đổi. Vui lòng tải lại');
