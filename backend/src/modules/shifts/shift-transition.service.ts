// Tầng nghiệp vụ (US-25 bước 1): luật chuyển trạng thái ca làm việc, không đọc/ghi DB.
// Công bố SCHEDULED→CONFIRMED, hủy ca trước giờ bắt đầu, và ca nào mới mở slot nhận booking.
import { Injectable } from '@nestjs/common';
import { ApplicationError, invalidField } from '../../common/errors/application-error';
import { ShiftStatus } from './shifts.types';

// Lý do hủy sau khi trim phải dài 10–500 ký tự (US-25-F02).
const MIN_REASON_LENGTH = 10;
const MAX_REASON_LENGTH = 500;

// Thông tin ca đã đọc từ DB mà luật chuyển trạng thái cần.
export interface TransitionShift {
  status: ShiftStatus | string;
  startAt: Date;
  endAt: Date;
  version: number;
}

// Giá trị mới của ca khi công bố; bước 2 dùng để ghi DB.
export interface ConfirmPlan {
  status: 'CONFIRMED';
  version: number;
  confirmedAt: Date;
  updatedAt: Date;
}

// Giá trị mới của ca khi hủy; bước 2 dùng để ghi DB.
export interface CancelPlan {
  status: 'CANCELLED';
  version: number;
  cancelledAt: Date;
  cancellationReason: string;
  updatedAt: Date;
}

@Injectable()
export class ShiftTransitionService {
  // US-25-F01: chỉ ca nháp SCHEDULED, chưa bắt đầu mới được công bố.
  // Không sửa object shift; chỉ trả giá trị mới để repository ghi ở bước 2.
  planConfirm(shift: TransitionShift, serverNow: Date): ConfirmPlan {
    // US-25-TC03: ca đã CONFIRMED/CANCELLED/COMPLETED không công bố lại.
    if (shift.status !== 'SCHEDULED') {
      throw new ApplicationError(409, 'INVALID_SHIFT_STATE', 'Chỉ công bố được ca nháp');
    }
    // US-25-TC03: startAt phải lớn hơn hẳn giờ server (đúng lúc bắt đầu cũng bị chặn).
    if (shift.startAt.getTime() <= serverNow.getTime()) {
      throw new ApplicationError(409, 'SHIFT_ALREADY_STARTED', 'Ca đã bắt đầu hoặc đã kết thúc');
    }
    // US-25-TC01: CONFIRMED, version tăng 1, thời điểm lấy theo server.
    return {
      status: 'CONFIRMED',
      version: shift.version + 1,
      confirmedAt: serverNow,
      updatedAt: serverNow,
    };
  }

  // US-25-F02, F03: hủy ca SCHEDULED/CONFIRMED trước giờ bắt đầu, có lý do và không còn BOOKED.
  // bookedCount là số booking BOOKED tham chiếu ca, bước 2 đếm trong transaction rồi truyền vào.
  planCancel(shift: TransitionShift, input: { reason: unknown; bookedCount: number }, serverNow: Date): CancelPlan {
    // US-25-TC04: reason phải là chuỗi, sau trim dài 10–500 ký tự.
    if (typeof input.reason !== 'string') {
      invalidField('reason', 'Vui lòng nhập lý do hủy ca');
    }
    const reason = input.reason.trim();
    if (reason.length < MIN_REASON_LENGTH || reason.length > MAX_REASON_LENGTH) {
      invalidField('reason', `Lý do hủy phải dài từ ${MIN_REASON_LENGTH} đến ${MAX_REASON_LENGTH} ký tự`);
    }
    // US-25-TC07: COMPLETED và CANCELLED là trạng thái cuối, không hủy lại.
    if (shift.status !== 'SCHEDULED' && shift.status !== 'CONFIRMED') {
      throw new ApplicationError(409, 'INVALID_SHIFT_STATE', 'Ca này không còn hủy được');
    }
    // US-25-TC07: ca đang diễn ra hoặc đã hết giờ không được hủy, cũng không tự đánh dấu COMPLETED.
    if (serverNow.getTime() >= shift.startAt.getTime()) {
      throw new ApplicationError(409, 'SHIFT_ALREADY_STARTED', 'Ca đã bắt đầu hoặc đã kết thúc');
    }
    // US-25-TC05: còn bất kỳ BOOKED nào (kể cả nháp bất thường) thì chặn, không tự hủy booking.
    if (input.bookedCount > 0) {
      throw new ApplicationError(409, 'SHIFT_HAS_BOOKINGS', 'Ca còn lịch đặt, cần hủy từng lịch trước khi hủy ca');
    }
    // US-25-TC04: CANCELLED, version tăng 1, lưu lý do đã trim.
    return {
      status: 'CANCELLED',
      version: shift.version + 1,
      cancelledAt: serverNow,
      cancellationReason: reason,
      updatedAt: serverNow,
    };
  }

  // US-25-TC01, TC04, TC07: chỉ ca CONFIRMED chưa kết thúc mới cung cấp slot cho booking.
  offersSlots(shift: TransitionShift, serverNow: Date): boolean {
    return shift.status === 'CONFIRMED' && serverNow.getTime() < shift.endAt.getTime();
  }
}
