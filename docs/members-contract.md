# US-09 / US-10 — UC-18 / UC-19 / Q12: hồ sơ hội viên tại quầy

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

MemberDto: `id,memberCode,fullName,phone,birthDate?,address?,accountId?,version,createdAt,updatedAt`. Ngày giờ là ISO UTC. US-10 bổ sung GET chi tiết tối thiểu dùng chung mapper; phần tổng hợp quyền lợi thuộc US-11 như giới hạn bên dưới.

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
| `GET /api/members/:id` | STAFF/ADMIN → `{member:MemberDto,entitlementSummary:null,asOf:ISO UTC}` |
| `PATCH /api/members/:id` | STAFF/ADMIN; `{version,fullName?,phone?,birthDate?,address?}` → `{member:MemberDto,changed:boolean}` |

**Phụ thuộc US-11 chưa hoàn chỉnh:** repository chưa có đặc tả US-11 hoặc dịch vụ tổng hợp quyền lợi. `entitlementSummary:null` biểu thị chưa khả dụng, không kết luận hội viên không có gói/quyền lợi. GET ở đây chỉ phục vụ đọc hồ sơ/version cho US-10; không triển khai tìm kiếm/danh sách hay tự tính hiệu lực gói.

`version` bắt buộc số nguyên không âm; ít nhất một trong bốn field hồ sơ. Tên 2–120 ký tự Unicode sau trim/gộp khoảng trắng; phone raw là string tối đa 32 ký tự, dùng EN01-D01. Ngày sinh YYYY-MM-DD có thật, không tương lai theo Việt Nam. Địa chỉ tối đa 255 ký tự sau trim. Omit giữ nguyên; `birthDate:null`, `address:null` hoặc địa chỉ trắng dùng `$unset`. Tên/phone null, rỗng hoặc field ngoài allowlist trả 400 `VALIDATION_ERROR`, lỗi field nằm trong `details`.

Kiểm version trước khi so sánh no-op; cả nhánh sửa và no-op đều match `_id + version` atomically. No-op không tăng version, không đổi actor/timestamp. Sửa thật chỉ `$set/$unset` field thay đổi, `$inc version:1`, `updated_by` từ JWT và `updated_at` từ server. Unique index phone quyết định cuối: trùng trả 409 `MEMBER_PHONE_EXISTS`; version cũ trả 409 `VERSION_CONFLICT`, kể cả payload giống dữ liệu mới. Không tìm thấy trả 404 `MEMBER_NOT_FOUND`, id sai trả 400; 503 `SERVICE_UNAVAILABLE` có requestId và không lộ lỗi kết nối, kể cả lỗi DB ở JWT guard.

Không save lại document snapshot, không ghi `account_id`, `service_revision`, field gói, sale/invoice hoặc account. PATCH một document không thêm transaction/audit nhiều collection. Nếu caller truyền session transaction, phải gọi lại toàn bộ `MembersService.update` trong mỗi retry của TransactionRunner; giữ nguyên version gốc và kiểm lại trên snapshot mới. Lỗi có nhãn transaction được giữ cho driver retry; lỗi nghiệp vụ không tự retry.

UI ở `/staff/members/:id`, `/admin/members/:id`; liên kết từ hồ sơ vừa tạo. Chọn Chỉnh sửa sẽ GET lại dữ liệu/version; mã và account chỉ đọc. Hủy không PATCH. Pending chặn gửi kép; lỗi field/trùng phone giữ bản nhập và focus đúng ô. Conflict hoặc mất response/503 khóa Lưu; muốn GET lại phải xác nhận bỏ bản chưa lưu. Người dùng đối chiếu bản server rồi chủ động sửa/lưu lại. PATCH dùng `requestOnce`, không Idempotency-Key, không tự refresh rồi gửi lại payload. Không lưu draft vào localStorage, không render HTML từ tên/địa chỉ hoặc log hồ sơ.

`backend/test/members-update.integration-spec.ts`: MongoDB 8.0.17 replica set, hai Nest connection, JWT/index thật; TC01–TC11 kiểm cập nhật/allowlist/quyền/validation/unique/no-op, TC12 kiểm link cạnh tranh, transaction dùng member guard và retry kiểm lại version; TC13 kiểm lỗi hạ tầng và dừng MongoDB thật. Sale test là đơn vị công việc kiểm hợp đồng EN-02, **chưa phải tích hợp luồng bán gói US-14**. `frontend/src/features/members/member-update.test.tsx` kiểm TC13–TC14 bằng API giả lập; cần kiểm thêm trình duyệt với backend thật trước khi nghiệm thu toàn bộ DoD. Chưa đánh dấu Done toàn bộ US-10 khi phần phụ thuộc US-11/US-14 chưa được xác minh.
