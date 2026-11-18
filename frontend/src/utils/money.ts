// Tiện ích giao diện dùng chung: định dạng tiền VND để hiển thị. Chỉ định dạng giá server trả, không tính toán.
// Giá là chuỗi số nguyên VND (EN-02); dùng BigInt để không mất chính xác với số lớn (tối đa 999.999.999.999).

// Ví dụ: "9000" → "9.000 ₫"; "0" → "0 ₫" (không đổi thành "Liên hệ", US-35-TC12).
export const formatVnd = (price: string) => `${new Intl.NumberFormat('vi-VN').format(BigInt(price))} ₫`;
