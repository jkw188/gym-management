import { ApplicationError } from '../../common/errors/application-error';

export const RETAIL_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type RetailStatus = typeof RETAIL_STATUSES[number];
export const categoryName = (name: string) => name.trim().normalize('NFC');
export const categoryKey = (name: string) => categoryName(name).toLowerCase();
export const retailSku = (sku: string) => sku.trim().replace(/[a-z]/g, letter => letter.toUpperCase());

// S05 has no internal image upload route. Only absolute HTTPS images are allowed.
// The backend stores the URL; it never downloads it.
export function safeRetailImage(value: string): boolean {
  if (!value || value.length > 500 || /[\s\\\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}

export function assertRetailImage(value: string | null | undefined): void {
  if (value && !safeRetailImage(value)) throw new ApplicationError(400, 'VALIDATION_ERROR', 'Ảnh phải là URL HTTPS hợp lệ');
}

export function assertCategoryActive(status: RetailStatus): void {
  if (status !== 'ACTIVE') throw new ApplicationError(409, 'CATEGORY_NOT_ACTIVE', 'Danh mục đang ngừng bán');
}
