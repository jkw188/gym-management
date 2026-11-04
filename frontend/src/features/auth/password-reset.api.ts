// Tầng giao diện – gọi API: quên mật khẩu (US-05), xin mã OTP qua email và đặt mật khẩu mới.
import { apiClient } from '../../api/client';

export interface ResetRequestInput { identifier: string; challenge?: string }
export interface ResetRequestResult { message: string; challenge: string }
export interface ResetConfirmInput { challenge: string; otp: string; newPassword: string }
export interface ResetConfirmResult { message: string }

export const passwordResetApi = {
  // Flow mới: chỉ gửi identifier. Gửi lại mã: gửi kèm challenge đang giữ (US-05-F05).
  requestCode(input: ResetRequestInput) {
    return apiClient.publicPost<ResetRequestResult>('/auth/password-reset/request', input);
  },

  // US-05-TC05: otp là chuỗi để giữ số 0 đầu.
  confirm(input: ResetConfirmInput) {
    return apiClient.publicPost<ResetConfirmResult>('/auth/password-reset/confirm', input);
  },
};
