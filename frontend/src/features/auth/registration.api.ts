import { apiClient } from '../../api/client';

export interface RegisterInput { fullName: string; phone: string; email?: string; password: string }
export interface RegisterResult { id: string; nextAction: 'LOGIN' }

export const registrationApi = {
  // publicPost gửi đúng một lần; không gắn access token hoặc khôi phục phiên rồi retry POST.
  register(input: RegisterInput) { return apiClient.publicPost<RegisterResult>('/auth/register', input); },
};
