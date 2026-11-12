// Tầng nghiệp vụ (US-30 bước 1–2): TraineeQueryService – PT tra cứu học viên của chính mình (chỉ đọc).
// Học viên suy từ booking thật: có ít nhất một buổi BOOKED hoặc COMPLETED với PT; không có bảng phân công thủ công.
// Bước 2: hồ sơ tối thiểu, lịch riêng của PT và gói liên quan; quan hệ được kiểm lại ở MỖI request (US-30-F04).
import { Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { ServerClock } from '../../common/utils/business-date';
import { PT_BOOKING_STATUSES, PtBookingStatus } from '../bookings/schemas/pt-booking.schema';
import { MeMembershipsRepository } from '../memberships/me-memberships.repository';
import { availableSessions } from '../memberships/me-memberships.service';
import { ShiftIntervalService } from '../shifts/shift-interval.service';
import { toTraineeBookingItem, toTraineeDetail, toTraineeListItem, toTraineeMembershipItem } from './trainees.mapper';
import { TraineeBookingsQueryDto, TraineeMembershipsQueryDto, TraineesQueryDto } from './trainees.dto';
import { TraineesRepository } from './trainees.repository';
import {
  TraineeBookingItem, TraineeDetail, TraineeListResponse, TraineeMembershipItem, TraineeMembershipPage, TraineePage,
  TraineeRelationFilter, TraineeRow,
} from './trainees.types';

// US-30-F01: chỉ BOOKED và COMPLETED tạo quan hệ; chỉ có CANCELLED thì không còn là học viên (US-30-TC02).
// BOOKED đã quá giờ vẫn tính cho đến khi được xử lý (US-30-TC11).
const RELATION_STATUSES: PtBookingStatus[] = ['BOOKED', 'COMPLETED'];
// US-30-F02, TC01, TC05: buổi "sắp tới" là buổi BOOKED chưa tới giờ bắt đầu → nextBookingAt, hasUpcoming.
const UPCOMING_STATUS: PtBookingStatus = 'BOOKED';
// US-30-F02, TC01: buổi "đã hoàn tất" là buổi COMPLETED → lastCompletedAt.
const COMPLETED_STATUS: PtBookingStatus = 'COMPLETED';
// US-30-F03 (cùng luật US-17-F03): chỉ buổi BOOKED giữ chỗ quota; COMPLETED đã nằm trong sessions_used, CANCELLED trả lại buổi.
const RESERVED_STATUS: PtBookingStatus = 'BOOKED';

const OBJECT_ID = /^[0-9a-f]{24}$/i;

// US-30-TC02, TC03, TC04: không quan hệ, memberId không tồn tại, PT chưa link đều trả CÙNG một lỗi để không lộ ai có trong hệ thống.
const notFound = () => new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy học viên');

// Kết quả kiểm quan hệ: PT, học viên và dòng quan hệ vừa đọc.
interface Relation {
  trainerId: Types.ObjectId;
  memberId: Types.ObjectId;
  trainee: TraineeRow;
}

@Injectable()
export class TraineeQueryService {
  constructor(
    private readonly repository: TraineesRepository,
    private readonly clock: ServerClock,
    // Dùng lại luật đổi ngày VN → khoảng UTC (ngày có thật, tối đa 31 ngày, mặc định tuần này) như US-27.
    private readonly interval: ShiftIntervalService,
    // Dùng CHUNG nguồn quota của US-17 (gói, sale, giao dịch, đếm BOOKED), không viết lại truy vấn.
    private readonly memberships: MeMembershipsRepository,
  ) {}

  // GET /api/me/trainees: US-30-TC01 đến TC05, TC08, TC11.
  async listOwn(accountId: string, query: TraineesQueryDto): Promise<TraineeListResponse> {
    // Không nhận trainerId từ client: PT lấy từ account đang đăng nhập (US-30-TC03).
    const trainerId = await this.repository.findTrainerIdOfAccount(new Types.ObjectId(accountId));
    // US-30-TC04: account TRAINER chưa có hồ sơ PT → danh sách rỗng kèm cờ profileLinked=false.
    if (!trainerId) {
      return { profileLinked: false, items: [], page: query.page, limit: query.limit, total: 0, totalPages: 0 };
    }
    const { rows, total } = await this.repository.findTrainees({
      ...this.relationFilter(trainerId),
      // q rỗng sau khi trim thì coi như không tìm.
      search: query.q ? query.q : undefined,
      hasUpcoming: query.hasUpcoming,
      page: query.page,
      limit: query.limit,
    });
    return { profileLinked: true, ...toPage(rows.map(toTraineeListItem), query.page, query.limit, total) };
  }

  // GET /api/me/trainees/:memberId: US-30-TC02, TC03, TC04, TC08, TC11 – hồ sơ tối thiểu.
  async getOwnTrainee(accountId: string, memberId: string): Promise<TraineeDetail> {
    const relation = await this.requireRelation(accountId, parseMemberId(memberId));
    return toTraineeDetail(relation.trainee);
  }

  // GET /api/me/trainees/:memberId/bookings: US-30-TC05, TC10, TC11 – chỉ buổi do chính PT dạy.
  async listTraineeBookings(accountId: string, memberId: string, query: TraineeBookingsQueryDto): Promise<TraineePage<TraineeBookingItem>> {
    const id = parseMemberId(memberId);
    // US-30-TC05: ngày sai, toDate trước fromDate hoặc quá 31 ngày → 400.
    const range = this.interval.vietnamDateRange(query.fromDate, query.toDate, this.clock.now());
    const relation = await this.requireRelation(accountId, id);
    // Không gửi status thì lấy cả ba trạng thái: CANCELLED cũ vẫn xem được khi quan hệ còn hợp lệ (spec mục 2).
    const statuses = query.status ? [query.status] : PT_BOOKING_STATUSES;
    const { rows, total } = await this.repository.findBookingsPage(
      { trainerId: relation.trainerId, memberId: relation.memberId, statuses, from: range.from, to: range.to },
      query.page, query.limit,
    );
    return toPage(rows.map(toTraineeBookingItem), query.page, query.limit, total);
  }

  // GET /api/me/trainees/:memberId/memberships: US-30-TC06, TC07, TC10, TC11 – chỉ gói có booking BOOKED/COMPLETED với chính PT.
  async listTraineeMemberships(accountId: string, memberId: string, query: TraineeMembershipsQueryDto): Promise<TraineeMembershipPage> {
    const relation = await this.requireRelation(accountId, parseMemberId(memberId));
    const asOf = this.clock.now();
    // US-30-TC07: gói GYM, gói chỉ có buổi với PT khác hoặc chỉ có CANCELLED không có booking hợp lệ với PT nên không vào danh sách.
    const { ids, total } = await this.repository.findRelatedMembershipIds(
      relation.trainerId, relation.memberId, RELATION_STATUSES, query.page, query.limit,
    );
    const items = await this.toMembershipItems(relation.memberId, ids);
    return { ...toPage(items, query.page, query.limit, total), asOf: asOf.toISOString() };
  }

  // US-30-F03: dựng quota cho các gói trên trang. Chỉ 4 truy vấn cho cả trang, không truy vấn lặp từng gói.
  private async toMembershipItems(memberId: Types.ObjectId, ids: Types.ObjectId[]): Promise<TraineeMembershipItem[]> {
    const memberships = await this.memberships.findMembershipsByIds(ids);
    // Sale đọc kèm điều kiện member_id: gói phải thuộc đúng học viên này.
    const sales = await this.memberships.findSalesByIds(memberId, memberships.map(item => item.service_sale_id));
    // Loại gói (GYM/PT) lấy từ giao dịch của sale, chốt lúc bán.
    const transactions = await this.memberships.findOwnTransactionsByIds(memberId, sales.map(sale => sale.transaction_id));
    // US-30-TC06: reserved đếm BOOKED của TOÀN gói, kể cả buổi với PT khác, để không nói sai số còn lại.
    // Chỉ trả con số, không trả tên hay lịch của PT khác.
    const reservedCounts = await this.memberships.countBookingsByStatus(ids, RESERVED_STATUS);

    const items: TraineeMembershipItem[] = [];
    // Giữ đúng thứ tự trang (gói mới trước) theo danh sách ids.
    for (const id of ids) {
      const membership = memberships.find(item => item._id.equals(id));
      const sale = membership ? sales.find(item => item._id.equals(membership.service_sale_id)) : undefined;
      if (!membership || !sale) continue;
      const transaction = transactions.find(item => item._id.equals(sale.transaction_id));
      const reserved = reservedCounts.get(id.toHexString()) ?? 0;
      items.push(toTraineeMembershipItem(membership, sale, {
        kind: transaction?.kind,
        reserved,
        // US-30-TC10: chỉ dùng used của chính gói này, không cộng used của gói SUPERSEDED (cùng công thức US-17).
        available: availableSessions(Number(sale.sessions_snapshot), Number(membership.sessions_used), reserved),
      }));
    }
    return items;
  }

  // US-30-F04: kiểm quan hệ ở MỖI request (không dựa vào lần mở trang trước). Không có quan hệ → 404.
  // memberId đã được parseMemberId kiểm định dạng ở hàm gọi.
  private async requireRelation(accountId: string, id: Types.ObjectId): Promise<Relation> {
    const trainerId = await this.repository.findTrainerIdOfAccount(new Types.ObjectId(accountId));
    // US-30-TC04: PT chưa link không có học viên nào.
    if (!trainerId) throw notFound();
    const trainee = await this.repository.findTrainee(this.relationFilter(trainerId), id);
    // US-30-TC02, TC03: chưa từng có booking, chỉ CANCELLED, chỉ có buổi với PT khác, hoặc memberId không tồn tại.
    if (!trainee) throw notFound();
    return { trainerId, memberId: id, trainee };
  }

  // Luật quan hệ dùng chung cho danh sách và kiểm từng học viên.
  private relationFilter(trainerId: Types.ObjectId): TraineeRelationFilter {
    return {
      trainerId,
      relationStatuses: RELATION_STATUSES,
      upcomingStatus: UPCOMING_STATUS,
      // "Sắp tới" tính từ giờ server, không theo đồng hồ máy người dùng. GET chỉ đọc, không đổi trạng thái buổi (US-30-TC11).
      upcomingFrom: this.clock.now(),
      completedStatus: COMPLETED_STATUS,
    };
  }
}

// US-30-TC03: memberId sai định dạng là dữ liệu sai → 400; đúng định dạng mà không có quan hệ → 404.
function parseMemberId(value: string): Types.ObjectId {
  if (!OBJECT_ID.test(value)) throw new ApplicationError(400, 'INVALID_ID', 'Mã học viên không hợp lệ');
  return new Types.ObjectId(value);
}

// Spec mục 2: {items, page, limit, total, totalPages}; rỗng thì totalPages = 0 (Math.ceil(0 / limit) = 0).
function toPage<T>(items: T[], page: number, limit: number, total: number): TraineePage<T> {
  return { items, page, limit, total, totalPages: Math.ceil(total / limit) };
}
