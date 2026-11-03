// Tầng giao diện – gọi API: đổi mật khẩu của chính mình (US-67).
import { ApiError, apiClient } from '../../api/client';

export interface ChangePasswordInput { currentPassword: string; newPassword: string }
export interface ChangePasswordResult { message: string; reauthenticationRequired: true }

// Lỗi xảy ra TRƯỚC khi gửi mật khẩu: chắc chắn mật khẩu chưa đổi, nên trang có thể giữ phiên cho thử lại.
export class PasswordNotSentError extends Error {}

export const securityApi = {
  async changePassword(input: ChangePasswordInput) {
    // US-67-TC13: access token chỉ sống 15 phút, nên gia hạn phiên TRƯỚC khi gửi mật khẩu.
    try {
      await apiClient.refreshSession();
    } catch (error) {
      // Phiên hết hẳn (401) thì để trang đưa về đăng nhập như cũ.
      if (error instanceof ApiError && error.status === 401) throw error;
      const message = error instanceof ApiError && error.status === undefined
        ? 'Không kết nối được máy chủ, mật khẩu chưa được gửi, hãy thử lại.'
        : 'Chưa gia hạn được phiên đăng nhập, mật khẩu chưa được gửi, hãy thử lại.';
      throw new PasswordNotSentError(message);
    }
    // Dùng requestOnce: spec cấm tự gửi lại mật khẩu khi lỗi hoặc mất response (US-67-TC11, TC13).
    return apiClient.requestOnce<ChangePasswordResult>('/auth/change-password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    });
  },
};
