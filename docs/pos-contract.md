# US-53 — bán sản phẩm tại quầy

Nguồn: `PM/SPRINT6/[GM]Requirement_US-53.docx` v1.0; hợp đồng chung US-41-Q01/P01–P04, S06-O01/H01 và S05-I01. Đã đọc văn bản/bảng US-53 và US-41; hai DOCX không có ảnh nhúng. Q03/PD-03 truy vết đến US-53; không sửa bản DOCX nguồn.

## API và quyền

| API | Quyền | Kết quả |
| --- | --- | --- |
| `GET /api/pos/products?q=&categoryId=&page=1&limit=20` | `pos.create`, STAFF/ADMIN | Chỉ product/category ACTIVE, giá VND string, productVersion, available; không unitCost |
| `POST /api/pos/orders/preview` | `pos.create` | DTO `{memberId?,buyerName?,recipientPhone?,preferredPaymentMethod,items:[{productId,quantity}]}`; quoteToken, quoteExpiresAt, items/total, buyer, pickupLocation, expiryPreview `{durationHours:24,startsAt:"CREATE"}` |
| `POST /api/pos/orders` | `pos.create` | DTO preview + quoteToken; key `ORDER_CREATE_POS`; 201 CONFIRMED/HELD, transaction PENDING hoặc SETTLED/invoice0, version0 |
| `POST /api/pos/orders/:id/fulfill` | `pos.fulfill` | `{version}`; key `ORDER_FULFILL_POS`; service US-44, policy POS |
| `POST /api/transactions/:id/payment-preview` | `transactions.read` | Dispatch RETAIL trong API US-21, không ghi dữ liệu |
| `POST /api/transactions/:id/confirm-payment` | `transactions.confirmPayment` | DTO US-22 và key PAYMENT_CONFIRM; RETAIL không cấp membership |
| `GET /api/orders`, `GET /api/orders/:id`, `POST /api/orders/:id/cancel` | `orders.read` / `orders.cancelSupport` | Query channel POS, snapshot, shared US-45 cancel/refund |
| `GET /api/invoices/:id` | `invoices.read` | Snapshot buyer và retailLines; payment nếu có, trạng thái order/refund hiện tại |

Mỗi request qua JWT/session/account ACTIVE/role hiện hành. Dự án dùng permission cố định theo vai trò trong `ACCESS_POLICY`; không tạo cơ chế gán quyền riêng cho từng nhân viên. Các action có decorator/operation riêng; `pos.create` không được dùng thay permission thu/hủy/giao. Cần seed catalog quyền sau cập nhật.

## Dữ liệu và nguyên tử

`RetailQuoteService` dùng JwtService hiện có, HS256, secret riêng ≥32 byte, audience retail-order-quote, purpose RETAIL_QUOTE_V1, hạn600 giây. Quote bind actor/member/channel POS, SKU/quantity/productVersion/unitPrice và total; không chứa tên/điện thoại. Create hash token cùng DTO chuẩn hóa; không lưu token trong operation record. Preview không giữ kho. Quote giả400, khác actor403, hết hạn/stale409. Không nhận đơn giá hoặc chiết khấu từ client.

`RetailOrderFactory.createPos` khóa catalog_state → member nếu chọn rõ → inventory theo productId. Đọc lại giá, effectiveActive, buyer và tồn trong cùng session sau khóa; insert transaction/order/items, reserve qua InventoryWriter, invoice0 nếu cần, CREATED event, notification/recipients/outbox và operation cùng commit. Không đọc/xóa cart Member. 1–100 SKU khác nhau, quantity1–999; tiền tính bằng số nguyên chính xác và lưu Decimal128 trong trần999999999999 VND.

POS tạo CONFIRMED, confirmedBy/At là nhân viên lập; hạn giữ cố định createdAt+24 giờ. Giữ tồn chỉ tăng reserved, không giảm onHand. Khách lẻ thiếu tên dùng “Khách lẻ”, thiếu phone lưu chuỗi rỗng; chỉ POS được phone rỗng, WEBSITE vẫn bắt buộc. Không tạo account/member hoặc tự liên kết theo phone. Member được chọn chụp tên/phone sau member gate; invoice dùng snapshot đơn, không đọc lại hồ sơ hiện tại. Own orders chỉ lọc member_id.

`RetailSettlementService` là handler của US-22: khóa member nếu có → transaction → order; lấy clock sau khóa, tái kiểm PENDING/CONFIRMED+HELD/còn hạn, số tiền đúng đủ, tài khoản nhận/time/reference. Payment SUCCEEDED, invoice, transaction SETTLED/version+1, order.version+1 và audit/outbox/key cùng transaction. Không đổi order.status, kho hoặc deadline. Nhánh0 đồng dùng cùng invoice/completion nội bộ tại create, không tạo payment0. Invoice buyer “Khách lẻ” hợp lệ.

Fulfill POS gọi `FulfillOrderService` hiện hữu; cancel, late-receipt và expiry dùng US-45. Giao chỉ SETTLED + invoice và payment hợp lệ nếu total>0; expiry bằng mốc chặn. Kho dùng duy nhất ORDER_RESERVE/FULFILL/RELEASE, sequence/version/eventKey chung. Route prepare/fulfill website từ chối POS409.

## UI và khôi phục

`/staff/pos` và `/admin/pos`: chọn khách, SKU và số lượng → xem báo giá/tổng server → xác nhận lập → form đối chiếu/confirm US-22 → kiểm nhận/bàn giao US-44 → chứng từ. Ba trạng thái lập/thu/giao hiển thị riêng; CASH amount luôn là amountDue server, chỉ đọc. Hủy cần xác nhận và lý do theo US-45.

Create giữ key trong sessionStorage theo actor; quote/body chỉ trong bộ nhớ. Mất response giữ nguyên key/intent; tra operation hoặc gửi lại cùng body/key khi còn mở trang. Sau reload chỉ lookup key cũ, không tạo quote/key mới ngầm. Khi create đã biết ID, lưu ID để mở đúng đơn cũ. Payment/fulfill/cancel dùng cơ chế recovery riêng hiện hữu. 404 operation không chứng minh thất bại. Lỗi auth giữ yêu cầu chờ đối soát và vô hiệu action mới. Báo giá chỉ trong body/bộ nhớ, không URL/log/storage.

## Kiểm thử và giới hạn nghiệm thu

`backend/test/pos.integration-spec.ts` dùng MongoDB replica set thật, HTTP/JWT và hai Node process độc lập; SKU và nhập kho dùng writer thật. Bao phủ US-53-TC01–08/10–13 theo nhánh POS: linked/anonymous/no-auto-link/cart preservation, quote/DTO/RBAC, CASH/TRANSFER/zero, expiry/cancel, replay từng bước, rollback reserve/audit/outbox/key/invoice, reference unique và auth thu hồi. Mười vòng ×20 create cùng key và mười vòng tranh SKU cuối; mười vòng normal payment/cancel và paid fulfill/cancel; oracle EN-06 kiểm ledger và nghĩa vụ sau commit.

`frontend/src/features/pos/pos.test.tsx` kiểm TC14 qua component/API mock: chọn Member, khách lẻ,0 đồng, tách bước, CASH amount server, loading/empty/hết hàng, stale/403, pending/recovery sau remount. Đây không phải kiểm trình duyệt nối backend thật.

US-40/41 checkout website/cart writer chưa có trong workspace. Vì vậy US-53-TC09 **chưa đủ bằng chứng race POS–WEBSITE qua hai API thật**; test hiện chứng minh POS–POS trên cùng InventoryWriter và ledger, không giả nhận WEBSITE writer đã hoàn thành. EN-06 full acceptance còn phụ thuộc US-40/41 và giữ NOT_ACCEPTED theo harness hiện tại; không đánh dấu toàn S06 Done.

## Vận hành

Không thêm dependency, lockfile hoặc collection mới. Thêm `PICKUP_LOCATION` thực tế và `RETAIL_QUOTE_SECRET` riêng trong `.env` theo `.env.example`; không dùng secret access JWT. Thiếu cấu hình trả503 tại preview/create, không dùng quầy/giá giả. MongoDB cần replica set; chạy `npm run ensure-indexes`, `npm run seed:access` trước phục vụ. Chỉ mở rộng operation enum ORDER_CREATE_POS và permission pos.create; giữ permission pos.fulfill hiện có. Đơn cũ giữ nguyên; migration không backfill buyer/phone hoặc reset tồn.
