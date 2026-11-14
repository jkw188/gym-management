import { ApiError } from '../../api/client';

export const money = (value: string) => `${BigInt(value).toLocaleString('vi-VN')} đ`;
export const timestamp = (value: string) => new Date(value).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
export const paymentError = (error: unknown) => error instanceof ApiError ? error.message : 'Không tải được dữ liệu. Vui lòng thử lại.';
