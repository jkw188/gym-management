// Tầng kiểu dữ liệu (US-30 bước 1–2): đổi dữ liệu repository thành dữ liệu trả cho PT (danh sách, hồ sơ, lịch, gói).
// Chỉ chép field trong hợp đồng US-30-F02, F03; không thêm thông tin liên hệ, tiền hay tên PT khác.
import { PtBooking } from '../bookings/schemas/pt-booking.schema';
import { Membership } from '../memberships/schemas/membership.schema';
import { ServiceSale } from '../memberships/schemas/service-sale.schema';
import { TransactionKind } from '../payments/schemas/transaction.schema';
import { TraineeBookingItem, TraineeDetail, TraineeListItem, TraineeMembershipItem, TraineeRow } from './trainees.types';

export function toTraineeListItem(row: TraineeRow): TraineeListItem {
  return {
    memberId: row._id.toHexString(),
    memberCode: row.member_code,
    fullName: row.full_name,
    nextBookingAt: row.next_booking_at ? row.next_booking_at.toISOString() : undefined,
    lastCompletedAt: row.last_completed_at ? row.last_completed_at.toISOString() : undefined,
    relatedBookingCount: row.related_booking_count,
    hasUpcoming: row.next_booking_at ? true : false,
  };
}

// US-30-TC08: hồ sơ tối thiểu đúng 4 field.
export function toTraineeDetail(row: TraineeRow): TraineeDetail {
  return {
    memberId: row._id.toHexString(),
    memberCode: row.member_code,
    fullName: row.full_name,
    hasUpcoming: row.next_booking_at ? true : false,
  };
}

// US-30-TC05: một buổi của chính PT; địa điểm lấy snapshot lúc đặt.
export function toTraineeBookingItem(booking: PtBooking): TraineeBookingItem {
  return {
    id: booking._id.toHexString(),
    membershipId: booking.membership_id.toHexString(),
    startAt: booking.start_at.toISOString(),
    endAt: booking.end_at.toISOString(),
    status: booking.status,
    location: booking.location_snapshot ?? '',
    completedAt: booking.status === 'COMPLETED' ? booking.completed_at?.toISOString() : undefined,
  };
}

// Số liệu quota do service tính rồi truyền vào; mapper chỉ chép.
export interface MembershipQuota {
  kind?: TransactionKind;
  reserved: number;
  available: number;
  quotaInvalid: boolean;
}

// US-30-TC06, TC10: một gói liên quan; quota theo snapshot của sale đã bán, sessionsUsed của chính gói này.
export function toTraineeMembershipItem(membership: Membership, sale: ServiceSale, quota: MembershipQuota): TraineeMembershipItem {
  return {
    id: membership._id.toHexString(),
    kind: quota.kind,
    storedStatus: membership.status,
    startDate: sale.start_date,
    endDate: sale.end_date,
    quota: Number(sale.sessions_snapshot),
    sessionsUsed: Number(membership.sessions_used),
    reserved: quota.reserved,
    available: quota.available,
    quotaInvalid: quota.quotaInvalid,
  };
}
