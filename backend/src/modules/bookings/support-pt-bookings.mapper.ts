// Tầng kiểu dữ liệu (US-29 bước 3): đổi booking (kèm mã/tên Member) thành dữ liệu tra cứu hỗ trợ trả cho Staff/Admin.
// Chỉ chép field trong hợp đồng; không trả request_key, created_by, cancelled_by hay dữ liệu liên hệ.
// US-64 bước 3: thêm chi tiết Admin (thông tin hoàn tất, nguồn quota, lịch sử booking_events).
import { BookingEvent } from './schemas/booking-event.schema';
import { AdminPtBookingDetail, AdminPtBookingEvent, AdminQuotaSource, SupportPtBookingItem, SupportPtBookingRow } from './support-pt-bookings.types';

// US-29-TC05: tên PT và địa điểm lấy snapshot lúc đặt (giống lịch riêng US-27), mã/tên Member lấy từ hồ sơ hiện tại.
export function toSupportPtBookingItem(row: SupportPtBookingRow): SupportPtBookingItem {
  return {
    id: row._id.toHexString(),
    memberId: row.member_id.toHexString(),
    memberCode: row.member_code ?? '',
    memberName: row.member_name ?? '',
    trainerId: row.trainer_id.toHexString(),
    trainerName: row.trainer_name_snapshot ?? '',
    startAt: row.start_at.toISOString(),
    endAt: row.end_at.toISOString(),
    location: row.location_snapshot ?? '',
    status: row.status,
    version: row.version ?? 0,
  };
}

// US-64-C04: chi tiết Admin = dữ liệu tra cứu hỗ trợ + thông tin lần hoàn tất hiện tại + nguồn quota + lịch sử.
export function toAdminPtBookingDetail(row: SupportPtBookingRow, quotaSource: AdminQuotaSource, events: BookingEvent[]): AdminPtBookingDetail {
  return {
    ...toSupportPtBookingItem(row),
    completedAt: row.completed_at?.toISOString(),
    completedActorType: row.completed_actor_type,
    completionRevision: row.completion_revision ?? 0,
    completionMembershipId: row.completion_membership_id?.toHexString(),
    quotaSource,
    events: events.map(toAdminPtBookingEvent),
  };
}

function toAdminPtBookingEvent(event: BookingEvent): AdminPtBookingEvent {
  return {
    action: event.action,
    actorId: event.actor_id.toHexString(),
    actorRole: event.actor_role,
    reason: event.reason,
    occurredAt: event.occurred_at.toISOString(),
    beforeStatus: event.before_status,
    afterStatus: event.after_status,
    membershipId: event.membership_id.toHexString(),
    completionRevision: event.completion_revision,
    usedBefore: event.used_before,
    usedAfter: event.used_after,
  };
}
