# US-14 / UC-20 — Đăng ký và kích hoạt gói tại quầy

Tích hợp US-22: `PaymentsModule` gọi port `SaleActivation` hiện có; prepareSettlement chạy sau khóa member→transaction và ghi payment/invoice cùng session, activation/outbox/operation cùng commit. Trang bán gói dẫn sang đối chiếu thanh toán; nhánh miễn phí nội bộ giữ nguyên. Xem [settlement-contract.md](settlement-contract.md) và test API thật `settlement.integration-spec.ts` (phần thanh toán không còn chỉ kiểm bằng fixture).

Nguồn: `Requirement_US-14.docx`, phiên bản 1.0, ngày 27/10/2026 do người dùng cung cấp. Đã đối chiếu văn bản/bảng US-12/21/22 trong cùng thư mục và các đoạn hợp đồng khóa/event liên quan của EN-02/03. Bổ sung triển khai cho UC-20; không thay đổi mã F01–F06, AC01–AC04 hoặc TC01–TC16. Sơ đồ: [service-sales-sequence.mmd](service-sales-sequence.mmd).

## Phạm vi và phụ thuộc

STAFF/ADMIN bán REGISTER cho hồ sơ member đã tồn tại, kể cả chưa link account. GYM/PT độc lập. Không tạo member tự động, không gia hạn/nâng cấp/hoàn tiền, không sửa sale PENDING và không tự hủy theo thời gian.

US-14 cung cấp API bán/hủy, hoàn tất gói miễn phí và activation port nội bộ. Khi tạo sale có phí, giao dịch vẫn PENDING và chưa cấp gói; US-21/22 cung cấp đối chiếu, xác nhận thu và đọc chứng từ. Chỉ sau xác nhận US-22 thành công mới SETTLED và có membership. Không suy ra nghiệm thu toàn bộ sprint từ việc đã có source hoặc test riêng của US-14.

## Hợp đồng REST

Mọi endpoint dưới `/api/service-sales` yêu cầu JWT STAFF/ADMIN; FixedPermission dùng catalog EN-02. Input lạ bị validation chung từ chối. Tiền luôn là chuỗi VND, ngày là YYYY-MM-DD Việt Nam. Lỗi theo `{error:{code,message,details?},requestId}`.

| Endpoint | Input / đầu ra |
| --- | --- |
| GET `/plans` | `{items:[{id,name,kind,planVersion,durationDays,sessions,price,benefits}]}`; chỉ ACTIVE, không cung cấp API sửa catalog |
| POST `/preview` | `{memberId,planId,planVersion,startDate}` → 200 `{planVersion,amountDue,kind,requestedStartDate,expectedEndDate,canProceed,blockingCode?}`; không ghi/giữ điều khoản |
| POST `/` | Cùng input preview; `Idempotency-Key` UUID v4, SALE_REGISTER → 201 chi tiết sale |
| GET `/:id` | Chi tiết snapshot, transactionStatus/transactionVersion, các ID đã có; đọc nhất quán trong một snapshot MongoDB |
| GET `/?memberId=...&page=1` | Danh sách sale PENDING của member: `{items:[{saleId,transactionCode,kind}],page,total}`; 20 bản ghi/trang |
| POST `/:id/cancel` | `{version,reason}`; lý do trim 10–500 ký tự; SALE_CANCEL → 200 `{saleId,transactionId,status:'CANCELLED'}` |

Chi tiết gồm saleId/memberId/planId/transactionId/transactionCode, transactionStatus/transactionVersion, amountDue/kind/operation, planName/benefits/sessions/listPrice/creditAmount/policySnapshot, requestedStartDate/startDate/endDate, durationDays/planVersion (nếu snapshot có), membershipId/invoiceId/invoiceNumber/paymentId (nếu đã có), notificationState và cancelReason (nếu có). Không trả request_key, revision, token hoặc MongoDB error.

Các mã 409: PLAN_CHANGED, PLAN_NOT_AVAILABLE, CURRENT_SERVICE_EXISTS, PENDING_SALE_EXISTS, VERSION_CONFLICT, INVALID_TRANSACTION_STATE, IDEMPOTENCY_CONFLICT. ID/ngày/input sai: 400; thiếu token: 401; sai role: 403; không tồn tại: 404; DB/không hỗ trợ transaction: 503.

## Ghi dữ liệu và khóa

- Tạo: IdempotencyService chạy một transaction, khóa `plans.guard_revision` rồi `members.service_revision`, đọc lại gói ACTIVE/version và kiểm một kind. Điều khoản chỉ đọc từ DB. Request đồng thời khác key phải tranh cùng revision member.
- Giá > 0: chỉ transaction PENDING + sale REGISTER. Không có membership/payment/invoice/notification hoàn tất.
- Giá = 0: snapshot price=0 và credit=0 là căn cứ; ZeroSettlement gọi activation cho sale vừa tạo, ghi invoice0, SETTLED/version+1 và notification/recipient/outbox trong cùng session. Không có payment0. Chứng từ dùng số `INV-` + invoice ObjectId và buyer_snapshot có tên/mã/phone hội viên theo US-22-F07. Event key dùng `SERVICE_SALE_SETTLED:` + saleId theo EN-03.
- Hủy: khóa member → transaction, kiểm PENDING/version và không có payment SUCCEEDED, ghi audit + CANCELLED/version+1. Giữ nguyên sale/history; giải phóng ý định đăng ký cùng loại.
- Một kind bị chặn khi có sale PENDING khác, hoặc membership ACTIVE + transaction SETTLED cùng kind với end_date ≥ hôm nay, bao gồm gói chờ hiệu lực. Sale cũ thiếu kind_snapshot dùng transaction.kind để kiểm, không đọc lại plan.
- Ngày bắt đầu yêu cầu ≥ hôm nay Việt Nam. `end = start + durationDays - 1`; activation dùng `max(requestedStart, serverConfirmationDate)`. `receivedAt` không quyết định ngày hiệu lực. Chỉ REGISTER_V1 dùng luật này.

## Điểm tích hợp US-22

`SalesModule` export abstract port `SaleActivation`. `activateSaleWithinSession(session,{saleId,memberId,transactionId},prepareSettlement?)` nhận session đang trong transaction, không mở transaction con, tự khóa member rồi transaction và kiểm lại trạng thái/chủ thể/snapshot/điều kiện cùng kind. Callback prepareSettlement cho US-22 đọc lại dữ liệu/ghi payment và invoice SAU khi lấy khóa, trước khi activation kiểm chứng payment và cấp membership. Không acquire khóa riêng rồi gọi port lần hai.

US-22 kiểm lại căn cứ bằng PaymentReviewService rồi lưu payment SUCCEEDED với amount đúng trong cùng session, qua callback prepareSettlement; port kiểm payment và từ chối cấp gói có phí khi chưa thu đủ. Port tạo một membership với sessions_used=0, ghi kỳ thực tế; unique service_sale_id bảo vệ cấp đôi. US-22 ghi invoice trong callback, sau đó SETTLED và persistBusinessEvent cùng session, cùng event key `SERVICE_SALE_SETTLED:<saleId>`; bất kỳ lỗi nào phải rollback toàn bộ. Không dùng HTTP nội bộ, job/socket sau commit để cấp gói. Không đổi lại snapshot theo catalog đã thay đổi/ngừng bán.

`ZeroSettlement` tách thành port nhận activation callback để module thu tiền tương lai có thể thay implementation mà không tạo phụ thuộc Nest vòng. Nhánh miễn phí dùng khóa của lệnh tạo và transaction mới chưa thể nhìn thấy từ session khác; không acquire khóa lần hai.

## Schema và migration

| Collection | Bổ sung |
| --- | --- |
| plans | PlansModule sở hữu schema/read service dùng chung, chưa có CRUD/policies US-12. Theo US-12-F02: duration 1–3650, GYM quota0, PT quota1–10000; version Int32=0; guard_revision Int64=0. Không nhân bản schema trong SalesModule. Báo cáo cũ ghi duration ≥ 0 cần đồng bộ theo US-12 |
| transactions | version=0; settled_at/cancelled_at/cancelled_by/cancel_reason; Int64 guard_revision giữ EN-02; code=`TX-`+ObjectId; unique code/request_key; index member_id/status/kind |
| service_sales | requested_start_date/duration_days_snapshot/kind_snapshot/plan_version_snapshot/created_at; start/end dự kiến ở PENDING, thực tế ở SETTLED; policy_snapshot vẫn là JSON string REGISTER_V1 ≤ 2000; unique transaction_id; index member_id/kind_snapshot |
| memberships | created_at, version=0, unique service_sale_id; quota/ngày đọc từ sale snapshot |

Chạy `cd backend; npm run ensure-indexes` trước khi dùng với DB có sẵn. Lệnh dùng migration Int64 EN-02, tạo index và chỉ backfill version còn thiếu ở plans/transactions/memberships. Không sửa snapshot cũ hoặc suy đoán duration/version/requestedStart của sale lịch sử. Sale cũ thiếu snapshot REGISTER_V1 không thể tự kích hoạt bằng handler mới; cần đối chiếu điều khoản gốc để chuyển dữ liệu có kiểm soát. Không tự chạy migration vào DB người dùng trong lần triển khai source này.

Production chỉ kiểm index khi khởi động; dev/test tạo các unique constraints tài chính cần cho luồng bán. Thiếu/sai index hoặc dữ liệu trùng thì dừng, không tự xóa dữ liệu/index. Không thêm env hoặc dependency.

## Kiểm chứng và giới hạn nghiệm thu

`backend/test/service-sales.integration-spec.ts` dùng Supertest, JWT thật, MongoDB replica set và hai Nest instance: AC01/02 và phần US-14 của AC03/04; bao phủ preview/PENDING, quyền/input/version, price0/no-payment0, snapshot, ngày, khóa thật, replay, cancel và rollback notification. Test activation có phí dùng payment fixture trong cùng transaction để kiểm port; không đại diện API US-22 hoặc đầy đủ TC13/15 qua thu tiền thật.

`frontend/src/features/sales/sales.test.tsx` kiểm TC16: xác nhận điều khoản, pending/free, giữ nguyên input/key sau mất mạng và remount, chống bấm kép, PLAN_CHANGED, lý do/version/retry cancel. Đây là component test với API mock, không thay bằng chứng nghiệm thu UI nối server thật.

UI lưu yêu cầu chưa rõ kết quả trong sessionStorage theo account và member; không lưu token. Bản nhập bị khóa đến khi gửi lại cùng key có kết quả rõ. Đăng ký chờ được tải từ DB để mở lại; quyền không dựa vào việc ẩn nút.

## Kiểm tra thủ công

1. Với DB phát triển hỗ trợ replica set, chạy `npm run ensure-indexes` tại backend rồi `npm run start:dev`; chạy `npm run dev` tại frontend. Không dùng DB production để tạo dữ liệu thử.
2. Đăng nhập STAFF/ADMIN, tạo hoặc chọn một hồ sơ hội viên. Cần một gói ACTIVE giá có phí và một gói ACTIVE giá 0 trong catalog. Khi US-12 chưa có API quản trị, người vận hành có thể tạo fixture trên DB phát triển bằng mongosh, theo schema bên dưới; không cấp quyền quản trị plan cho STAFF qua API.

```javascript
// Chỉ chạy trên DB phát triển đã chọn rõ; đổi code nếu fixture đã tồn tại.
const planId = new ObjectId();
db.plans.insertOne({ _id: planId, id: planId, code: 'US14-GYM-TEST', name: 'Gym thử nghiệm 30 ngày',
  kind: 'GYM', duration_days: NumberInt(30), session_quota: NumberInt(0),
  price: NumberDecimal('300000'), benefits: 'Tập Gym 30 ngày', status: 'ACTIVE',
  version: 0, guard_revision: NumberLong(0) });
// Tạo fixture miễn phí với ObjectId/code mới và price: NumberDecimal('0').
```

3. Trong hồ sơ, bấm Đăng ký gói → chọn gói/ngày → Xem trước → Xác nhận. Giá có phí phải PENDING, kỳ dự kiến và không membership/payment/invoice; không báo đã kích hoạt. Mở lại từ danh sách chờ; hủy cần lý do ≥10 ký tự. Sau hủy có thể tạo lại cùng kind.
4. Dùng hội viên khác cho gói miễn phí: phải SETTLED, có membership/chứng từ và thông báo đã lưu (NO_LINKED_ACCOUNT nếu chưa liên kết), không payment. Gói bắt đầu tương lai chưa có quyền hiện tại; làm mới hồ sơ để xem entitlement.
5. Ngắt mạng sau gửi rồi khôi phục: dùng nút gửi lại cùng yêu cầu. Tải lại trang/mở lại panel vẫn giữ key chưa rõ kết quả. Gửi hai request khác key cho cùng member/kind chỉ một lệnh được tạo. MEMBER/TRAINER gọi trực tiếp API phải 403.
6. Với sale có phí, mở liên kết Đối chiếu thanh toán, tìm mã giao dịch, nhập căn cứ/tiền → preview READY → xác nhận đã thực nhận → Xác nhận thu tiền. Kiểm SETTLED, một payment/invoice/membership và thông báo đã lưu; mở chứng từ để xem snapshot/kỳ actual. Test API tích hợp thật nằm trong `settlement.integration-spec.ts`; demo trình duyệt và căn cứ thực nhận cần kiểm trên môi trường thử nghiệm phù hợp.
