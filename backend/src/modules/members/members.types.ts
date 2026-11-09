// Tầng kiểu dữ liệu (US-09 bước 1–2): kiểu dùng chung của module hội viên.

// Dữ liệu hồ sơ sau khi service đã chuẩn hóa và kiểm tra (US-09-F02).
export interface NewMemberInput {
  fullName: string;
  phone: string;
  birthDate?: string;
  address?: string;
}

// MemberDto trả về client (mục 3 của spec). accountId chỉ có khi đã liên kết.
export interface MemberResponse {
  id: string;
  memberCode: string;
  fullName: string;
  phone: string;
  birthDate?: string;
  address?: string;
  accountId?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

// US-09 bước 2: một item của GET /api/members/link-candidates. Không có email, status, role hay field nội bộ.
export interface LinkCandidate {
  id: string;
  fullName: string;
  phone: string;
  canLink: boolean;
}
