# US-09 — UC-18 / Q12: hồ sơ hội viên tại quầy

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

MemberDto: `id,memberCode,fullName,phone,birthDate?,address?,accountId?,version,createdAt,updatedAt`. Ngày giờ là ISO UTC. US-11 sẽ dùng cùng mapper khi bổ sung `GET /api/members/:id`; API này chưa nằm trong US-09.

Các lỗi nghiệp vụ: `MEMBER_PHONE_EXISTS`, `VERSION_CONFLICT`, `ACCOUNT_ALREADY_LINKED`, `MEMBER_ALREADY_LINKED`, `ACCOUNT_NOT_ELIGIBLE`, `IDENTITY_MISMATCH`, `IDEMPOTENCY_CONFLICT`. ID/dữ liệu sai trả 400; thiếu xác thực 401, sai quyền 403, không tìm thấy 404, hạ tầng 503. Lỗi dùng envelope EN01-D03; không xuất MongoDB error thô.

## Transaction và retry

Tạo dùng MEMBER_CREATE; link dùng MEMBER_LINK với hash payload và member targetId. Kết quả cùng transaction với dữ liệu nghiệp vụ. Link ghi khóa `security_state/account-administration` trước `members.service_revision`, kiểm lại actor/session, account và version, CAS member rồi insert audit. US-07/08 dùng cùng khóa quản trị nên không thể đổi role và link theo hai snapshot độc lập.

US-14/settlement phải dùng `DataGuardsService.acquire` với member tương ứng trước khi đọc recipient; link tăng cùng revision để cố định thứ tự commit. Luồng bán gói/settlement chưa được triển khai ở repository này; test TC14 hiện xác minh hợp đồng guard bằng transaction thật, chưa chứng minh tích hợp settlement hoặc gửi thông báo thực tế.

UI không chọn sẵn account. Nhân viên phải chọn phương pháp, nhập ghi nhận và xác nhận đối chiếu trực tiếp; không thu số CCCD hoặc ảnh giấy tờ. Mất phản hồi giữ ý định và key trong bộ nhớ, khóa sửa dữ liệu, lookup rồi mới gửi lại cùng payload/key nếu OPERATION_UNKNOWN. Reload/đóng tab làm mất bộ nhớ ý định; cần tra hồ sơ US-11 trước khi tạo lại. Trùng phone không tự lặp create bằng key mới.

## Khởi tạo và nghiệm thu

MongoDB phải hỗ trợ transaction (replica set). Chạy `npm run ensure-indexes` trong backend trước khi bật production: tạo index `members`, `member_link_events`, giữ nguyên index đã có, migration EN-02 bổ sung revision thiếu. Không tự xóa hay sửa dữ liệu trùng/cũ; cần rà soát và backup nếu tạo unique index thất bại. Development/test tạo và xác minh index lúc startup; production chỉ xác minh.

`backend/test/members.integration-spec.ts` bao phủ TC01–TC13 trên replica set tạm, hai Nest app/connection, login/JWT thật; TC12 cố ý gây lỗi insert audit để kiểm rollback thật. TC14 kiểm hợp đồng member guard như giới hạn đã nêu. `frontend/src/features/members/members.test.tsx` kiểm TC15 bằng HTTP API giả lập, cần kiểm thêm browser với backend thật. Không coi build hoặc test giao diện giả lập là toàn bộ AC đã nghiệm thu.
