// Tầng giao diện – gọi API: đổi mật khẩu của chính mình (US-67).
import { apiClient } from '../../api/client';

export interface ChangePasswordInput { currentPassword: string; newPassword: string }
export interface ChangePasswordResult { message: string; reauthenticationRequired: true }

export const securityApi = {
  async changePassword(input: ChangePasswordInput) {
    // US-67-TC13: access token chỉ sống 15 phút, nên gia hạn phiên TRƯỚC khi gửi mật khẩu.
    // Refresh lỗi thì lỗi đi lên trang và mật khẩu chưa hề được gửi.
    await apiClient.refreshSession();
    // Dùng requestOnce: spec cấm tự gửi lại mật khẩu khi lỗi hoặc mất response (US-67-TC11, TC13).
    return apiClient.requestOnce<ChangePasswordResult>('/auth/change-password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    });
  },
};
