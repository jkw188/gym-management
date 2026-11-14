// Tiện ích dùng chung cho tầng kiểm tra dữ liệu: đổi tham số query (luôn là chuỗi) sang số nguyên dương cho @Transform của DTO.
// Dùng cho page, limit, rating… thay cho các bản chép riêng trong từng file *.dto.ts.

// Chỉ đổi sang số khi chuỗi là số nguyên dương viết đúng dạng ("12" → 12).
// "0", "1.5", "abc", "012" giữ nguyên để @IsInt/@Min của DTO báo lỗi 400 (không tự sửa giá trị sai).
export function queryInteger({ value }: { value: unknown }): unknown {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value;
}
