// Tầng giao diện – thành phần dùng chung: ảnh trang trí cho gói tập theo loại gói (GYM hoặc PT).
// Gói không có field ảnh trong spec, nên mọi gói cùng loại dùng chung một ảnh; ảnh chỉ để trang trí.

// Ảnh miễn phí từ Unsplash (giấy phép Unsplash), link HTTPS giống ảnh sản phẩm.
const PLAN_IMAGES: Record<'GYM' | 'PT', string> = {
  GYM: 'https://images.unsplash.com/photo-1534438327276-14e5300c3a48?w=800&h=500&fit=crop&q=80',
  PT: 'https://images.unsplash.com/photo-1571019614242-c5c5dee9f50b?w=800&h=500&fit=crop&q=80',
};

// alt="" vì ảnh chỉ trang trí: trình đọc màn hình bỏ qua, tên gói đã có ở tiêu đề thẻ.
export function PlanImage({ kind }: { kind: 'GYM' | 'PT' }) {
  return <img className="plan-image" src={PLAN_IMAGES[kind]} alt="" loading="lazy" referrerPolicy="no-referrer" />;
}
