# US-45 — Hủy đơn, hết hạn và nghĩa vụ hoàn

Nguồn: `docs/PM/SPRINT6/[GM]Requirement_US-45.docx` v1.0 (đã đọc văn bản và toàn bộ bảng; không có hình nhúng).
Giữ nguyên mã US-45-AC01–03, TC01–16. Không sửa requirement gốc.

## Hợp đồng API và UC-24/UC-10

| API | Quyền | Nội dung |
| --- | --- | --- |
| `POST /api/me/orders/:id/cancel` | MEMBER, `orders.cancelOwn`, owner qua `members.account_id` | `{version, reason}` trim 10–500; operation `ORDER_CANCEL_OWN` |
| `POST /api/orders/:id/cancel` | STAFF/ADMIN, `orders.cancelSupport` | Cùng input, WEBSITE/POS; operation `ORDER_CANCEL_SUPPORT` |
| `POST /api/orders/:id/late-receipts` | STAFF/ADMIN, `transactions.confirmPayment` | TRANSFER, amount chuỗi VND, evidenceNote 10–500, receivingAccountCode, bankReference, receivedAt ISO có timezone; operation `RETAIL_LATE_RECEIPT` |
| `GET /api/refunds`, `GET /api/refunds/:id` | STAFF/ADMIN, `refunds.read` | Queue/detail chỉ đọc; filter orderId/status/fromDate/toDate/page/limit; ngày tạo theo giờ VN, mặc định 30 ngày, tối đa 366 ngày |
| `GET /api/me/orders`, `GET /api/me/orders/:id` | MEMBER, `orders.readOwn` | Adapter tối thiểu hỗ trợ US45 trên đơn đã lưu, gồm POS linked. List status/page/limit; không trả bankref/evidence/guard hoặc thông tin nội bộ người xác minh |

Lệnh người dùng bắt buộc Idempotency-Key UUIDv4. Hash DTO chuẩn hóa + target/version/channel;
record kết quả cùng transaction. Auth/session/role được kiểm mỗi request. Own command kiểm owner
trước replay và dưới member gate khi ghi; own operation lookup cũng kiểm owner hiện tại.
Foreign ID hợp lệ 404, role sai 403, revoked session 401, version/state sai 409.
Cùng key trả kết quả gốc, khác payload 409 IDEMPOTENCY_CONFLICT. Giữ key và tra
`GET /api/operations/:operation/:key` khi mất response; lookup404 không chứng minh thất bại.

Cancel trả `{id,code,status,version,reservationState,cancelledAt,transactionStatus,refundState,refundAmount,refundId?,notificationState}`.
New key trên CANCELLED bỏ qua stale version, trả khoản hoàn hiện có, giữ lý do gốc, không tạo event/release/refund lần hai.
COMPLETED trả 409, chuyển quy trình trả hàng S07. Không DELETE/reopen/cart restore.

## Dữ liệu và transaction

Cancel lấy member nếu có → inventory theo productId → transaction → order, tái đọc trạng thái,
kiểm snapshot/chứng từ và ledger từng SKU cùng tổng HELD. Chỉ HELD được RELEASED;
movement `ORDER_RELEASE:<itemId>`, reserved−q, onHand không đổi. Thiếu ledger, số dư mâu thuẫn,
reservation state sai hoặc số tiền hoàn vượt khoản thu đều chặn đối chiếu, rollback toàn lệnh.

PENDING chưa thu → transaction CANCELLED. SETTLED giữ nguyên payment/invoice/status;
refund PENDING ghi phần còn lại sau các nghĩa vụ/thực chi đã có, không tạo refund0.
Refund FAILED vẫn chiếm nghĩa vụ, không được tạo bản mới để retry. Refund có `_id=id`,
order_id/payment_id, reason CANCELLATION/RETURN, Decimal128 amount>0, reference unique `RF:<id>`,
obligation_key unique `CANCELLATION:<paymentId>`, actor_type, created_at/by?, refunded_at?.
Không ghi refunded_at cho nghĩa vụ PENDING và không có API payout trong S06.

Late receipt lấy member → transaction → order, không inventory. Chỉ CANCELLED+RELEASED,
transaction CANCELLED chưa payment SUCCEEDED/invoice. Chỉ nhận đủ amountDue>0,
receivedAt từ transaction.createdAt đến server now sau khóa, dùng tài khoản nhận trong
`RECEIVING_ACCOUNTS` hiện có. Insert payment SUCCEEDED purpose LATE_CANCELLED_ORDER,
paid_at=receivedAt, verified_at=now và refund PENDING cùng audit/notification/key.
Giữ transaction CANCELLED, không settle/invoice/reserve/fulfill. Unique SUCCEEDED(transaction_id)
và payment.reference giữ nguyên. Reference đã dùng trả PAYMENT_REFERENCE_USED kèm IDs nội bộ;
khác số tiền trả AMOUNT_MISMATCH, khoản thứ hai trả EXTRA_RECEIPT_REQUIRES_RECONCILIATION.
Không đổi reference hoặc tự bù tiền để vượt lỗi. Payment bình thường mặc định purpose ORDER_SETTLEMENT;
record cũ thiếu purpose được đọc như ORDER_SETTLEMENT, không sửa chứng từ cũ.

TransactionRunner EN02 có sẵn dùng snapshot/majority/primary, driver retry transient/unknown commit
trong 10 giây. Không nested transaction, Promise.all cùng session hay side effect mạng trong callback.
Audit/order event, notification/recipient/outbox, movement, refund và operation record cùng session.

Chạy `npm run ensure-indexes` và `npm run seed:access` trong backend trước vận hành.
Migration refund preflight dữ liệu cũ/số tiền/nguồn/duplicate/TTL rồi tạo index; không đoán hoặc
ghi đè dữ liệu legacy thiếu obligation_key/order_id. Có lỗi phải đối soát dữ liệu trước khi chạy lại.
Không thêm env hoặc dependency. StockMovement bổ sung actor_type, actor_id vắng khi SYSTEM;
movement cũ không có actor_type vẫn yêu cầu actor_id như trước.

## Worker và giao diện

HTTP bootstrap khởi động OrderExpiryWorker, catch-up ngay rồi tick5 giây; CLI/test không tự chạy.
Quét HELD PENDING/CONFIRMED, expiresAt≤now, sort expiresAt/id, batch50; từng đơn một transaction.
Không lease batch hoặc mutex nghiệp vụ trong process. Hai worker cùng chọn một đơn được serialize
bởi các gate/CAS/event key. Metrics `expiredHeldCount`, `cancelledCount`, `failureCount` có trong worker/runOnce.
Lỗi riêng từng đơn log orderId/mã an toàn và lưu expiry_retry_at/expiry_attempts, backoff5→10→20→40→60 giây.
Restart vẫn quét toàn bộ backlog; lỗi không chặn đơn khác. Các field retry là metadata vận hành,
được ghi ngoài transaction đã abort, không thay business version hoặc hóa đơn. Không TTL tài chính.
Eligibility đọc clock mới sau khóa mỗi retry; confirm/prepare/fulfill không gia hạn.

Staff/Admin dùng `/staff/orders`, `/admin/orders` để hủy và ghi khoản muộn tách biệt;
`/staff/refunds`, `/admin/refunds` xem nghĩa vụ, căn cứ và thời gian. Member dùng `/member/orders`.
UI giữ payload/key trong sessionStorage theo actor/đơn, tra cứu/replay khi mất phản hồi, khóa thao tác
đối nghịch. Đồng hồ báo expired không tự xác nhận kho RELEASED. “Chờ hoàn” không là “Đã hoàn”;
lỗi mạng/request không là chứng cứ chưa nhận tiền. Không có nút đánh dấu đã hoàn.

## Kiểm thử và giới hạn tích hợp

`backend/test/order-cancellation.integration-spec.ts` dùng MongoDB8.0.17 replica set thật,
JWT/session/RBAC thật và hai Node process. Catalog/nhập kho dùng API thật. Order/reservation và
normal RETAIL settlement vẫn là snapshot fixture vì US41 chưa có writer; không coi fixture là
checkout đã tích hợp. Suite kiểm TC01–14/16, batch50/catch-up/retry, hai worker, race cancel/fulfill,
10 vòng×20 replay cancel/late, key mới/stale version, IDOR, mất response và fault sau ghi
movement/payment/refund/audit/recipient/outbox/key để xác minh rollback toàn collection.
Frontend test kiểm reason/xác nhận, pending, recovery qua remount/lookup404, auth và queue chỉ đọc.

TC08 normal RETAIL payment vs expiry, TC12 cancel vs normal RETAIL payment và liên thông
factory US41/42/53 chưa thể nghiệm thu. Không thêm normal settlement/checkout ngoài US45.
TC15 hiện kiểm oracle EN06: gross từ mọi payment SUCCEEDED kể cả transaction CANCELLED,
chỉ trừ refund SUCCEEDED. Fixture SUCCEEDED chỉ dành oracle, không là API payout thật.
S08 chưa có cash report; khi triển khai phải lọc paid_at và refunded_at, không chỉ SETTLED transaction,
không trừ PENDING hoặc cộng invoice+payment hai lần. S07 phải tiếp tục chính record nghĩa vụ hiện có.
EN06 tổng thể giữ NOT_ACCEPTED cho đến khi đủ dependency và evidence liên thông; không đổi cổng để xanh giả.
