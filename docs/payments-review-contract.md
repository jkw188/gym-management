# US-21 / UC-23 — Tra cứu và đối chiếu khoản thanh toán

Nguồn: `docs/PM/SPRINT2/Requirement_US-21.docx` v1.0 (27/10/2026), toàn bộ văn bản và bảng; không có ảnh/sơ đồ nhúng. Đối chiếu hợp đồng US-22, EN-02/03, EN-04 và `service-sales-contract.md`. Bổ sung nhánh đối chiếu UC-23 theo Q05, giữ nguyên mã yêu cầu, AC và TC. Không sửa bản Requirement DOCX hoặc trạng thái nghiệm thu.

## API và dữ liệu

Chỉ STAFF/ADMIN với JWT/session hiện hành (`transactions.read`); Member/PT không truy cập được cả ba API. Quyền xác nhận `transactions.confirmPayment` thuộc US-22, không được gọi bằng preview.

| API | Hợp đồng triển khai |
| --- | --- |
| `GET /api/transactions` | kind GYM/PT, status PENDING/SETTLED/CANCELLED, memberId, q tìm mã theo chuỗi literal, createdFrom/createdTo, page=1, limit=20 (tối đa100). Chỉ nguồn GYM/PT thật; RETAIL trả400 `UNSUPPORTED_KIND`. Trả items/page/limit/total/totalPages; mỗi item có transaction/member/sale IDs, mã, khách, tiền VND string, trạng thái, version và timestamp. Không có kết quả thì totalPages=0. |
| `GET /api/transactions/:id` | transaction, sale snapshot nếu có, payments[], invoice nếu có, membershipId nếu có, asOf. Projection và mapper allowlist; không trả request_key/hash/key, guard_revision, credentials. Buyer snapshot đọc nguyên từ invoice; không thay bằng hồ sơ hiện tại. |
| `POST /api/transactions/:id/payment-preview` | method CASH/TRANSFER, amount string VND, evidenceNote trim10–500; TRANSFER cần receivingAccountCode, bankReference, receivedAt. Trả200 canConfirm/reviewState/blockingCodes/amountDue/normalizedReference?/asOf. Chỉ đọc. |

Ngày lọc là ngày lịch hợp lệ Việt Nam; khoảng UTC `[00:00+07 của from, 00:00+07 ngày sau to)`, bao gồm toàn bộ ngày cuối. from/to có thể gửi độc lập; khi có cả hai phải from≤to. Không áp giới hạn 31 ngày của module lịch PT vào tra cứu thanh toán. ID sai400, không có member/giao dịch404, query lạ/sai400; MongoDB lỗi503 với error envelope và requestId hiện có.

Sắp `created_at DESC, _id DESC`. Facet đếm và phân trang ở MongoDB, lookup sale sau giới hạn trang, lấy hồ sơ khách theo lô. Không thực thi regex client. Index mới: `transactions(status,kind,created_at DESC,_id DESC)` và `payments(transaction_id)`; reference unique simple và partial unique SUCCEEDED theo transaction đã do EN-02 sở hữu. Không xóa/sửa index cũ hoặc tự xóa dữ liệu trùng.

## Quy tắc đối chiếu dùng chung với US-22

`PaymentReviewDto` và `normalizePaymentReview` là ranh giới dùng chung: normalize VND bằng decimal, bankReference chỉ trim và giữ native case; canonical `TRF:<accountCode>:<bankReference>`≤100. Account code phải khớp danh sách `RECEIVING_ACCOUNTS` hiện có. Chưa cấu hình trả503; sai mã400. Không thêm env/dependency.

receivedAt TRANSFER bắt buộc ISO8601 có timezone, từ transaction.created_at đến server clock. CASH từ chối reference/tài khoản/timestamp của client, preview không sinh reference hoặc paid_at. US-22 sở hữu việc sinh `CASH:<paymentId>` và thời điểm xác nhận.

`PaymentReviewService.review(id,dto,session?)` được export để US-22 lặp lại đối chiếu trong session sau khi lấy khóa member/transaction. Hàm không giữ reference hoặc ghi khóa. Dùng `SalesRepository.blockingCode` của US-14 để kiểm gói/giao dịch cạnh tranh và kiểm snapshot theo activation; không đọc lại giá gói hiện tại. US-22 vẫn phải kiểm lại dưới khóa, dùng unique reference và partial unique SUCCEEDED làm quyết định cuối cùng, rồi ghi payment/invoice/activation/event/outbox/operation cùng transaction.

| reviewState | Điều kiện |
| --- | --- |
| READY | Input/căn cứ do nhân viên khai báo hợp lệ, tiền khớp, transaction/sale còn đủ điều kiện, không thấy tham chiếu đã dùng tại thời điểm đọc. |
| NEEDS_REVIEW | Amount hợp lệ về định dạng nhưng lệch phải thu (`AMOUNT_MISMATCH`). Trên UI, chưa thực đếm/kiểm báo có cũng hiển thị cần kiểm lại và khóa preview. |
| BLOCKED | ZERO_PAYMENT_NOT_REQUIRED, TRANSACTION_ALREADY_SETTLED, INVALID_TRANSACTION_STATE, SALE_NOT_FOUND, INVALID_SALE_STATE, MEMBERSHIP_ALREADY_EXISTS, PAYMENT_ALREADY_SUCCEEDED, PENDING_SALE_EXISTS, CURRENT_SERVICE_EXISTS hoặc PAYMENT_REFERENCE_USED. Có thể kèm AMOUNT_MISMATCH. |

Thiếu/không hợp lệ căn cứ hoặc dữ liệu chuyển khoản trả400, không tạo payment FAILED. evidenceNote là lời ghi nhận kiểm tra thủ công; server không thể xác minh sự thật của đoạn văn hay báo có ngân hàng. UI bắt nhân viên đánh dấu đã đếm tiền/kiểm báo có, nhắc ảnh người mua chưa đủ căn cứ, không có upload hoặc kiểm ngân hàng tự động. Không dùng suy đoán từ khóa trong note để tuyên bố đã xác thực chứng cứ.

Các field đọc chứng cứ US-22 được bổ sung tương thích dạng optional vào payments: verified_at/evidence_note/receiving_account_code/bank_reference. US-22 hiện ghi đầy đủ metadata và created_at, bắt buộc verified_by/paid_at và amount dương cho SUCCEEDED; không backfill chứng cứ hoặc thời điểm thu giả cho lịch sử.

## Giao diện và tích hợp

`/staff/transactions`, `/admin/transactions` và liên kết từ trang chính Staff/Admin. Mặc định lọc PENDING, có bộ lọc/mã/khách/ngày/phân trang/Retry, chi tiết snapshot gói, lịch sử payment và invoice có thật. Số phải thu và số đối chiếu tách riêng. Đổi input xóa kết quả preview cũ; đang gửi khóa form; lỗi giữ input. Đổi tài khoản/đăng xuất unmount nội dung và bỏ response đến muộn.

**Tích hợp US-22:** sau READY, UI có checkbox xác nhận thực nhận và nút confirm riêng; preview vẫn không ghi/giữ chỗ. Settlement gọi lại cùng review service trong session sau khóa, với PAYMENT_CONFIRM key. Test `settlement.integration-spec.ts` bổ sung US-21-TC10: hai preview READY rồi hai confirm cạnh tranh cùng reference chỉ một commit. Chi tiết: [settlement-contract.md](settlement-contract.md). Không tự đổi trạng thái tracker hoặc kết luận CI/demo trình duyệt đã đạt từ việc có source.

## Kiểm tra và vận hành

- `backend/test/payment-review.integration-spec.ts`: HTTP bootstrap/guards/JWT thật, sale tạo qua US-14 và MongoDB replica set8.0.17 riêng, DB `gym_test_us21_<run suffix>`; chỉ dọn business collections trên connection của server test do suite tạo. Bao phủ TC01–09, phần preview TC10, TC11–13, snapshot toàn collection chứng minh không ghi, index thật. Payment/invoice fixture đọc chi tiết không đại diện API confirm US-22.
- `frontend/src/features/payments/payments.test.tsx`: component với API mock, bộ lọc/phân trang/route, hiển thị tiền/trạng thái/căn cứ, lỗi/Retry, giữ input/pending, không auto confirm, xóa dữ liệu khi logout. Không thay thế demo trình duyệt với backend thật.
- Chạy `cd backend; npm run ensure-indexes` trên DB đích sau khi sao lưu/kiểm tra cấu hình; lệnh đã tạo thêm các lookup index qua schema. Lần triển khai source này không chạy migration vào DB người dùng.
- Chạy backend/frontend bằng `npm run start:dev` / `npm run dev`, đăng nhập Staff/Admin, tạo sale có giá qua US-14 rồi mở Đối chiếu thanh toán. Dùng căn cứ thực tế; amount lệch trả NEEDS_REVIEW, khớp có thể READY; transaction vẫn PENDING, không thêm payment/invoice/membership.

Sequence chung: [transaction-sequence.mmd](transaction-sequence.mmd). US-22 sở hữu paid_at/invoice/settlement, Q13 chỉ tính tiền thực nhận từ payment; không gọi cổng điện tử/webhook/SMS và không giả lập RETAIL/refund.
