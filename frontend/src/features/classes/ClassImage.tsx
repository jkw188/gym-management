// Tầng giao diện – thành phần dùng chung: ảnh trang trí trong cửa sổ chi tiết lớp, chọn theo bộ môn (subjectCode).
// Lớp không có field ảnh trong spec, nên mọi lớp cùng bộ môn dùng chung một ảnh; ảnh chỉ để trang trí.

const img = (id: string) => `https://images.unsplash.com/photo-${id}?w=800&h=500&fit=crop&q=80`;

// Ảnh miễn phí từ Unsplash (giấy phép Unsplash). Mã bộ môn lấy từ danh sách bộ môn của US-26.
const SUBJECT_IMAGES: Record<string, string> = {
  YOGA: img('1552196563-55cd4e45efb3'),
  AEROBICS: img('1517130038641-a774d04afb3c'),
  ZUMBA: img('1524594152303-9fd13543fe6e'),
  FUNCTIONAL: img('1599058917765-a780eda07a3e'),
  OTHER: img('1534438327276-14e5300c3a48'),
};

// Bộ môn lạ (Admin thêm sau này) thì dùng ảnh "Khác". alt="" vì tên lớp đã có trong nội dung chi tiết.
export function ClassImage({ subjectCode }: { subjectCode: string }) {
  const src = SUBJECT_IMAGES[subjectCode] ?? SUBJECT_IMAGES.OTHER;
  return <img className="plan-image" src={src} alt="" loading="lazy" referrerPolicy="no-referrer" />;
}
