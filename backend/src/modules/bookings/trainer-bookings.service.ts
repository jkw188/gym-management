// Tầng nghiệp vụ (US-64 bước 4): PT xem danh sách buổi dạy của chính mình theo ngày VN (chỉ đọc).
// Server quyết định PT được làm gì với từng buổi (permittedActions) theo giờ server, UI chỉ hiển thị theo đó.
import { Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { ServerClock } from '../../common/utils/business-date';
import { ShiftIntervalService } from '../shifts/shift-interval.service';
import { canComplete } from './complete-booking.service';
import { PtBooking } from './schemas/pt-booking.schema';
import { toTrainerBookingItem } from './trainer-bookings.mapper';
import { TrainerBookingsQueryDto } from './trainer-bookings.dto';
import { TrainerBookingsRepository } from './trainer-bookings.repository';
import { TrainerBookingAction, TrainerBookingItem } from './trainer-bookings.types';

@Injectable()
export class TrainerBookingsService {
  constructor(
    private readonly repository: TrainerBookingsRepository,
    // Dùng lại luật đổi ngày VN → khoảng UTC (ngày có thật, toDate ≥ fromDate, tối đa 31 ngày) như US-27.
    private readonly interval: ShiftIntervalService,
    private readonly clock: ServerClock,
  ) {}

  // GET /api/me/trainer-bookings: US-64-TC15.
  async listOwn(accountId: string, query: TrainerBookingsQueryDto): Promise<{ items: TrainerBookingItem[] }> {
    const now = this.clock.now();
    const range = this.interval.vietnamDateRange(query.fromDate, query.toDate, now);
    // Không nhận trainerId từ client: PT lấy từ account đang đăng nhập. Account chưa có hồ sơ PT thì không có buổi nào.
    const trainerId = await this.repository.findTrainerIdOfAccount(new Types.ObjectId(accountId));
    if (!trainerId) return { items: [] };
    const rows = await this.repository.findForTrainer({ trainerId, from: range.from, to: range.to, status: query.status });
    return { items: rows.map(row => toTrainerBookingItem(row, this.permittedActions(row, now))) };
  }

  // US-64-F01, US-64-TC15: dùng CHUNG luật canComplete với lệnh ghi, không tự viết lại điều kiện.
  private permittedActions(booking: PtBooking, now: Date): TrainerBookingAction[] {
    return canComplete(booking, now) ? ['COMPLETE'] : [];
  }
}
