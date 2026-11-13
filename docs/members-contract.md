# US-09 / US-10 / US-11 — UC-17 / UC-18 / UC-19: hồ sơ hội viên tại quầy

Nguồn: `Requirement_US-09.docx` phiên bản 1.0, ngày 27/10/2026. Giữ nguyên phạm vi US-09-F01–F06 và US-09-AC01–AC04. Sequence: `members-sequence.mmd`.

## Dữ liệu và quyền

`MembersModule` sở hữu schema `members` và `member_link_events`. US-01 dùng cùng schema qua reader chỉ đọc; không thay chính sách tự đăng ký. Tạo hồ sơ không tạo account hoặc gói. Chỉ STAFF/ADMIN ACTIVE có session hợp lệ được tạo, tra candidate hoặc link. Không nhận actor, mã hội viên, id, revision hay trường gói từ body.

`members`: `_id=id`, `member_code=HV-<ObjectId hex24>`, `full_name`, `phone` chuẩn hóa EN01-D01, `birth_date?` dạng ngày YYYY-MM-DD không tương lai theo Việt Nam, `address?`, `account_id?`, `version`, `created_by`, `updated_by`, `created_at`, `updated_at` và `service_revision` BSON Int64. `account_id` được bỏ field khi tạo.

Index: unique `member_code`, unique `phone`, partial unique `account_id` chỉ áp dụng BSON ObjectId, và `created_at DESC,_id DESC`. `member_link_events` lưu member/account, actor và thời gian server, phương pháp `IN_PERSON_ACCOUNT|IN_PERSON_DOCUMENT`, ghi nhận 10–500 ký tự và `request_key` digest; unique `member_id` và `request_key`.

Không đồng bộ tự động thông tin liên hệ giữa account và member. Không unlink/relink, cấp gói, tạo hộ hoặc mở khóa account trong US-09.

## API

| API | Input / output |
| --- | --- |
| `POST /api/members` | Key UUID v4; `{fullName,phone,birthDate?,address?}` → 201 MemberDto |
| `GET /api/members/link-candidates?phone=...` | Chỉ số đầy đủ; tối đa một MEMBER ACTIVE → `{items:[{id,fullName,phone,canLink}]}` |
| `POST /api/members/:id/link` | Key UUID v4; `{accountId,version,verificationMethod,verificationNote}` → 200 `{member:MemberDto,linked:true}` |
| `GET /api/operations/:operation/:key` | EN-02: chỉ actor sở hữu và còn quyền operation đọc kết quả gốc |

MemberDto: `id,memberCode,fullName,phone,birthDate?,address?,accountId?,version,createdAt,updatedAt`. Ngày giờ là ISO UTC. GET chi tiết dùng chung mapper, bổ sung tổng hợp quyền lợi theo hợp đồng US-11 bên dưới.

Các lỗi nghiệp vụ: `MEMBER_PHONE_EXISTS`, `VERSION_CONFLICT`, `ACCOUNT_ALREADY_LINKED`, `MEMBER_ALREADY_LINKED`, `ACCOUNT_NOT_ELIGIBLE`, `IDENTITY_MISMATCH`, `IDEMPOTENCY_CONFLICT`. ID/dữ liệu sai trả 400; thiếu xác thực 401, sai quyền 403, không tìm thấy 404, hạ tầng 503. Lỗi dùng envelope EN01-D03; không xuất MongoDB error thô.

## Transaction và retry

Tạo dùng MEMBER_CREATE; link dùng MEMBER_LINK với hash payload và member targetId. Kết quả cùng transaction với dữ liệu nghiệp vụ. Link ghi khóa `security_state/account-administration` trước `members.service_revision`, kiểm lại actor/session, account và version, CAS member rồi insert audit. US-07/08 dùng cùng khóa quản trị nên không thể đổi role và link theo hai snapshot độc lập.

US-14/settlement phải dùng `DataGuardsService.acquire` với member tương ứng trước khi đọc recipient; link tăng cùng revision để cố định thứ tự commit. Luồng bán gói/settlement chưa được triển khai ở repository này; test TC14 hiện xác minh hợp đồng guard bằng transaction thật, chưa chứng minh tích hợp settlement hoặc gửi thông báo thực tế.

UI không chọn sẵn account. Nhân viên phải chọn phương pháp, nhập ghi nhận và xác nhận đối chiếu trực tiếp; không thu số CCCD hoặc ảnh giấy tờ. Mất phản hồi giữ ý định và key trong bộ nhớ, khóa sửa dữ liệu, lookup rồi mới gửi lại cùng payload/key nếu OPERATION_UNKNOWN. Reload/đóng tab làm mất bộ nhớ ý định; cần tra hồ sơ US-11 trước khi tạo lại. Trùng phone không tự lặp create bằng key mới.

## Khởi tạo và nghiệm thu

MongoDB phải hỗ trợ transaction (replica set). Chạy `npm run ensure-indexes` trong backend trước khi bật production: tạo index `members`, `member_link_events`, giữ nguyên index đã có, migration EN-02 bổ sung revision thiếu. Không tự xóa hay sửa dữ liệu trùng/cũ; cần rà soát và backup nếu tạo unique index thất bại. Development/test tạo và xác minh index lúc startup; production chỉ xác minh.

`backend/test/members.integration-spec.ts` bao phủ TC01–TC13 trên replica set tạm, hai Nest app/connection, login/JWT thật; TC12 cố ý gây lỗi insert audit để kiểm rollback thật. TC14 kiểm hợp đồng member guard như giới hạn đã nêu. `frontend/src/features/members/members.test.tsx` kiểm TC15 bằng HTTP API giả lập, cần kiểm thêm browser với backend thật. Không coi build hoặc test giao diện giả lập là toàn bộ AC đã nghiệm thu.

## US-10 — UC-19: cập nhật hồ sơ hội viên

Nguồn: `Requirement_US-10.docx` phiên bản 1.0, 27/10/2026; US-10-F01–F05, AC01–AC04, TC01–TC14. Sơ đồ: [members-update-sequence.mmd](members-update-sequence.mmd), [members-class.mmd](members-class.mmd). Phần này không thay chính sách tạo/link US-09 hoặc tài khoản US-04/06.

| API | Input / output |
| --- | --- |
| `GET /api/members/:id` | STAFF/ADMIN → `{member:MemberDto,entitlementSummary:{GYM:[state],PT:[state]},asOf:ISO UTC,businessDate:YYYY-MM-DD}` |
| `PATCH /api/members/:id` | STAFF/ADMIN; `{version,fullName?,phone?,birthDate?,address?}` → `{member:MemberDto,changed:boolean}` |

**Hợp đồng US-11:** `MembersQueryService` phụ trách GET hồ sơ/version và tổng hợp quyền lợi. `entitlementSummary` thay giá trị placeholder `null` trước đây bằng các mảng trạng thái theo loại; mapper và version hồ sơ US-09/10 giữ nguyên. Không dùng summary để ghi gói hoặc xác nhận thu tiền.

`version` bắt buộc số nguyên không âm; ít nhất một trong bốn field hồ sơ. Tên 2–120 ký tự Unicode sau trim/gộp khoảng trắng; phone raw là string tối đa 32 ký tự, dùng EN01-D01. Ngày sinh YYYY-MM-DD có thật, không tương lai theo Việt Nam. Địa chỉ tối đa 255 ký tự sau trim. Omit giữ nguyên; `birthDate:null`, `address:null` hoặc địa chỉ trắng dùng `$unset`. Tên/phone null, rỗng hoặc field ngoài allowlist trả 400 `VALIDATION_ERROR`, lỗi field nằm trong `details`.

Kiểm version trước khi so sánh no-op; cả nhánh sửa và no-op đều match `_id + version` atomically. No-op không tăng version, không đổi actor/timestamp. Sửa thật chỉ `$set/$unset` field thay đổi, `$inc version:1`, `updated_by` từ JWT và `updated_at` từ server. Unique index phone quyết định cuối: trùng trả 409 `MEMBER_PHONE_EXISTS`; version cũ trả 409 `VERSION_CONFLICT`, kể cả payload giống dữ liệu mới. Không tìm thấy trả 404 `MEMBER_NOT_FOUND`, id sai trả 400; 503 `SERVICE_UNAVAILABLE` có requestId và không lộ lỗi kết nối, kể cả lỗi DB ở JWT guard.

Không save lại document snapshot, không ghi `account_id`, `service_revision`, field gói, sale/invoice hoặc account. PATCH một document không thêm transaction/audit nhiều collection. Nếu caller truyền session transaction, phải gọi lại toàn bộ `MembersService.update` trong mỗi retry của TransactionRunner; giữ nguyên version gốc và kiểm lại trên snapshot mới. Lỗi có nhãn transaction được giữ cho driver retry; lỗi nghiệp vụ không tự retry.

UI ở `/staff/members/:id`, `/admin/members/:id`; liên kết từ hồ sơ vừa tạo. Chọn Chỉnh sửa sẽ GET lại dữ liệu/version; mã và account chỉ đọc. Hủy không PATCH. Pending chặn gửi kép; lỗi field/trùng phone giữ bản nhập và focus đúng ô. Conflict hoặc mất response/503 khóa Lưu; muốn GET lại phải xác nhận bỏ bản chưa lưu. Người dùng đối chiếu bản server rồi chủ động sửa/lưu lại. PATCH dùng `requestOnce`, không Idempotency-Key, không tự refresh rồi gửi lại payload. Không lưu draft vào localStorage, không render HTML từ tên/địa chỉ hoặc log hồ sơ.

`backend/test/members-update.integration-spec.ts`: MongoDB 8.0.17 replica set, hai Nest connection, JWT/index thật; TC01–TC11 kiểm cập nhật/allowlist/quyền/validation/unique/no-op, TC12 kiểm link cạnh tranh, transaction dùng member guard và retry kiểm lại version; TC13 kiểm lỗi hạ tầng và dừng MongoDB thật. Sale test là đơn vị công việc kiểm hợp đồng EN-02, **chưa phải tích hợp luồng bán gói US-14**. `frontend/src/features/members/member-update.test.tsx` kiểm TC13–TC14 bằng API giả lập; cần kiểm thêm trình duyệt với backend thật trước khi nghiệm thu toàn bộ DoD. Chưa đánh dấu Done toàn bộ US-10 khi phần phụ thuộc US-11/US-14 chưa được xác minh.

## US-11 — UC-17: tra cứu hội viên và giao dịch

Nguồn: `Requirement_US-11.docx` v1.0 ngày 27/10/2026 được cung cấp trong phiên triển khai; giữ mã US-11-F01–F05, AC01–AC04 và TC01–TC14. Đã đọc nội dung văn bản và mọi bảng; tài liệu này không có drawing. Đối chiếu cấu trúc MongoDB với mục 4.2.10–12, 4.2.23–24 của báo cáo tuần 03 trong `docs`. Sequence: [members-query-sequence.mmd](members-query-sequence.mmd); class: [members-class.mmd](members-class.mmd).

### API, quyền và thời điểm đọc (F01/F05, AC01/AC04)

Tất cả API sau chỉ STAFF/ADMIN có JWT/phiên hợp lệ. Member/PT không có quyền đọc nội bộ. OpenAPI tại `/api/docs` dùng DTO request/response cụ thể. Không thêm endpoint tự phục vụ nhận memberId.

| Endpoint | Query / response |
| --- | --- |
| `GET /api/members` | `q?,kind?,membershipState?,page?,limit?`; items: `id,memberCode,fullName,phone,accountLinked,entitlementSummary` |
| `GET /api/members/:id` | Không nhận query; `{member:MemberDto,entitlementSummary,asOf,businessDate}` |
| `GET /api/members/:id/memberships` | `page?,limit?`; item: `membershipId,saleId,kind,planName,startDate,endDate,storedStatus,timeState,sessionsQuota,sessionsUsed,transactionStatus` |
| `GET /api/members/:id/transactions` | `page?,limit?`; item: `id,code,kind,status,amountDue,createdAt,paymentId?,invoiceId?` |

Mỗi list/history trả `{items,page,limit,total,totalPages,asOf,businessDate}`. `asOf` giữ kiểu ISO UTC để tương thích US-10; `businessDate` là ngày Việt Nam YYYY-MM-DD tại chính thời điểm đó. Không nhận thời gian tính trạng thái từ client. Page mặc định 1, limit 20, tối đa 100; empty `totalPages=0`; vượt trang trả `items=[]` nhưng giữ total. Kiểm cả overflow offset. Query ngoài allowlist, enum/ID/type sai trả 400; member ID đúng không có trả 404 `MEMBER_NOT_FOUND`. Envelope EN01-D03 giữ nguyên; hạ tầng 503 không lộ lỗi MongoDB hoặc bí mật.

GET chỉ đọc, không mở transaction, ghi revision, tạo seed, sửa gói/payment hoặc khóa dữ liệu. `asOf` mô tả thời điểm bắt đầu đọc, không đảm bảo snapshot toàn lịch sử; race có thể tải lại. Không cộng nhiều trang thành báo cáo chính thức.

### Trạng thái và projection (F02–F04, AC02/AC03)

`q` tối đa 120 ký tự, trim rồi tìm contains literal không phân biệt hoa thường trên member_code/full_name/phone; escape toàn bộ ký tự regex. Chỉ phone đầy đủ được normalize bằng EN01-D01 (0/+84…); chuỗi phone chưa đầy đủ giữ literal, không tự thêm tiền tố. Từ khóa ngắn có thể scan ở quy mô đồ án; index không giải quyết contains search.

Summary có cấu trúc `{GYM:state[],PT:state[]}`, thứ tự CURRENT → SCHEDULED → EXPIRED. Chỉ membership ACTIVE nối sale và transaction SETTLED, cùng member_id, mới được tính. CURRENT gồm start_date≤businessDate≤end_date; SCHEDULED start_date>businessDate; EXPIRED end_date<businessDate; NONE khi không có membership ACTIVE/SETTLED trong phạm vi. Một loại có thể có nhiều trạng thái; không ép cả hội viên thành một nhãn. `kind` xác định phạm vi khi lọc `membershipState`; không gửi kind thì xét cả hai loại. Chỉ gửi kind mà không chọn trạng thái không loại hội viên chưa có gói; summary luôn trả cả hai loại.

Membership → service_sale bằng `service_sale_id`, sale → transaction bằng `transaction_id`; kiểm cả `service_sales.member_id` và `transactions.member_id`. Kind lấy `transactions.kind`; tên lấy `service_sales.plan_name_snapshot`, ngày từ start_date/end_date của sale, quota từ sessions_snapshot; không đọc tên/giá plan hiện tại thay snapshot. Membership không có created_at theo schema baseline, nên history sắp `transactions.created_at DESC, membership._id DESC`; các list khác dùng created_at DESC, _id DESC.

History giữ storedStatus ACTIVE/SUPERSEDED/CANCELLED. `timeState=NONE` nếu storedStatus không ACTIVE hoặc transaction chưa SETTLED; `transactionStatus` giúp UI phân biệt chưa đối chiếu và lịch sử thay thế/hủy. Sale PENDING chưa có membership không tạo item membership giả; vẫn hiện trong lịch sử transaction với nhãn chưa cấp gói. Không suy payment từ transaction status. `paymentId` chỉ từ payment SUCCEEDED đã tồn tại khi transaction SETTLED; `invoiceId` chỉ từ invoice tồn tại nối đúng transaction. Khoản thu thất bại/chờ hoặc dữ liệu tài chính nhạy cảm không được serialize. amountDue dùng converter EN-02 Decimal128 → chuỗi số nguyên VND, kể cả Decimal128 lưu dạng số mũ.

Danh sách dùng một aggregation `$lookup` + `$group` summary rồi `$facet` items/count; có lọc trạng thái thì lọc trước phân trang, không lọc các dòng của riêng trang. Khi không lọc trạng thái chỉ lookup sau skip/limit. Lịch sử phân trang tại DB, payment/invoice chỉ lookup cho trang hiện tại. Không N+1 theo từng member, không tải toàn lịch sử về UI. Projection tường minh, không trả hash/token/audit hoặc dữ liệu model thô.

Index members code/phone/created_at+_id giữ nguyên US-09. `npm run ensure-indexes` bổ sung `service_sales(member_id,transaction_id)` và `transactions(member_id,created_at DESC,_id DESC)`; unique membership.service_sale_id/payment/invoice tiếp tục do EN-02 sở hữu. Không đổi schema tài chính/env/dependency hoặc backfill nghiệp vụ.

### UI và bằng chứng kiểm tra

`/staff/members`, `/admin/members`: tìm kiếm debounce 300ms, lọc trạng thái/phạm vi loại, phân trang; đổi bộ lọc về trang 1, vô hiệu hóa response cũ ngay khi nhập (kể cả trong debounce), loading/empty/error/retry riêng. Liên kết danh sách → detail và tạo hồ sơ. Detail giữ editor US-10, thêm summary và thời điểm đọc, hai tab lịch sử phân trang. Tab/ID đổi hủy bỏ kết quả cũ. Làm mới hồ sơ/quyền lợi và lịch sử là các thao tác GET độc lập, mỗi phần hiển thị thời điểm riêng.

`backend/test/members-query.integration-spec.ts` kiểm TC01–TC13 và allowlist/hạ tầng TC14 bằng MongoDB replica set tạm, aggregation/index/JWT thật; fixture mô tả dữ liệu của US-14/21/22, không giả lập query DB. Kiểm read-only bằng so sánh dữ liệu nghiệp vụ trước/sau GET; kiểm settlement giữa hai lần tải bằng ghi DB có kiểm soát. `frontend/src/features/members/members-query.test.tsx` kiểm TC14 bằng API giả lập, bao gồm debounce, phản hồi về trễ, retry, phân trang server và tích hợp detail; test US-10 cập nhật expectation theo hợp đồng summary mới.

**Giới hạn DoD:** US-14/21/22 chưa triển khai trong repository; chưa xác minh demo với dữ liệu phát sinh qua các luồng đó. Chưa có trang chi tiết transaction/invoice, nên UI chỉ hiện mã dữ liệu đã có, không tạo link đến route chưa tồn tại hoặc tự viết luồng thanh toán trong US-11. Cần nối link khi US-21/22 cung cấp route và kiểm trình duyệt với backend/dữ liệu nghiệp vụ thật trước khi đánh dấu toàn bộ US-11 Done. Không sửa DOCX gốc ngoài workspace hoặc coi fixture là bằng chứng nghiệp vụ bán/thu tiền đã tích hợp.
