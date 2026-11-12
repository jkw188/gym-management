// Tầng nghiệp vụ (US-30 bước 1): TraineeQueryService – PT tra cứu học viên của chính mình (chỉ đọc).
// Học viên suy từ booking thật: có ít nhất một buổi BOOKED hoặc COMPLETED với PT; không có bảng phân công thủ công.
import { Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { ServerClock } from '../../common/utils/business-date';
import { PtBookingStatus } from '../bookings/schemas/pt-booking.schema';
import { toTraineeListItem } from './trainees.mapper';
import { TraineesQueryDto } from './trainees.dto';
import { TraineesRepository } from './trainees.repository';
import { TraineeListResponse } from './trainees.types';

// US-30-F01: chỉ BOOKED và COMPLETED tạo quan hệ; chỉ có CANCELLED thì không còn là học viên (US-30-TC02).
// BOOKED đã quá giờ vẫn tính cho đến khi được xử lý (US-30-TC11).
const RELATION_STATUSES: PtBookingStatus[] = ['BOOKED', 'COMPLETED'];

@Injectable()
export class TraineeQueryService {
  constructor(
    private readonly repository: TraineesRepository,
    private readonly clock: ServerClock,
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
      trainerId,
      relationStatuses: RELATION_STATUSES,
      // "Sắp tới" tính theo giờ server, không theo đồng hồ máy người dùng. GET chỉ đọc, không đổi trạng thái buổi (US-30-TC11).
      now: this.clock.now(),
      // q rỗng sau khi trim thì coi như không tìm.
      search: query.q ? query.q : undefined,
      hasUpcoming: query.hasUpcoming,
      page: query.page,
      limit: query.limit,
    });
    return {
      profileLinked: true,
      items: rows.map(toTraineeListItem),
      page: query.page,
      limit: query.limit,
      total,
      // Rỗng thì totalPages = 0 (Math.ceil(0 / limit) = 0).
      totalPages: Math.ceil(total / query.limit),
    };
  }
}
