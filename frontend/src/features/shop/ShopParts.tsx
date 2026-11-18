// Tầng giao diện – thành phần dùng chung (US-35 bước 3): ảnh sản phẩm có placeholder và nhãn tình trạng kho.
import { useState } from 'react';
import type { Availability } from './shop.api';

// US-35-TC03: nhãn hiển thị cho từng tình trạng kho.
export const AVAILABILITY_TEXT: Record<Availability, string> = {
  IN_STOCK: 'Còn hàng',
  OUT_OF_STOCK: 'Hết hàng',
  UNAVAILABLE: 'Không khả dụng',
};

// Chỉ hiện ảnh HTTPS hợp lệ (theo luật ảnh của US-34); URL lạ coi như không có ảnh.
function isSafeImage(url: string | undefined): url is string {
  if (!url || /[\s\\\u0000-\u001f\u007f]/.test(url)) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

// US-35-TC12: không có ảnh hoặc ảnh tải lỗi thì hiện chữ "Không có ảnh" thay cho ảnh vỡ.
export function ShopImage({ url, name, size }: { url?: string; name: string; size: number }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (!isSafeImage(url) || failedUrl === url) return <span className="shop-image-placeholder">Không có ảnh</span>;
  return <img src={url} alt={name} width={size} height={size} loading="lazy" referrerPolicy="no-referrer"
    onError={() => setFailedUrl(url)} />;
}
