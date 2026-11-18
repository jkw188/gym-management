# US-46 — UC-26 nhận trả và thực chi hoàn tiền

Nguồn: `docs/PM/SPRINT7/[GM]Requirement_US-46.docx` v1.0, 06/11/2026.
Đã đọc văn bản và toàn bộ bảng; không có hình nhúng. Giữ mã F01–05/R01–03/P01–04,
AC01–04, TC01–20. Không sửa requirement sprint cũ.

## API

| API | Quyền STAFF/ADMIN | Nội dung |
| --- | --- | --- |
| `GET /api/orders/:id/return-eligibility` | `returns.manage` | Adapter UI: version, giá snapshot, lượng còn trả/hạn trả; command vẫn tái kiểm dưới khóa |
| `POST /api/orders/:id/returns` | `returns.manage` | `RETURN_RECEIVE`, 201: returnId, refundId nếu amount>0, refundState, amount, movementIds, orderVersion |
| `GET /api/returns`, `GET /api/returns/:id` | `returns.manage` | Phiếu bất biến, snapshot/tình trạng/actor/giờ nhận và refund link |
| `GET /api/refunds`, `GET /api/refunds/:id` | `refunds.read` | Mở US45: version, obligation, payout, attemptCount ở list, attempts/evidence ở detail nội bộ |
| `POST /api/refunds/:id/confirm` | `refunds.confirmPayout` | `REFUND_CONFIRM`, 200: SUCCEEDED, amount, version, refundedAt/verifiedAt |
| `POST /api/refunds/:id/fail` | `refunds.confirmPayout` | `REFUND_FAIL`, 200: FAILED, không refundedAt, giữ nghĩa vụ |

DTO/response có trong Swagger. Filter returns: orderId/fromDate/toDate/page/limit; refunds thêm status.
Ngày VN, mặc định30 ngày tới hôm nay/max366 ngày, limit20/max100; sort createdAt DESC/id DESC,
total/page cùng snapshot, rỗng totalPages0, trả asOf. Member/PT không được đọc evidence/phiếu hoặc ghi.

## Nhận hàng — F01–05/R01–02

WEBSITE/POS COMPLETED + CONSUMED + transaction SETTLED, có invoice/payment hợp lệ và ledger bàn giao.
D là ngày bàn giao ở Asia/Ho_Chi_Minh: fulfilledAt≤now<đầu ngày D+7, nhận hết D+6, không tính168 giờ.
Actor/clock từ backend, không nhận field thừa. Reason theo convention trim10–500; conditionNote10–500,
quantity nguyên dương, boolean restockable bắt buộc; 1–100 dòng, không trùng orderItemId.
Tổng trả tính cả hàng hỏng và mọi trạng thái refund.

Khóa member nếu có → inventory theo productId tăng dần → transaction → order. Tái đọc clock/điều kiện
mỗi callback. InventoryWriter kiểm ledger/số dư, không tự tạo số dư thay thế. Tạo returns/items từ
snapshot đơn; tính BigInt chính xác và lưu Decimal128. Chỉ restockable tăng onHand, reserved không đổi;
movement RETURN_RECEIVE:<returnItemId>, sequence bằng version mới. Chỉ lấy guard không tăng sequence.
Đơn giữ COMPLETED/CONSUMED, tăng version; giữ order_items/payment/invoice; không gọi cancel/release.

amount>0 tạo refund PENDING, obligation_key=RETURN:<returnId>:<paymentId>, reference=RF:<refundId>.
Tổng mọi PENDING/FAILED/SUCCEEDED cộng nghĩa vụ mới không vượt payment SUCCEEDED.amount.
amount0 không tạo refund0. Phiếu/items/kho/refund/order event RETURN_RECEIVED:<returnId>/notification/
recipient/outbox/operation_requests cùng session; lỗi bất kỳ bước nào rollback toàn phiếu.

## Thực chi — R03/P01–04

Payout ghi chứng từ nhân viên đã xác minh chi thật, không gọi ngân hàng. Khóa member nếu có →
transaction gốc → order gốc rồi CAS refund.version. Dùng cùng nghĩa vụ RETURN hoặc CANCELLATION US45,
kể cả tiền muộn sau hủy; khoản hủy không tạo returns/movement. FAILED vẫn chiếm budget, retry cùng ID.

Confirm từ PENDING/FAILED, chi đủ amount, paidOutAt có timezone và createdAt≤paidOutAt≤now,
evidenceNote10–500. CASH có cashVoucherReference; TRANSFER có payoutAccountCode trong PAYOUT_ACCOUNTS
và bankReference. Không trộn chứng từ hoặc dùng RF làm chứng từ. Reference NFKC/trim/uppercase;
unique theo [CASH,voucher] hoặc [TRANSFER,account,bankRef]. Trùng nghĩa vụ khác409 PAYOUT_REFERENCE_USED.
SUCCEEDED terminal; key mới409 REFUND_ALREADY_SUCCEEDED; cùng key replay trước kiểm version.

Mỗi confirm/fail append refund_attempts: operation_id unique hash EN02, before/after, actor/time/evidence,
chứng từ khi success. Confirm ghi refunded_at=paidOutAt, verified_at=now/by và notification
REFUND_SUCCEEDED:<refundId> cùng session. Fail ghi lý do, không notification đã hoàn.
Recipient resolve member đang linked dưới member gate; anonymous recipients rỗng. Thông báo không có
bankref/contact. Hai transaction nhận hàng/payout độc lập; payout lỗi không mất hàng đã nhận.

Ngân hàng chưa rõ kết quả: giữ trạng thái, đối soát trước; timeout không phải chứng cứ fail.
Idempotency UUIDv4/actor/operation, hash DTO chuẩn hóa có target/version, auth trước replay;
operation lookup dùng quyền hiện tại. Outcome unknown giữ key, không tự tạo ý định chi mới.

## Schema/index và vận hành

- returns: unique request_key hash EN02, index(order_id,created_at,_id), index(created_at,_id).
- return_items: unique(return_id,order_item_id), index order_item_id; giá/tên/SKU/tình trạng snapshot.
- refunds: thêm Int32 version, method, payout_reference_key partial unique string, payout_evidence,
  verified_at/by, failure_code; giữ unique obligation/reference.
- refund_attempts: unique operation_id, index(refund_id,occurred_at,_id), append-only. Không TTL tài chính.
- Inventory reconciliation kiểm RETURN_RECEIVE khớp nguồn phiếu/dòng, restockable và delta.

Dừng writer, chạy `npm run ensure-indexes` rồi `npm run seed:access` trong backend trước vận hành.
Preflight đối chiếu nguồn/lượng/tiền/movement/refund/chứng từ; dữ liệu sai phải đối soát trước mở command.
Chỉ refund legacy thiếu version được backfill0 sau preflight; không suy diễn payout hay tạo lại nghĩa vụ.
Thêm env PAYOUT_ACCOUNTS=[] (ví dụ ["GYM_PAYOUT"]), độc lập RECEIVING_ACCOUNTS;
CASH độc lập, TRANSFER bị chặn khi chưa cấu hình. Không thêm dependency.
Chưa chạy migration trên database vận hành trong phiên triển khai.

## UI, kiểm thử và giới hạn

/staff/returns và /admin/returns: tìm ID đơn → lượng/hạn → kiểm hàng → nhận.
/staff/refunds và /admin/refunds: queue PENDING/FAILED → đối soát → confirm/fail.
Hiển thị refundAmount/refundedAmount/outstandingRefundAmount riêng. Pending giữ payload/key trong
sessionStorage theo actor/scope; remount lookup/replay cùng key, lookup404 vẫn giữ key.
Auth401/403 khóa replay; đổi actor remount workspace để không giữ evidence trên UI tài khoản mới.
REST lịch sử độc lập socket. Không tự fail khi mạng lỗi.

Tests: returns-policy.spec.ts, returns.integration-spec.ts (MongoDB8.0.17 replica set, JWT/session/RBAC,
hai Node process, POS/stock writers HTTP thật), frontend returns.test.tsx; hồi quy US45/POS và unit oracle.
Bao gồm partial/damaged/zero, budget, rollback, ref/CAS races, mất response, ngày VN, migration và auth.

WEBSITE checkout chưa có endpoint: test WEBSITE chỉ đổi snapshot channel của đơn linked đã qua POS
writers thật; chưa nghiệm thu full WEBSITE checkout→return. US51 cash report S08 chưa triển khai;
phải dùng payment.paid_at và chỉ refund SUCCEEDED/refunded_at, không trừ PENDING/FAILED hoặc giá trị
hàng trả. US46 kiểm payout khác kỳ bán và các tổng riêng, chưa là nghiệm thu báo cáo US51.
