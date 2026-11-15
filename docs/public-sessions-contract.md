# US-66: quản lý lớp miễn phí và UC-02

Nguồn: `docs/PM/SPRINT4/[GM]Requirement_US-66.docx` v1.0; đối chiếu US-26,
US-28/S04-G01 và EN-05 S04. Giữ nguyên baseline DOCX và mã AC/TC.

## Use case và vòng đời

UC-02 mở rộng: Admin có `publicSessions.manage` vào `/admin/classes`, lọc lịch,
tạo nháp, sửa, công bố hoặc hủy có lý do. Chỉ ADMIN có quyền này. PT ACTIVE,
account ACTIVE/TRAINER được kiểm lại trong transaction khi tạo/sửa/công bố.
Guest/Member xem lớp đã công bố qua nguồn US-26.

POST tạo DRAFT/version0. Publish DRAFT→PUBLISHED; sửa giữ status và tăng version;
hủy DRAFT/PUBLISHED→CANCELLED terminal. Chỉ sửa/hủy trước startAt, đúng version.
Không DELETE/unpublish/tái công bố; lịch sử sau start bất biến, ended suy từ endAt,
không có status COMPLETED. Hủy cho phép cả khi PT/account đã không khả dụng để
Admin xử lý trở ngại lịch; reason trim 10–500 ký tự.

Title/location trim 1–120. Taxonomy chung: YOGA/Yoga, AEROBICS/Aerobics,
ZUMBA/Zumba, FUNCTIONAL/Tập chức năng, OTHER/Khác. Không sao chép liên hệ PT,
không enrollment/quota/payment/attendance.

## API

Prefix `/api`; route admin yêu cầu JWT và `publicSessions.manage`.

| Route | Input / kết quả |
| --- | --- |
| GET `/admin/public-sessions` | fromDate, toDate, trainerId?, subjectCode?, status?, page=1, limit=20≤100; items/total/totalPages |
| GET `/admin/public-sessions/:id` | Detail có version, createdAt/By, updatedAt/By, publishedAt?, cancelledAt/By?, cancellationReason? |
| POST `/admin/public-sessions` | title, trainerId, subjectCode, location, startAt, endAt → 201 DRAFT/version0 |
| PATCH `/admin/public-sessions/:id` | Đầy đủ field tạo + version → 200, version+1 |
| POST `/admin/public-sessions/:id/publish` | version → 200 PUBLISHED, publishedAt, version+1 |
| POST `/admin/public-sessions/:id/cancel` | version, reason → 200 CANCELLED, version+1 |
| POST `/admin/public-sessions/preview` | Field tạo + sessionId? loại chính lớp → 200 startAt/endAt/conflictCodes; chỉ đọc, không giữ giờ |
| GET `/public-session-subjects` | Public, taxonomy chung Admin/Guest |

Writer dùng Idempotency-Key UUID v4; operation PUBLIC_SESSION_CREATE/UPDATE/
PUBLISH/CANCEL. Scope actor+operation+key, hash payload trim/Date UTC/ObjectId
lowercase cùng resourceId/version/reason. Replay trả HTTP/body gốc, kể cả sau giờ
bắt đầu; JWT/RolesGuard kiểm quyền hiện hành trước service. Lookup
`/operations/:operation/:key` chỉ cho ADMIN chủ key. Mất response/503, UI khóa
form và giữ key/payload để tra cứu hoặc retry; không tạo ý định mới.

List mặc định tuần hiện tại, tối đa 31 ngày VN, sort startAt/id ASC, lấy lớp giao
khoảng ngày lọc. Date UTC, API ISO có Z/offset, giây/mili giây 0; end>start,
start>now, không quá nửa đêm VN, cho end=00:00 ngày kế tiếp. Lớp không cần 60 phút
hoặc nằm trong ca PT; địa điểm text không là tài nguyên độc quyền.

Lỗi EN01-D03: 400 validation/field lạ; 401/403; 404 SESSION_NOT_FOUND;
409 SESSION_OVERLAP, BOOKING_CONFLICT, TRAINER_UNAVAILABLE,
SESSION_ALREADY_STARTED, INVALID_SESSION_STATE, VERSION_CONFLICT,
IDEMPOTENCY_CONFLICT; 503 hạ tầng. Preview chỉ trả mã, không booking/member id.
Swagger mô tả body/response/lỗi/key theo cấu hình hiện có.

## MongoDB, khóa và tích hợp

public_sessions dùng schema đã có: id=_id, trainer_id, title, subject_code bắt
buộc, location, start_at/end_at, DRAFT/PUBLISHED/CANCELLED, version,
created_at/by, updated_at/by, published_at?, cancelled_at/by?, cancellation_reason?.
Giữ index id unique; (status,start_at,_id), (status,subject_code,start_at),
(trainer_id,status,start_at,end_at).

Thêm public_session_events: session_id, actor_id, CREATED/UPDATED/PUBLISHED/
CANCELLED, before?/after allowlist (title, trainer_id, subject_code, location,
start_at, end_at, status, version), reason?, occurred_at, request_key unique.
Index tra cứu (session_id,occurred_at). Audit và operation_requests cùng transaction.

Writer US-66: snapshot/majority EN-02 → tăng thật security_state khi tạo/sửa/công bố
(phối hợp khóa/đổi role account) → schedule_guards global Int64 S04-G01 → recheck
data/PT/account → CAS version → lớp/audit/operation_requests → commit.
Không Promise.all trong session hoặc nested transaction. Publish/sửa PUBLISHED
kiểm lớp PUBLISHED khác và booking BOOKED/COMPLETED cùng PT bằng [start,end);
tiếp giáp được phép, không đổi ca/booking. Booking/PT writers dùng cùng guard.
Khóa account trước publish làm recheck từ chối; khóa sau publish giữ lịch sử.

US-26 giữ projection public, DRAFT/CANCELLED detail404, không lộ audit.
US-27/28 đã đọc PUBLISHED từ cùng collection để loại giờ bận. Không có backend
cache riêng. Sau commit UI invalidation cho tab hiện tại/tab cùng origin; public
list/detail và availability tải lại. Focus/visibility revalidate nhận thay đổi từ
phiên/thiết bị khác. Không broadcast realtime hoặc thông báo người đăng ký.
Sửa PUBLISHED yêu cầu xác nhận rõ trên UI trước gửi.

## Migration và vận hành

Dừng writer khi chạy `npm run ensure-indexes` ở backend. Migration kiểm toàn bộ
lớp theo schema/thời gian/version, overlap PUBLISHED/lớp/booking trước khi ghi.
Sai báo PUBLIC_SESSION_DATA_INVALID kèm id để đối chiếu. Chỉ điền field thiếu:
subject_code=OTHER, version=0, id=_id; không đổi actor/timestamp/status hoặc
tạo audit lịch sử giả. Thiếu actor/timestamp cũ phải đối chiếu nguồn; không tự đoán.
Chạy lại không đổi dữ liệu đã đủ. Admin kiểm lại OTHER trước công bố.
`npm run seed:access` cập nhật catalog quyền; không thêm env/dependency.

## Truy vết

| AC / TC gốc | Kiểm thử |
| --- | --- |
| US-66-AC01 / TC01–04 | admin-public-sessions.integration-spec.ts: lifecycle, taxonomy, quyền/PT/account, input/minute/midnight, 45 phút trong/ngoài ca |
| US-66-AC02 / TC05–08 | Integration BOOKED/COMPLETED/adjacency/update atomic/availability; EN-05 TC07/08: batch20/hai process/10 vòng, cancel giải phóng giờ |
| US-66-AC03 / TC09–12 | Integration version/terminal/started/replay/privacy/audit rollback; EN-05 TC10 deactivate/publish/account lock |
| US-66-AC03 / TC13 | admin-classes.test.tsx + classes.test.tsx: pending/empty/error, confirm, key recovery, filter/VN time/invalidation; mobile browser cần kiểm thủ công |

Không suy Done toàn bộ EN-05 từ US-66: EN-05 TC13 vẫn PARTIAL vì US20 self-service
adapter chưa có. Metadata/hash/commit và DB evidence tại artifacts/en05-<runId>;
checkout dirty phải ghi rõ, không tự commit/đánh Done.
