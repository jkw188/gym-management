# US-32 / UC-34 — đối chiếu ca, chấm công và buổi PT

Nguồn: `docs/PM/SPRINT7/[GM]Requirement_US-32.docx` v1.0, US-63 v1.0 và
US-64 v1.0; Q09/Q10. Giữ baseline DOCX và mã AC/TC. Đây là hợp đồng triển khai,
không phải tuyên bố toàn bộ Definition of Done đã đạt.

Admin có `trainers.activity.read` mở `/admin/trainers/activity`, chọn PT/kỳ,
xem tổng toàn tập lọc và hai vùng **Ca và chấm công**, **Buổi PT**. Staff/PT/Member
403; JWT/session/account/auth_version dùng US-02 hiện hành. Catalog quyền cố định
gán cả activity.read và ptBookings.correct cho ADMIN; quyền ghi không phát sinh từ
endpoint báo cáo. Chạy `npm run seed:access` để đồng bộ catalog.

## API và khoảng dữ liệu

| GET `/api` | Query / kết quả |
| --- | --- |
| `/admin/trainers/activity` | trainerId?, fromDate?, toDate?, page=1, limit=20≤100; `{items,page,limit,total,totalPages,asOf,range,summary}`; phân trang PT |
| `/admin/trainers/:id/activity` | fromDate?, toDate?, shiftPage=1, bookingPage=1, limit=20≤100; `{trainer,range,asOf,summary,shiftsPage,bookingsPage}`; total riêng từng nguồn |
| `/work-shifts/:id/attendance` | US-63 attendance.read cho STAFF/ADMIN: `{asOf,state,shift,note,events?}`; chỉ Admin có audit events. Staff không được đọc dashboard/tổng US-32. |
| `/admin/pt-bookings/:id` | Adapter Admin US-64: thời gian buổi, completedAt/By, completionRevision, quotaSource và events COMPLETE/REOPEN; cùng snapshot |

Ngày VN `YYYY-MM-DD` thật; `[00:00 fromDate +07:00, 00:00 ngày sau toDate +07:00)`.
Thiếu toDate lấy hôm nay VN; thiếu fromDate lấy 29 ngày trước toDate. Tối đa 366
ngày tính cả hai đầu. Ca và booking đều lọc **start_at**; không lọc ngày ghi công,
ngày tạo hoặc completed_at. Hiển thị trọn thời điểm ca/buổi giao biên kỳ.
Sort created_at DESC, _id DESC; PT mồ côi thiếu created_at xếp sau. ID/filter sai
400; không có PT và không có lịch sử khớp kỳ 404 ở detail; list rỗng totalPages=0.
Trang vượt dữ liệu có items=[] nhưng giữ total thực. 401/403/503 và envelope EN01-D03.

`summary` gồm shiftCount, attendanceClosed/Open/Missing, actualMinutesTotal,
bookingCount, completedCount, cancelledCount, pendingCompletionCount. BOOKED là
chờ xác nhận kể cả chưa tới hoặc đã quá giờ; chỉ status hiện tại COMPLETED được
đếm hoàn tất. completed_at là giờ xác nhận, hiển thị riêng. Không suy số buổi từ ca
hoặc giờ công; không tự chuyển trạng thái, quota, tính lương hay phạt.

Attendance left join theo shift_id, không unwind. MISSING không có record; OPEN
chưa có out; CLOSED có out. Chỉ một record có nguồn hợp lệ, Date in/out hợp lệ,
out>in mới tính phút `(out-in)/60000`; trường hợp khác phút null. Tổng chỉ cộng
CLOSED hợp lệ, tổng rỗng = 0 phút đóng hợp lệ, không biến bản ghi thiếu thành 0.
`dataIssue` nêu thiếu PT/account/member/ca, attendance sai nguồn/giờ/trùng và
completion thiếu actor/time. Attendance mồ côi không có ca để biết start_at được
cảnh báo `ATTENDANCE_SHIFT_MISSING_UNDATED` theo trainer_id, ngoài tổng kỳ; không
đoán ngày, không tính phút. Hồ sơ PT INACTIVE và account bị khóa vẫn giữ lịch sử.

## Snapshot, projection và index

TransactionRunner hiện có: primary + snapshot, majority, deadline 10 giây; chỉ đọc,
không lấy guard/ghi revision, không Promise.all trong session. Mỗi response có
một asOf tạo trong callback và cùng snapshot cho tổng, trang, reference/audit.
Các GET khác nhau có thể có asOf khác. DB lỗi trả 503, UI không giả số 0.

MongoDB aggregate ca và booking **độc lập**, group theo trainer_id ngay tại DB;
chỉ đưa danh mục PT và các nhóm tổng vào bộ nhớ để hợp nhất/phân trang PT, không
tải toàn bộ ca/booking. Mỗi detail lấy trang nguồn bằng facet count/items trong
snapshot. Với số lượng PT rất lớn có thể cần tối ưu phân trang nhóm tại DB.

Giữ index work_shifts(trainer_id,start_at,_id); bổ sung
pt_bookings(trainer_id,start_at,status). `npm run ensure-indexes` tạo index
trainer_attendance shift_id unique, (trainer_id,check_in_at), attendance_events
(attendance_id,occurred_at), (shift_id,occurred_at,_id). Không backfill giờ/actor
hoặc tạo audit giả. Dữ liệu attendance trùng shift phải được đối chiếu trước khi
cài unique index; không tự xóa. Không thêm env/dependency.

Projection chỉ trả field cho báo cáo và audit cần thiết; không trả request_key,
operation_id, token hoặc payload audit tùy ý. Frontend tự xây đường dẫn nguồn
theo loại nguồn và ObjectId, không nhận URL từ database; React render text audit.
Không PATCH summary hoặc sửa inline. Focus/online/nút tải lại đọc lại dữ liệu;
đổi account/đăng xuất xóa state, request cũ bị hủy/bỏ kết quả.

## Phụ thuộc và giới hạn

US-63 đã hợp nhất GET nguồn vào attendance.read, thêm writer check-in/out/correction,
schema/audit/migration và blocker SHIFT_HAS_ATTENDANCE cho ca US-24/25.
Xem [hợp đồng US-63/UC-34](attendance-contract.md) và [sequence](attendance-sequence.mmd).
Staff chỉ đọc ca/công và ghi vào/ra; Admin mới nhận audit và sửa sai tại
`/admin/trainer-attendance`. US-32 giữ quyền ADMIN trainers.activity.read,
chỉ đọc nguồn và refresh sau commit; không sửa attendance qua endpoint báo cáo.

US-52 đã có [hợp đồng hiệu suất S08-P01](trainer-performance-contract.md) và
[sequence UC-38](trainer-performance-sequence.mmd). US-32 giữ lọc start_at,
US-52 chọn interval giao kỳ và cắt độ dài; không lấy tổng S07 thay công thức
S08 hoặc gọi completedCount là attendanceCount. Drill-down US-52 truyền sourceID
tới attendance/booking endpoint hiện hành, nên ca bắt đầu trước kỳ vẫn truy được.

## Truy vết kiểm thử

| AC / TC | Kiểm thử |
| --- | --- |
| AC01 / TC01–04 | trainer-activity.integration-spec.ts: JWT/role/session/status/auth_version, ID/filter, ngày VN và xác nhận muộn |
| AC02 / TC05–08 | Integration MISSING/OPEN/CLOSED 90 phút, BOOKED quá giờ, ca COMPLETED, phân trang tổng độc lập và cập nhật đồng thời trong snapshot |
| AC03 / TC09 | trainer-activity.integration-spec.ts kiểm COMPLETE/REOPEN US-64 và fixture nguồn; attendance.integration-spec.ts bổ sung checkout/correction US-63 thật rồi GET US-32, giữ booking/quota. |
| AC03 / TC10–12 | Integration orphan/giờ sai/index unique/no mutation/lỗi DB; trainer-activity.test.tsx: hai vùng/filter/pagination/source allowlist/loading/error/retry/account/route |

Chạy build/typecheck/test theo package.json. Hồi quy US-24/25, US-64, RBAC và EN-04
theo kết quả thực tế từng lần chạy; browser/mobile cần xác minh riêng.
Không tự commit hoặc đánh dấu toàn bộ AC/DoD đã hoàn tất.
