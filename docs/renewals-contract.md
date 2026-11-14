# US-15 / UC-21 — Gia hạn gói tập tại quầy

Nguồn: `docs/PM/SPRINT3/[GM]Requirement_US-15.docx` v1.0 ngày 27/10/2026; Q05/Q08. Giữ nguyên F01–F07, AC01–AC04 và TC01–TC14. Bổ sung hợp đồng US-14/US-22/EN-02, không thay REGISTER_V1 hoặc nghiệp vụ nâng cấp.

## UC-21 và API

Staff/Admin chọn kỳ từ lịch sử hội viên, xem điều khoản hiện hành của **cùng plan**, preview rồi xác nhận tạo gia hạn. Giá có phí chỉ tạo ý định PENDING; thu tiền dùng API US-21/22 hiện có. Hoàn tất cấp một kỳ riêng, không sửa kỳ nguồn. Không có API gia hạn quầy dành cho Member/PT.

| Endpoint | Hợp đồng |
| --- | --- |
| `POST /api/service-renewals/preview` | STAFF/ADMIN; `{memberId,previousSaleId,planVersion}` → 200 `{previousSaleId,sourceEndDate,amountDue,expectedStartDate,expectedEndDate,planVersion,asOf,canProceed,blockingCode?}`. Đọc snapshot transaction, không ghi/giữ giá |
| `POST /api/service-renewals` | Cùng input; UUIDv4 Idempotency-Key → 201 SaleResult US-14, thêm operation RENEW, previousSaleId, channel COUNTER |
| `GET /api/service-sales/:id` | Snapshot/kỳ dự kiến hoặc thực tế, trạng thái thu, previousSaleId/channel và IDs membership/chứng từ |
| `GET /api/operations/SALE_RENEW/:key` | Chỉ actor của lệnh còn quyền xem kết quả; 404 chưa thấy không có nghĩa thất bại |
| `POST /api/transactions/:id/payment-preview`, `confirm-payment` | Tái sử dụng US-21/22, không tạo endpoint thu riêng |
| `POST /api/service-sales/:id/cancel` | SALE_CANCEL, chỉ PENDING/version đúng và chưa có payment SUCCEEDED |

Không nhận startDate, giá, duration, planId, channel hoặc preferredPaymentMethod trong DTO quầy. Không nhận actorId từ client. Input/key sai400, thiếu phiên401, sai vai trò403, nguồn không tồn tại/khác member404; xung đột409, hạ tầng503; envelope EN01-D03. Quyền API quầy dùng `serviceSales.create` (ADMIN/STAFF).

## Nguồn, điều khoản và ngày

- Nguồn phải có transaction SETTLED, membership ACTIVE; không nối từ PENDING/chưa cấp/CANCELLED/SUPERSEDED. Nguồn và transaction cùng member, cùng kind GYM/PT. Nguồn lịch sử thiếu kind_snapshot dùng transaction.kind, không đọc loại từ plan để thay lịch sử.
- Đuôi là sale SETTLED cùng member/kind có end_date lớn nhất (cùng ngày thì _id giảm dần); nguồn có successor SETTLED cũng không là đuôi. Nguồn cũ trả SOURCE_NOT_LATEST; nguồn không đủ điều kiện trả SOURCE_NOT_ELIGIBLE. Đây là cách xác định nguồn cụ thể theo F01/F05, không tự chuyển sang kỳ khác.
- Khi tạo, plan_id phải trùng nguồn, ACTIVE/cùng kind và planVersion hiện hành. Snapshot lấy **giá, duration, quota, benefits và version mới**, credit_amount=0. Gói đổi/ngừng bán sau tạo không thay snapshot hoặc chặn thanh toán nghĩa vụ đã chốt.
- `RENEW_V1`: tại settlement, nếu endNguồn >= ngày hoàn tất VN, start=endNguồn+1; nếu đã hết, start=ngày hoàn tất. end=start+durationSnapshot−1. Không dùng receivedAt làm ngày bắt đầu. Preview/requested_start_date chỉ là dự kiến, không giữ ngày/giá.
- Kỳ mới có membership ACTIVE, sessions_used=0, quota riêng từ snapshot. CURRENT/SCHEDULED/EXPIRED vẫn được suy ra từ ngày theo US-11/17. Không ghi EXPIRED vào DB, không chuyển quota hoặc booking cũ sang kỳ mới.

## Atomic, dispatch và hai kênh

`RenewalService.create(actorId,input,key,channel)` là service dùng chung COUNTER/SELF_SERVICE. Controller quầy luôn truyền COUNTER. US-19 phải thêm adapter kiểm ownership rồi gọi cùng service; US-15 không mở endpoint self-service. Test race dùng port nội bộ ở instance thứ hai, không giả lập đã hoàn thành API US-19.

EN02-D01 bổ sung operation **SALE_RENEW**. Hash chuẩn hóa bao gồm actor, memberId, previousSaleId, planVersion, channel; giữ result cùng transaction. Cùng key/payload replay đúng kết quả ban đầu; đổi nguồn/kênh/payload trả IDEMPOTENCY_CONFLICT. Lookup Member chỉ thấy lệnh SELF_SERVICE do chính actor đó tạo qua adapter được cấp quyền; không đọc kết quả của Staff.

Tạo lấy khóa **plan → member** rồi kiểm lại toàn bộ nguồn/plan/pending trong callback. REGISTER/RENEW/UPGRADE dùng cùng ràng buộc một PENDING/member/kind và khóa members.service_revision. Các writer tương lai phải tuân thủ cùng khóa, không dùng kiểm tra bên ngoài transaction.

Settlement lấy **member → transaction** qua SaleActivation port rồi dispatch theo sale.operation. RENEW gọi `RenewalService.activateWithinSession`; kiểm lại nguồn/đuôi/pending, payment đủ tiền, snapshot/rule, tính ngày và ghi membership mới trong session hiện hành. Không lấy khóa plan live sau member, không áp điều kiện REGISTER “không gói hiện tại” cho RENEW. Payment/invoice, actual sale dates, membership, SETTLED, notification/recipient/outbox và operation result cùng commit hoặc cùng rollback.

Giá 0 dùng ZeroSettlement với callback RENEW: invoice0 + membership/event cùng transaction tạo, không payment0. Event `SERVICE_SALE_SETTLED:<saleId>` có title gia hạn, nội dung RENEW và kỳ mới; recipient cố định theo liên kết member khi commit.

## Schema và migration

`service_sales` giữ snapshots hiện có; previous_sale_id bắt buộc với RENEW, policy_snapshot.rule=RENEW_V1. Thêm channel COUNTER/SELF_SERVICE (default COUNTER), preferred_payment_method CASH/TRANSFER optional, chỉ là lựa chọn dự kiến, không thay payment thực thu. Không thêm env/dependency/index mới.

Sau backup và dừng writer cũ, chạy `cd backend; npm run ensure-indexes`. Backfill **chỉ** sale thiếu channel thành COUNTER; không sửa created_by, tiền hoặc ngày lịch sử. Test CLI chạy hai lần trên DB test riêng. Không tự chạy migration vào DB phát triển/production của người dùng khi triển khai source.

## UI và kiểm chứng

Từ chi tiết hội viên → Lịch sử gói → Gia hạn kỳ được chọn. UI tải danh mục hiện hành, hiển thị giá/thời hạn/quota mới, nguồn và ngày hết, rồi gọi preview. Chưa thu phải ghi rõ chưa cấp kỳ mới. Sau thu, tải kết quả để xem actual dates và làm mới lịch sử nhiều kỳ. Hủy chờ dùng panel giao dịch chờ US-14.

409 nguồn/plan yêu cầu tải lại lịch sử/điều khoản và preview/xác nhận lại; không tự thay nguồn. Submit kép bị chặn. Mất response/503/401/403/idempotency conflict giữ input+key trong memory/sessionStorage theo actor/member; tra cứu SALE_RENEW trước hoặc gửi lại đúng key. Lookup404 không tạo key mới. Browser chặn storage thì cảnh báo giữ trang mở. Không có form nhập khoản thu0.

| AC/TC | Kiểm tra |
| --- | --- |
| AC01, TC01–04 | `backend/test/service-renewals.integration-spec.ts`: API, JWT/Guard/RBAC thật, ownership, nguồn/đuôi/plan/version/snapshot |
| AC02, TC05–08 | Ngày VN/ngày cuối/kỳ tương lai/năm nhuận/thu chậm; kỳ cũ, quota và fixture BOOKED bất biến; US-11/17 đọc nhiều kỳ |
| AC03, TC09–12 | Hai Nest instance và MongoDB replica set thật; quầy/quầy và quầy/SELF_SERVICE port; shared pending, hai confirm, rollback activation/outbox, mất commit reply/replay, cancel race |
| AC04, TC13–14 | Free completion thật; `frontend/src/features/sales/renewals.test.tsx` cho pending, stale, lookup/retry/remount, bấm kép và history. Frontend dùng API mock/jsdom |

Backend: `npm run test:integration -- --runTestsByPath test/service-renewals.integration-spec.ts`. Frontend: `npm test -- --pool=threads --maxWorkers=1 src/features/sales/renewals.test.tsx`. Sequence: [renewals-sequence.mmd](renewals-sequence.mmd). Kết quả chạy được báo riêng; test tự động không thay nghiệm thu trình duyệt/HTTPS trên môi trường triển khai.
