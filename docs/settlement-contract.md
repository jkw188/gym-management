# US-22 / UC-23 — Xác nhận khoản thu và lập chứng từ

Nguồn: `docs/PM/SPRINT2/Requirement_US-22.docx` v1.0 ngày27/10/2026, đầy đủ văn bản/bảng, không có sơ đồ hoặc ảnh nhúng; đối chiếu US-21, US-14 và EN-02/03. Giữ nguyên F01–F08, AC01–AC04, TC01–TC17. Đây là hợp đồng triển khai nhánh xác nhận UC-23 theo Q05; không sửa bản Requirement hoặc trạng thái tracker.

## API và quyền

- `POST /api/transactions/:id/confirm-payment`: quyền cố định `transactions.confirmPayment` (STAFF/ADMIN), JWT/session hiện hành và account ACTIVE. Bắt buộc UUIDv4 `Idempotency-Key`, operation PAYMENT_CONFIRM. Body dùng chung PaymentReviewDto của US-21; không nhận actor, status, invoiceNo, memberId, giá/quota hoặc mã CASH từ client. Trả200 `{transactionId,transactionCode,status:"SETTLED",paymentId,invoiceId,invoiceNo,saleId,membershipId,startDate,endDate,notificationState}`.
- `GET /api/invoices/:id`: quyền `invoices.read` (STAFF/ADMIN). Trả `{id,invoiceNo,issuedAt,totalAmount,buyerSnapshot,transactionId,transactionCode,serviceLine,payment?}`. buyerSnapshot là JSON string đã lưu; serviceLine lấy điều khoản sale đã chốt, không join plan/member live để thay lịch sử. Payment chỉ hiển thị SUCCEEDED. Không có API sửa/xóa chứng từ hoặc PATCH SETTLED.
- `GET /api/operations/PAYMENT_CONFIRM/:key`: API EN-02 hiện có, theo actor đang đăng nhập và quyền operation hiện hành; Member/PT không xem được. Replay cũng đi qua auth/role trước khi đọc kết quả.
- Error envelope EN-01: ID/DTO/key sai400, thiếu phiên401, thiếu quyền403, không tìm thấy404, xung đột409, MongoDB lỗi503. TRANSACTION_ALREADY_SETTLED trả các ID hiện hữu qua `error.details[]` theo cấu trúc `{field:"invoiceId",message:"<hex24>"}` tương tự transactionId/saleId/paymentId/membershipId khi tồn tại. Không trả hash, raw MongoDB error, URI hoặc secret.

## Luồng atomic và chống xử lý lặp

1. Normalize input tĩnh bằng `normalizePaymentIntent`, parse targetId rồi gọi IdempotencyService. Amount bỏ số0 đầu, evidenceNote/bankReference trim, native case giữ nguyên; timestamp chuyển Date để cùng một instant có cùng hash. Không kiểm trạng thái/config hiện tại trước replay kết quả đã commit.
2. Trong session do TransactionRunner tạo, đọc operation record trước; cùng key/payload trả đúng body gốc, khác payload/target409 IDEMPOTENCY_CONFLICT. Nếu chưa có record, đọc transaction và sale để xác định target.
3. Gọi port `SaleActivation.activateSaleWithinSession` của US-14; port lấy khóa ghi member.service_revision → transaction.guard_revision và đọc lại trạng thái. Không lấy khóa lần hai, không mở nested transaction. Hai confirm/cancel hoặc US-10 cập nhật cùng member sẽ write-conflict/retry toàn callback.
4. Trong hook sau khóa: gọi lại PaymentReviewService với cùng session; kiểm amountDue>0, PENDING, snapshot và điều kiện gói, account nhận, time/reference. Amount phải đúng đủ một lần. CASH sinh `CASH:<paymentId hex24>`. TRANSFER dùng `TRF:<accountCode>:<bankReference>`≤100, kiểm bất kỳ payment đã chiếm reference; unique index simple quyết định cuối cùng khi request cạnh tranh.
5. Insert payment SUCCEEDED và invoice trong session. Buyer được đọc sau khóa; invoice_no=`INV-<invoiceId hex24>`, total_amount=amount_due, buyer_snapshot từ fullName/memberCode/phone. Port US-14 kiểm payment thành công, kích hoạt membership và chốt kỳ actual từ snapshot.
6. CAS transaction PENDING/version → SETTLED/version+1, settled_at server; persistBusinessEvent với eventKey `SERVICE_SALE_SETTLED:<saleId>`, recipient account tại thời điểm hoàn tất, outbox cùng session. Insert operation result rồi commit. Lỗi bất kỳ bước nào rollback toàn bộ, kể cả payment, sale date, revision và operation record.

Không Promise.all trên cùng session; không emit socket/email/HTTP trong callback. Worker EN-03 chỉ phát dữ liệu đã commit. Callback retry có giới hạn10s theo TransactionRunner, không retry lỗi nghiệp vụ. OPERATION_OUTCOME_UNKNOWN trả503; không tạo payment FAILED để che kết quả chưa rõ.

Hai index tài chính EN-02 đã có: reference unique toàn collection với collation simple; partial unique transaction_id khi status=SUCCEEDED. Insert cạnh tranh bị duplicate reference được map409 PAYMENT_REFERENCE_USED sau khi transaction thua đã abort. Không xóa dữ liệu trùng để tạo index.

## Tiền, thời gian, snapshot và nghĩa vụ0 đồng

- API tiền là string VND nguyên không âm≤999999999999, lưu Decimal128; payment thành công>0, đúng amount_due. Không chia nhỏ, thiếu/thừa, exponent hoặc phần lẻ ở API.
- CASH paid_at=verified_at=thời điểm server xác nhận sau khóa. TRANSFER paid_at=receivedAt (có timezone, từ transaction.created_at đến hiện tại); verified_at/settled_at/issued_at là thời điểm server xác nhận. Q13 tính cashflow theo payments.status SUCCEEDED và paid_at, không cộng payment với invoice thành hai doanh thu.
- Giá/quota/benefits/policy lấy sale snapshot. Plan đổi giá/ngừng bán không thay nghĩa vụ đã chốt. Buyer snapshot đồng nhất với một bản member trước hoặc sau US-10 cạnh tranh, không bị sửa khi member đổi về sau.
- Nhánh `ZeroSettlementService.completeZeroWithinSession` hiện có của US-14 được giữ nguyên: snapshot giá0 và amountDue0, invoice0/membership/event cùng transaction tạo sale, không có payment0. Confirm public với giao dịch miễn phí đã hoàn tất trả409 TRANSACTION_ALREADY_SETTLED.

PaymentSchema bổ sung created_at (default chỉ cho document mới); SUCCEEDED bắt buộc verified_by/paid_at và amount nguyên dương trong phạm vi VND. Endpoint ghi đầy đủ verified_at/evidence_note và metadata TRANSFER. Field metadata mới vẫn optional để đọc lịch sử, không backfill thời điểm thu hoặc chứng cứ giả cho dữ liệu cũ. Không có thay đổi env/dependency hoặc unique index mới. DB hiện hữu dùng lệnh `npm run ensure-indexes` của repository; thiếu/sai index production vẫn dừng theo kiểm tra EN-02/US-14.

## Giao diện

Từ trang `/staff/transactions` hoặc `/admin/transactions`: preview READY mới hiện bước xác nhận với checkbox riêng “đã thực nhận đủ tiền” và nút xác nhận. READY không tự gửi confirm. Sửa input xóa preview và yêu cầu xác nhận lại. Đang submit khóa form/chống bấm kép.

Giữ immutable input+key trong bộ nhớ và sessionStorage theo accountId/transactionId trước submit, phục hồi khi remount. Không lưu token. Lỗi mạng/503/500/401/403 hoặc idempotency conflict chưa xác định giữ nguyên lệnh, hiển thị rõ chưa biết kết quả; nút tra cứu dùng GET operation rồi GET transaction nếu chưa thấy, nút gửi lại dùng đúng input/key. 404 operation không được coi là thất bại. Trình duyệt chặn storage thì vẫn giữ key trong component và thông báo cần giữ trang mở.

409 reference không tự đổi mã để lách lỗi, input còn nguyên và cần preview lại. Giao dịch đã hoàn tất/hủy được tải lại. Sau200 hiển thị số chứng từ, kỳ actual, membershipId và notificationState; đọc chứng từ lỗi hoặc socket không kết nối không phủ nhận settlement đã commit. Trang US-14 có liên kết sang đối chiếu thanh toán. Không upload, gọi ngân hàng, tạo PDF/email/hóa đơn điện tử, RETAIL hoặc giả lập refund.

## Kiểm chứng

- `backend/test/settlement.integration-spec.ts`: hai Nest instance, JWT/role/session thật, MongoDB replica set8.0.17 riêng với DB `gym_test_us22_<suffix>`. End-to-end HTTP từ tạo member US-09 → sale US-14 → preview US-21 → confirm → đọc invoice/gói. Test TC01–TC16, rollback invoice/activation/outbox/transaction/operation, snapshot buyer khi US-10 cạnh tranh, hai key/cùng key, cùng reference, cancel race, time/free sale. Barrier buộc cả hai confirm đọc xong trước khi ghi payment để kiểm unique reference thực tế. Test commit thành công rồi giả lập mất reply kiểm503 → lookup/replay đúng IDs. Fault injection được giới hạn ở điểm lỗi; không override guard/transaction/database bằng mock.
- `backend/test/payment-schema.spec.ts`: điều kiện SUCCEEDED và tương thích trạng thái lịch sử PENDING/FAILED.
- `frontend/src/features/payments/settlement.test.tsx`: component/API mock cho TC17, không auto confirm, pending/bấm kép, giữ key qua remount, lookup404/commit unknown, reference conflict, chứng từ lỗi sau success và JSON headers. Không thay thế demo trình duyệt nối backend thật hoặc kiểm ngân hàng thực tế.
- Regression: các suite US-21/US-14/US-17/financial integrity, unit backend, typecheck/build backend/frontend và test frontend. Kết quả thực tế được báo trong phiên làm việc; không mặc định toàn bộ sprint hoặc CI từ xa đã nghiệm thu.

Sequence: [settlement-sequence.mmd](settlement-sequence.mmd). Hợp đồng đối chiếu: [payments-review-contract.md](payments-review-contract.md).
