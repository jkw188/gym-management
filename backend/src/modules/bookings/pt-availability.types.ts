// Tầng kiểu dữ liệu (US-27 bước 1): dữ liệu API Member xem danh mục PT và slot trống (camelCase, thời điểm ISO UTC).
// Chỉ gồm field Member được xem; không có accountId, phone, email của PT (US-27-F01).
import { Types } from 'mongoose';

// Một PT trong danh mục cho Member chọn.
export interface PtTrainerItem {
  id: string;
  displayName: string;
  specialty: string;
}

// Spec mục 2: list trả {items,page,limit,total,totalPages}.
export interface PtTrainerPage {
  items: PtTrainerItem[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

// Lý do một slot chưa đặt được (US-27-F04). MEMBERSHIP_NOT_ELIGIBLE, QUOTA_EXHAUSTED dùng chung mã lỗi 409 của US-28.
export type SlotReason = 'MEMBERSHIP_REQUIRED' | 'MEMBERSHIP_NOT_ELIGIBLE' | 'QUOTA_EXHAUSTED';

// Một slot 60 phút sinh từ ca. slotId không phải chỗ giữ (US-27-F02): xem slot không giữ chỗ.
export interface PtSlot {
  shiftId: string;
  startAt: string;
  endAt: string;
  location: string;
  bookable: boolean;
  reason?: SlotReason;
}

// GET /api/me/pt-trainers/:id/availability: không phân trang slot.
export interface PtAvailability {
  trainerId: string;
  memberLinked: boolean;
  asOf: string;
  slots: PtSlot[];
}

// Một hàng PT khả dụng đọc từ DB (trainers nối accounts để lấy tên).
export interface AvailableTrainerRow {
  _id: Types.ObjectId;
  display_name: string;
  specialty?: string;
}

// Điều kiện một PT được coi là khả dụng; AvailabilityService quyết định giá trị, repository chỉ dùng để lọc.
export interface TrainerAvailabilityRule {
  trainerStatus: string;
  accountStatus: string;
  roleCode: string;
}

// Khoảng giờ đã bận lấy từ DB (lớp hoặc buổi PT).
export interface BusyTime {
  start_at: Date;
  end_at: Date;
}
