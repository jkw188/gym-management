# US-63 / UC-34 — ghi nhận chấm công PT

Nguồn: `PM/SPRINT7/[GM]Requirement_US-63.docx` v1.0, Q10;
US-24-F04/F05, US-25-F02/F04, US-32-F03/F05, EN-02-F03/F04/D01.
Đây là hợp đồng triển khai bổ sung; giữ nguyên baseline DOCX và mã AC/TC.

## Use case UC-34

Staff/Admin đăng nhập bằng phiên US-02 hiện hành, mở `/staff/trainer-attendance`
hoặc `/admin/trainer-attendance`, chọn ngày/PT/ca và xác minh đúng người, ngày,
ca, tình trạng có mặt thực tế. Ca và giờ thực tế hiển thị riêng. Staff không nhập
timestamp; check-in/out lấy ServerClock ở mỗi lần chạy callback transaction.
Ca CONFIRMED/COMPLETED cần có hồ sơ trainer; SCHEDULED/CANCELLED trả
409 SHIFT_NOT_ELIGIBLE. Đến sớm được phép; check-in phải trước end_at.
Checkout bắt buộc có in, chưa có out, version hiện tại, now>in; ra trễ được ghi
bằng giờ thực, không ép về giờ kết thúc ca. MISSING/OPEN có actualMinutes=null.

Admin có thể sửa sai hoặc bổ sung công bỏ sót cho ca đã diễn ra. Dialog hiển thị
giá trị cũ, mới, lý do trim 10–500 và thời điểm UTC+7. In≤now; out nếu có phải
in<out≤now. Bỏ checkOutAt nghĩa là OPEN. Có record phải gửi version; chưa có
record phải bỏ version. Bản ghi gốc giữ recorded_by/created_at; mọi thay đổi có
sự kiện before/after, actor và occurred_at của server. Không suy công từ booking,
không hoàn tất ca/buổi, thay quota, xóa record hoặc audit. PT ngừng hoạt động
vẫn giữ lịch sử; Admin được hiệu chỉnh lịch sử mà không cần account PT ACTIVE.

## API và phân quyền

| Endpoint `/api` | Quyền / input / kết quả |
| --- | --- |
| GET `/work-shifts` | attendance.read STAFF/ADMIN; fromDate?,toDate?,trainerId?,status?,page=1,limit=20≤100. Tuần hiện tại mặc định, tối đa 31 ngày VN; sort start_at ASC,_id ASC; `{items,trainers,page,limit,total,totalPages,asOf}`. Picker trainers chỉ có id/displayName; không trả booking hoặc summary quản trị. |
| GET `/work-shifts/:id/attendance` | attendance.read STAFF/ADMIN; `{asOf,state,shift,note,events?}`. shift có trainerId, giờ ca, attendance hiện tại, version, người ghi/sửa và dataIssue. Chỉ Admin nhận events; Staff không đọc audit. |
| POST `/work-shifts/:id/attendance/check-in` | attendance.record STAFF/ADMIN; key ATTENDANCE_CHECK_IN; `{note?}`; 201 OPEN version=0. |
| POST `/work-shifts/:id/attendance/check-out` | attendance.record STAFF/ADMIN; key ATTENDANCE_CHECK_OUT; `{version,note?}`; 200 CLOSED version+1. |
| POST `/work-shifts/:id/attendance/corrections` | attendance.correct ADMIN; key ATTENDANCE_CORRECT; `{version?,checkInAt,checkOutAt?,reason,note?}`; 200 khi sửa, 201 khi bổ sung. |
| GET `/operations/:operation/:key` | Actor sở hữu và role hiện hành được phép ghi; 200 COMMITTED hoặc 404 OPERATION_UNKNOWN. |

Response lệnh ghi: id,shiftId,trainerId,state,checkInAt,checkOutAt,recordedBy,
checkedOutBy,version,note,createdAt,updatedAt,lastCorrectedBy,lastCorrectedAt.
Timestamp ISO UTC; null khi chưa có. note trim≤255; UI nhắc không nhập thông tin
sức khỏe không cần thiết. Timestamp correction có timezone, hỗ trợ cả giây/mili
giây để sửa chính xác giờ thực. Không áp dụng giới hạn đến phút của lịch ca S04.

DTO forbidNonWhitelisted chặn timestamp/trainerId/actorId từ client ở lệnh vào/ra.
Sai ID/filter/DTO 400; phiên thiếu/thu hồi/khóa/auth_version cũ 401; sai role 403;
không nguồn 404; sai trạng thái/version/ràng buộc 409; DB lỗi 503 theo EN01-D03.
Các mã chính: SHIFT_NOT_ELIGIBLE, ATTENDANCE_MISSING,
ATTENDANCE_ALREADY_EXISTS, ATTENDANCE_ALREADY_CLOSED, ATTENDANCE_TIME_INVALID,
VERSION_CONFLICT, ATTENDANCE_DATA_INVALID, IDEMPOTENCY_CONFLICT.

## Bổ sung hợp đồng chung S04-G01 và EN-02-D01

Mỗi writer US-63 dùng IdempotencyService/TransactionRunner hiện có: primary,
snapshot, majority, deadline 10 giây; schedule_guards tăng revision trước recheck
ca/hồ sơ/attendance, sau đó unique shift hoặc CAS version, insert event và
operation_requests trong cùng session. Không Promise.all hoặc I/O ngoài trong
callback. Chỉ trả thành công sau commit. Audit/key lỗi thì rollback toàn bộ.

US-24-F04 và US-25-F02/F04 bổ sung blocker SHIFT_HAS_ATTENDANCE trong cùng khóa
lịch: có attendance thì không sửa giờ/trainer/hủy ca, kể cả attendance được sửa
thành OPEN. Check-in cạnh tranh hủy ca có hai thứ tự hợp lệ: hủy thắng thì in
bị chặn; in thắng thì hủy bị chặn. Các quy tắc khác của S04 giữ nguyên.

Catalog EN-02-D01 thêm ATTENDANCE_CHECK_IN, ATTENDANCE_CHECK_OUT,
ATTENDANCE_CORRECT. UUID v4 scope actor/operation/key; hash DTO đã trim,
timestamp chuẩn hóa UTC, targetId và version. Auth hiện hành trước replay;
cùng key/payload trả HTTP/body gốc trước kiểm version hiện tại. Mất response,
503 OPERATION_OUTCOME_UNKNOWN hoặc lookup 404 giữ nguyên key/body; UI khóa ý
định đang chờ, cho tra cứu/gửi lại cùng khóa. Đổi account xóa state và bỏ kết quả
request cũ. Không mở trainers.activity.read cho Staff.

## Schema/index và migration

- trainer_attendance: _id/id, shift_id unique, trainer_id từ ca bất biến,
  check_in_at,check_out_at?,recorded_by bất biến,checked_out_by?,note?,version,
  created_at bất biến,updated_at,last_corrected_by/at?. Index trainer_id/check_in_at.
- attendance_events append-only: shift_id,attendance_id,action CHECK_IN/CHECK_OUT/CORRECT,
  actor_id,occurred_at,before/after (giờ,version,note,người ghi),reason?,operation_id.
  operation_id là digest actor/operation/key, unique cho event mới; partial index
  `$type:string` giữ audit legacy thiếu operation_id mà không bịa khóa lịch sử.
  Index attendance_id/occurred_at và shift_id/occurred_at/_id.
- work_shifts/pt_bookings/memberships không bị sửa bởi attendance writer.

Chạy `npm run ensure-indexes` trong backend ở cửa sổ bảo trì trước khi mở writer,
sau đó `npm run seed:access`. Migration nằm sau ensureSchedulingIntegrity để có
schedule_guard; kiểm toàn bộ nguồn trong transaction trước backfill. Trùng shift,
mồ côi, trainer_id khác ca, actor không tồn tại, thiếu created_at, giờ/version/id/note
không hợp lệ: dừng bằng ATTENDANCE_MIGRATION_REQUIRES_RECONCILIATION kèm ID,
không tự sửa/xóa giờ cũ. Người vận hành đối chiếu bằng chứng rồi chạy lại.

Nguồn hợp lệ: bổ sung id=_id, trainer_id từ ca, version=0 khi thiếu (baseline CAS
cho dữ liệu legacy), updated_at=created_at khi thiếu. Không tạo audit giả hay suy
giờ từ booking; thiếu timestamp/actor gốc phải đối chiếu thủ công. Chạy lại không
đổi dữ liệu đã có. Không thêm env hoặc dependencies. Migration chưa chạy trên DB
cá nhân; integration test chạy bằng MongoDB 8.0.17 replica set tạm riêng.

## Truy vết kiểm thử

| AC / TC | Kiểm thử |
| --- | --- |
| AC01 / TC01–04 | attendance.integration-spec.ts: JWT thật, role/session/status/auth_version trước replay, ca hợp lệ/hết giờ, whitelist DTO, giờ server. |
| AC02 / TC05–08 | Hai instance Nest/connection cùng replica set; key giống/khác, unique shift, checkout, correction/missed, CAS và dữ liệu bất hợp lệ. |
| AC03 / TC09–11 | Race check-in với API cancel thật, blocker sửa ca, fault audit rollback, replay/lookup, US-32 đọc sau checkout/correction, booking/quota giữ nguyên. |
| AC03 / TC12 | attendance.test.tsx: MISSING/OPEN, không nhập timestamp Staff, dialog Admin, lỗi DB/retry, unknown outcome cùng key, đổi account. |
| Migration | Legacy backfill chạy lại, nguồn sai dừng không ghi, không bịa event. |

Lệnh kiểm tra tại backend: `npm run typecheck`, `npm run typecheck:test`,
`npm run build`, `npm run test:unit`,
`npm run test:integration -- --runTestsByPath test/attendance.integration-spec.ts test/trainer-activity.integration-spec.ts test/work-shifts-api.integration-spec.ts test/work-shifts-transition-api.integration-spec.ts`;
hồi quy EN-04: `$env:NODE_ENV='test'; npm run test:e2e`.
Frontend: `npm run typecheck`, `npm run build`,
`npm test -- src/features/trainer-attendance/attendance.test.tsx src/features/trainer-activity/trainer-activity.test.tsx src/features/shifts/shifts.test.tsx src/features/shifts/shift-transitions.test.tsx`.
Kết quả thực tế báo trong phiên làm việc; không tự commit/push hoặc tuyên bố
đã nghiệm thu bằng trình duyệt chỉ từ test jsdom/build.
