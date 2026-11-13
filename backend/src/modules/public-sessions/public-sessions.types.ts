// Tầng kiểu dữ liệu (US-26 bước 1): kiểu dùng chung của lịch lớp miễn phí công khai.
// Taxonomy bộ môn S04 cố định trong code; US-66 (Admin quản lý lớp) dùng lại đúng danh sách này.

// Trạng thái lớp theo mục 4.2.17 + US-66. Chỉ PUBLISHED được xem công khai (US-26-F01).
export const SESSION_STATUSES = ['DRAFT', 'PUBLISHED', 'CANCELLED'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

// Taxonomy S04 của US-66, đúng thứ tự hiển thị (US-26-TC01).
export const SUBJECTS = [
  { code: 'YOGA', label: 'Yoga' },
  { code: 'AEROBICS', label: 'Aerobics' },
  { code: 'ZUMBA', label: 'Zumba' },
  { code: 'FUNCTIONAL', label: 'Tập chức năng' },
  { code: 'OTHER', label: 'Khác' },
] as const;
export type SubjectCode = (typeof SUBJECTS)[number]['code'];
export const SUBJECT_CODES: SubjectCode[] = SUBJECTS.map(subject => subject.code);

// Một lớp trả về cho Guest/Member. US-26-F03: chỉ các field này, không phone/email/accountId hay audit.
export interface PublicSessionResponse {
  id: string;
  title: string;
  subjectCode: SubjectCode;
  subjectLabel: string;
  trainerId: string;
  // Tên hiện tại của account PT; null nếu không còn tìm thấy hồ sơ/account.
  trainerName: string | null;
  startAt: string;
  endAt: string;
  location: string;
  status: SessionStatus;
  // true khi endAt <= giờ server (nhãn "Đã kết thúc").
  ended: boolean;
}

// GET /api/public-sessions: danh sách có phân trang.
export interface PublicSessionPage {
  items: PublicSessionResponse[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}
