// Tầng giao diện – gọi API (US-09 bước 3): tạo hồ sơ hội viên, tra account và liên kết qua ApiClient (tự gắn Bearer token).
// Lệnh ghi gửi header Idempotency-Key (EN-02); người thực hiện do server lấy từ phiên đăng nhập.
import { apiClient } from '../../api/client';

export interface Member {
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

export interface LinkCandidate {
  id: string;
  fullName: string;
  phone: string;
  canLink: boolean;
}

export type VerificationMethod = 'IN_PERSON_ACCOUNT' | 'IN_PERSON_DOCUMENT';

export interface MemberInput { fullName: string; phone: string; birthDate?: string; address?: string }

export interface LinkInput { accountId: string; version: number; verificationMethod: VerificationMethod; verificationNote: string }

export const membersApi = {
  create(input: MemberInput, idempotencyKey: string) {
    return apiClient.request<Member>('/members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(input),
    });
  },
  // Chỉ tìm theo số điện thoại đầy đủ; server chuẩn hóa và so khớp chính xác.
  findLinkCandidates(phone: string) {
    return apiClient.request<{ items: LinkCandidate[] }>(`/members/link-candidates?${new URLSearchParams({ phone }).toString()}`);
  },
  link(memberId: string, input: LinkInput, idempotencyKey: string) {
    return apiClient.request<{ member: Member; linked: true }>(`/members/${encodeURIComponent(memberId)}/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(input),
    });
  },
};
