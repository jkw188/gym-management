// Tầng nghiệp vụ (US-29 bước 3): Staff/Admin tra cứu danh sách và chi tiết lịch PT để hỗ trợ (chỉ đọc).
// Quyền ptBookings.readSupport do controller kiểm; service đổi ngày VN → khoảng UTC và chọn bộ lọc. Hủy hỗ trợ ở CancelBookingService.
import { Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { ServerClock } from '../../common/utils/business-date';
import { ShiftIntervalService } from '../shifts/shift-interval.service';
import { toSupportPtBookingItem } from './support-pt-bookings.mapper';
import { SupportPtBookingsQueryDto } from './support-pt-bookings.dto';
import { SupportPtBookingsRepository } from './support-pt-bookings.repository';
import { SupportBookingFilter, SupportPtBookingItem, SupportPtBookingPage } from './support-pt-bookings.types';

const OBJECT_ID = /^[0-9a-f]{24}$/i;

@Injectable()
export class SupportPtBookingsService {
  constructor(
    private readonly repository: SupportPtBookingsRepository,
    // Dùng lại luật đổi ngày Việt Nam → khoảng UTC (ngày có thật, tối đa 31 ngày, mặc định tuần này) như US-27.
    private readonly interval: ShiftIntervalService,
    private readonly clock: ServerClock,
  ) {}

  // GET /api/pt-bookings: US-29-TC05 – lọc ngày + memberId/trainerId/status tùy chọn; ngày sai, ngược hoặc > 31 ngày → 400.
  async list(query: SupportPtBookingsQueryDto): Promise<SupportPtBookingPage> {
    const range = this.interval.vietnamDateRange(query.fromDate, query.toDate, this.clock.now());
    const filter: SupportBookingFilter = {
      from: range.from,
      to: range.to,
      memberId: query.memberId ? new Types.ObjectId(query.memberId) : undefined,
      trainerId: query.trainerId ? new Types.ObjectId(query.trainerId) : undefined,
      status: query.status,
    };
    const rows = await this.repository.findPage(filter, (query.page - 1) * query.limit, query.limit);
    const total = await this.repository.count(filter);
    return {
      items: rows.map(toSupportPtBookingItem),
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  // GET /api/pt-bookings/:id: US-29-TC05 – chi tiết có version hiện tại và memberId để hủy hỗ trợ.
  async detail(bookingId: string): Promise<SupportPtBookingItem> {
    // ID sai định dạng là dữ liệu sai → 400 (như US-27); đúng định dạng mà không có → 404.
    if (!OBJECT_ID.test(bookingId)) throw new ApplicationError(400, 'INVALID_ID', 'Mã buổi PT không hợp lệ');
    const row = await this.repository.findById(new Types.ObjectId(bookingId));
    if (!row) throw new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy buổi PT');
    return toSupportPtBookingItem(row);
  }
}
