import { ApiError } from '../../api/client';

export const money = (value: string) => `${BigInt(value).toLocaleString('vi-VN')} đ`;
export const timestamp = (value: string) => new Date(value).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
export const paymentError = (error: unknown) => error instanceof ApiError ? error.message : 'Không tải được dữ liệu. Vui lòng thử lại.';

// Chứng từ lưu người mua dạng chuỗi JSON {"fullName","memberCode","phone"} → hiện "Lê Minh An · HV-… · +84…".
// Chứng từ cũ có thể là chữ thường (không phải JSON) thì hiện nguyên văn.
export function buyerLabel(snapshot: string) {
  try {
    const buyer: unknown = JSON.parse(snapshot);
    if (buyer && typeof buyer === 'object') {
      const values = buyer as Record<string, unknown>;
      const fields = [values.fullName, values.memberCode, values.phone].filter((value): value is string => typeof value === 'string');
      if (fields.length) return fields.join(' · ');
    }
  } catch { /* Chứng từ cũ có thể là chữ thường. */ }
  return snapshot;
}
