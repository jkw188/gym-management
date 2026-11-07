// Tầng kiểu dữ liệu (US-26 bước 1): đổi document public_sessions thành dữ liệu công khai theo allowlist.
// Thời điểm trả ISO 8601 có Z; giao diện tự hiển thị theo giờ Việt Nam.
import { PublicSession } from './schemas/public-session.schema';
import { PublicSessionResponse, SUBJECTS } from './public-sessions.types';

// US-26-F03, TC08: chỉ 11 field công khai; không trả audit, lý do hủy hay thông tin liên hệ PT.
// title/location trả nguyên văn dạng text, giao diện tự hiển thị text (không render HTML).
export function toPublicSessionResponse(session: PublicSession, trainerName: string | null, serverNow: Date): PublicSessionResponse {
  const subject = SUBJECTS.find(item => item.code === session.subject_code);
  return {
    id: session._id.toHexString(),
    title: session.title,
    subjectCode: session.subject_code,
    // Mã lạ trong DB (dữ liệu cũ) thì hiện chính mã đó thay vì làm lỗi cả danh sách.
    subjectLabel: subject ? subject.label : session.subject_code,
    trainerId: session.trainer_id.toHexString(),
    trainerName,
    startAt: session.start_at.toISOString(),
    endAt: session.end_at.toISOString(),
    location: session.location,
    status: session.status,
    // US-26-TC04: nhãn "Đã kết thúc" khi endAt <= giờ server.
    ended: session.end_at.getTime() <= serverNow.getTime(),
  };
}
