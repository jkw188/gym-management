# US-17 — UC-11 nhánh đọc / Q08, Q12: gói tập và giao dịch của chính Member

Nguồn: `Requirement_US-17.docx` phiên bản 1.0, ngày 27/10/2026. Giữ nguyên phạm vi US-17-F01–F05 và US-17-AC01–AC03 (TC01–TC12).

## Dữ liệu và quyền

Chỉ MEMBER có phiên hiện hành (JWT hợp lệ, account ACTIVE, phiên chưa thu hồi, `auth_version` khớp) được gọi. Quyền cố định trong `access.policy.ts`: `memberships.readOwn`, `serviceSales.readOwn`, `transactions.readOwn`, `invoices.readOwn`, chỉ cấp cho MEMBER. TRAINER/STAFF/ADMIN dùng API nội bộ của US-11/US-22, không dùng API cá nhân này.

Chủ thể luôn lấy từ principal: `MemberOwnerReader` tìm `members.account_id = principal.accountId`. Không nhận `memberId`/`accountId` trên query hoặc body, không tự nối hồ sơ theo phone. US-18/19/20 dùng cùng reader.

Chủ sở hữu được lọc ngay trong MongoDB, trước khi nối dữ liệu:
- `service_sales.member_id` = member hiện hành;
- `memberships` qua `service_sale_id` → sale của member;
- `transactions.member_id` = member hiện hành; chi tiết sale yêu cầu transaction của sale cũng cùng chủ;
- `invoices` qua `transaction_id` → transaction của member;
- `pt_bookings` chỉ đếm cho membership đã xác nhận là của member.

US-14/16/22/28 chưa có trong repository nên `MembershipsModule` tạm khai báo schema **chỉ đọc** cho `service_sales`, `memberships` (memberships/schemas), `transactions`, `payments`, `invoices` (payments/schemas) và `pt_bookings` (bookings/schemas) theo báo cáo mục 4.2.9–4.2.13, 4.2.23, 4.2.24. Các US đó phải dùng lại hoặc chuyển schema về module của mình. Index unique tài chính do EN-02 (`financial-integrity.ts`) sở hữu; US-17 chỉ thêm `service_sales(member_id, _id DESC)` và `pt_bookings(membership_id, status)`.

GET không ghi gì: không tạo sale, không cấp gói, không đổi `memberships.status`, không đánh dấu thông báo đã đọc (F05).

## API

| API | Input / output |
| --- | --- |
| `GET /api/me/memberships` | Query `page?,limit?,kind?,storedStatus?,timeState?` → 200 `MeListPage<MeMembershipDto>` |
| `GET /api/me/memberships/:id` | → 200 `MeMembershipDto`; của người khác/không có → 404 |
| `GET /api/me/service-sales` | Query `page?,limit?` → 200 `MeListPage<MeServiceSaleDto>` |
| `GET /api/me/service-sales/:id` | → 200 `MeServiceSaleDto`; của người khác/không có/transaction lệch chủ → 404 |
| `GET /api/me/transactions/:id` | → 200 `MeTransactionDto`; của người khác/không có → 404 |
| `GET /api/me/invoices/:id` | → 200 `MeInvoiceDto` nếu transaction gốc là của mình; ngược lại 404 |

Query danh sách:
- `page`: số nguyên ≥ 1, mặc định 1. `limit`: số nguyên 1–100, mặc định 20.
- Chỉ `/me/memberships` nhận thêm: `kind` = `GYM|PT` (lấy từ `transactions.kind`), `storedStatus` = `ACTIVE|SUPERSEDED|CANCELLED`, `timeState` = `CURRENT|SCHEDULED|EXPIRED`.
- Field ngoài danh sách (gồm `memberId`, `accountId`) hoặc giá trị ngoài enum → 400.
- Thứ tự `_id DESC` (mới nhất trước), vì báo cáo mục 4.2.11–4.2.12 không có `created_at` cho sale/membership.

`MeListPage<T>`: `memberLinked,items,page,limit,total,totalPages,asOf`. Rỗng thì `totalPages=0`. Account chưa liên kết hồ sơ → 200 `memberLinked=false,items=[],total=0` (trạng thái UX, không phải lỗi). `asOf` là thời điểm đọc; nhiều request không cam kết một snapshot chung.

`MeMembershipDto`: `id,serviceSaleId,transactionId,previousSaleId?,operation,storedStatus,timeState,kind?,planName,benefits,startDate,endDate,sessionsQuota,sessionsUsed,sessionsReserved,sessionsAvailable`.
- Tên, quyền lợi, kỳ, quota lấy từ snapshot của sale, không đọc lại `plans` (F02, TC08).
- `storedStatus` = `memberships.status` như DB. `timeState` theo ngày Việt Nam (`ServerClock`): `CURRENT` nếu `startDate ≤ hôm nay ≤ endDate` (ngày cuối vẫn dùng được), `SCHEDULED` nếu chưa tới, `EXPIRED` nếu đã qua. Bộ lọc và nhãn dùng cùng luật trong service.
- Chỉ `storedStatus=ACTIVE` và `timeState=CURRENT` là gói đang cấp quyền; sale PENDING chưa có membership.
- `sessionsReserved` = số `pt_bookings` BOOKED của chính membership; `sessionsAvailable = max(sessionsQuota − sessionsUsed − sessionsReserved, 0)`. `sessionsUsed` đã gồm phần mang sang khi nâng cấp, không cộng các phiên bản gói cũ (F03, TC07). Gói GYM có quota 0; giao diện dựa vào `kind` để hiện "Không áp dụng số buổi PT".

`MeServiceSaleDto`: `id,transactionId,previousSaleId?,membershipId?,operation,status?,planName,benefits,policy,startDate,endDate,listPrice,creditAmount,amountDue?,sessionsQuota`. `status`/`amountDue` lấy từ transaction của sale (PENDING/SETTLED/CANCELLED). Spec có `channel`, `quoteExpired`, `quoteExpiresAt`, `transactionVersion` nhưng schema mục 4.2 chưa có field tương ứng nên chưa trả.

`MeTransactionDto`: `id,code,kind,status,amountDue,createdAt,payment?,invoiceId?,membershipId?`. `payment = {method,amount,paidAt?}` chỉ khi có khoản thu `SUCCEEDED` (F04).

`MeInvoiceDto`: `id,invoiceNo,transactionId,issuedAt,totalAmount,buyer`. `buyer` = `invoices.buyer_snapshot`, không đổi theo hồ sơ hiện tại (TC09).

Không bao giờ trả: `member_id`, `created_by`, `request_key`, `guard_revision`, `payments.reference`, `verified_by`, ghi chú đối chiếu hay khóa idempotency. Tiền là chuỗi số nguyên VND (EN02-D02); ngày kỳ gói dạng `YYYY-MM-DD`; thời điểm là ISO UTC. API camelCase, DB snake_case.

## Lỗi

Envelope EN01-D03: `{error:{code,message,details?},requestId}`; không xuất MongoDB error thô.

| HTTP | Mã | Khi nào |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Query ngoài allowlist, `page/limit` sai, `kind/storedStatus/timeState` ngoài enum |
| 400 | `INVALID_ID` | `:id` không phải ObjectId 24 ký tự hex |
| 401 | `UNAUTHORIZED` | Không token, account LOCKED, phiên đã thu hồi, `auth_version` đổi |
| 403 | `FORBIDDEN` | Role khác MEMBER |
| 404 | `NOT_FOUND` | Không tồn tại, của người khác, chưa liên kết hồ sơ, hoặc chuỗi sale→transaction→invoice lệch chủ; cùng mã và cùng thông điệp cho "không có" và "của người khác" |
| 503 | `DATABASE_UNAVAILABLE` | Hạ tầng MongoDB lỗi |

## Giao diện

`/member/memberships` (`MyMembershipsPage.tsx`, chỉ MEMBER) chỉ gọi GET. Gói được chia thành "Gói hiện hành", "Gói chờ hiệu lực", "Lịch sử gói" theo `storedStatus`/`timeState` của server; thêm "Giao dịch chờ xác nhận" và "Lịch sử mua"; xem giao dịch rồi chứng từ. React không tự tính ngày hay quota. Trang tải tối đa 100 bản ghi mỗi danh sách; `total` lớn hơn thì hiện "Đang hiện N … gần nhất trên tổng T". Lỗi mạng hiện thông báo kèm "Thử lại", khác trạng thái chưa có gói/chưa liên kết. Đổi account thì xóa ngay dữ liệu cũ. Nút đăng ký/gia hạn/nâng cấp (US-18/19/20) chưa có vì các trang đó chưa tồn tại.

## Nghiệm thu

Backend (Jest, replica set tạm, login/JWT thật): `me-memberships-api.integration-spec.ts` (TC01–TC04), `me-memberships-state.integration-spec.ts` (TC05–TC08), `me-memberships-history.integration-spec.ts` (TC09–TC11), `me-memberships-hardening.integration-spec.ts` (TC02, TC05, TC08 biên và join lệch chủ). Frontend (Vitest): `memberships.test.tsx` (TC09, TC11, TC12), `memberships-route.test.tsx` (TC04). Dữ liệu gói/thu trong test được ghi thẳng theo mục 4.2 vì luồng bán gói US-14/16/22 chưa có; cần chạy lại khi các US đó xong trước khi coi DoD "dữ liệu gói/thu thật" là đạt.
