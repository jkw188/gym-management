// Tầng kiểm thử backend (Jest, unit, không cần DB): US-40 bước 1 – DTO thêm/sửa/xóa dòng giỏ.
// Kiểm tra version, productId, quantity đúng định dạng và từ chối field ngoài allowlist như memberId/price (TC02, TC04).
// Hợp đồng test đặt ra cho Builder (US-40 bước 1, theo bảng "API và luồng Member" mục 3 của spec):
//   src/modules/cart/cart.dto.ts xuất:
//   - AddCartItemDto (body POST /api/me/cart/items): { version, productId, quantity }.
//   - SetCartItemDto (body PUT /api/me/cart/items/:productId): { version, quantity }.
//   - RemoveCartItemQueryDto (query DELETE /api/me/cart/items/:productId?version=): { version }.
//   version: JSON integer ≥ 0. quantity: JSON integer 1–999 (không nhận chuỗi, số lẻ, 0, âm).
//   productId: chuỗi ObjectId 24 ký tự hex. Không nhận memberId/accountId/role/price/unitPrice/subtotal.
//   Query DELETE là chuỗi trên URL nên DTO phải tự đổi "3" → 3 (pipe chung tắt enableImplicitConversion).
//   Idempotency-Key đọc từ header bằng @IdempotencyKey() đã có (EN-02), không nằm trong DTO.
//   Pipe dưới đây dùng đúng tùy chọn của ValidationPipe toàn cục trong configure-http.ts.
import { ValidationError, ValidationPipe } from '@nestjs/common';
import { AddCartItemDto, RemoveCartItemQueryDto, SetCartItemDto } from '../src/modules/cart/cart.dto';

const PRODUCT_ID = '6650a1b2c3d4e5f6a7b8c9d0';

// Pipe giống cấu hình toàn cục; exceptionFactory trả lại danh sách lỗi để test đọc tên field sai.
const pipe = new ValidationPipe({
  transform: true, whitelist: true, forbidNonWhitelisted: true,
  transformOptions: { enableImplicitConversion: false },
  exceptionFactory: (errors: ValidationError[]) => errors,
});

// Trả về tên các field bị lỗi; mảng rỗng nghĩa là hợp lệ.
async function invalidFields(metatype: new () => object, value: unknown, type: 'body' | 'query' = 'body'): Promise<string[]> {
  try {
    await pipe.transform(value, { type, metatype });
    return [];
  } catch (errors) {
    return (errors as ValidationError[]).map(error => error.property);
  }
}

describe('US-40 bước 1: AddCartItemDto (POST thêm vào giỏ)', () => {
  it('US-40-TC04: version 0, productId hợp lệ, quantity 1 và 999 → hợp lệ', async () => {
    expect(await invalidFields(AddCartItemDto, { version: 0, productId: PRODUCT_ID, quantity: 1 })).toEqual([]);
    expect(await invalidFields(AddCartItemDto, { version: 5, productId: PRODUCT_ID, quantity: 999 })).toEqual([]);
  });

  it.each([0, -1, 1.5, '2', 1000, null, undefined])('US-40-TC04: quantity = %p → 400 ở quantity', async quantity => {
    expect(await invalidFields(AddCartItemDto, { version: 0, productId: PRODUCT_ID, quantity })).toContain('quantity');
  });

  it.each([-1, 1.5, '0', null, undefined])('US-40-TC04: version = %p → 400 ở version', async version => {
    expect(await invalidFields(AddCartItemDto, { version, productId: PRODUCT_ID, quantity: 1 })).toContain('version');
  });

  it.each(['abc', '', 123, undefined])('US-40-TC04: productId sai định dạng (%p) → 400 ở productId', async productId => {
    expect(await invalidFields(AddCartItemDto, { version: 0, productId, quantity: 1 })).toContain('productId');
  });

  it.each(['memberId', 'accountId', 'role', 'price', 'unitPrice', 'subtotal'])(
    'US-40-TC02: body có thêm %s → 400 (không nhận chủ giỏ hoặc giá từ client)', async field => {
      const body = { version: 0, productId: PRODUCT_ID, quantity: 1, [field]: field === 'price' || field === 'unitPrice' ? '1000' : PRODUCT_ID };
      expect(await invalidFields(AddCartItemDto, body)).toContain(field);
    });
});

describe('US-40 bước 1: SetCartItemDto (PUT đặt số lượng tuyệt đối)', () => {
  it('US-40-TC04: version 0, quantity 1 và 999 → hợp lệ', async () => {
    expect(await invalidFields(SetCartItemDto, { version: 0, quantity: 1 })).toEqual([]);
    expect(await invalidFields(SetCartItemDto, { version: 3, quantity: 999 })).toEqual([]);
  });

  it.each([0, -1, 1.5, '2', 1000, null, undefined])('US-40-TC04: quantity = %p → 400 ở quantity (xóa phải dùng DELETE)', async quantity => {
    expect(await invalidFields(SetCartItemDto, { version: 0, quantity })).toContain('quantity');
  });

  it.each([-1, 1.5, '0', undefined])('US-40-TC04: version = %p → 400 ở version', async version => {
    expect(await invalidFields(SetCartItemDto, { version, quantity: 1 })).toContain('version');
  });

  it.each(['memberId', 'productId', 'price'])('US-40-TC02: body có thêm %s → 400 (productId nằm trên URL)', async field => {
    expect(await invalidFields(SetCartItemDto, { version: 0, quantity: 1, [field]: PRODUCT_ID })).toContain(field);
  });
});

describe('US-40 bước 1: RemoveCartItemQueryDto (query version của DELETE)', () => {
  it('US-40-TC04: version "0" và "7" trên URL → hợp lệ, được đổi thành số', async () => {
    const zero = await pipe.transform({ version: '0' }, { type: 'query', metatype: RemoveCartItemQueryDto });
    const seven = await pipe.transform({ version: '7' }, { type: 'query', metatype: RemoveCartItemQueryDto });
    expect(zero).toEqual(expect.objectContaining({ version: 0 }));
    expect(seven).toEqual(expect.objectContaining({ version: 7 }));
  });

  it.each(['-1', '1.5', 'abc', '', '1e2', undefined])('US-40-TC04: version = %p → 400 ở version (bắt buộc integer ≥ 0)', async version => {
    expect(await invalidFields(RemoveCartItemQueryDto, { version }, 'query')).toContain('version');
  });

  it('US-40-TC02: query có thêm memberId → 400', async () => {
    expect(await invalidFields(RemoveCartItemQueryDto, { version: '0', memberId: PRODUCT_ID }, 'query')).toContain('memberId');
  });
});
