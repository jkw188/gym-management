# US-52 / UC-38 — báo cáo hiệu suất huấn luyện viên

Nguồn: `docs/PM/SPRINT8/[GM]Requirement_US-52.docx` phiên bản 1.0;
Q09/Q10/Q13, US-24/25/32/33/63/64/65 và EN-08. Đây là phụ lục triển khai
của requirement sở hữu **S08-P01**, giữ nguyên baseline DOCX và mã AC/TC.
Không thêm chính sách lương, xếp hạng, thưởng/phạt hoặc command hoàn tất ca.

## UC-38 và hợp đồng S08-P01

ADMIN mở `/admin/reports/trainers`, chọn kỳ và mã PT hoặc để trống xem toàn bộ,
xem giờ ca/giờ công/buổi/đánh giá, rồi chọn PT để xem bốn trang nguồn. Giữ cả
PT INACTIVE và nguồn mồ côi có trainer_id; thiếu trainer_id hiện hàng cảnh báo.
Giá trị không biết hiển thị thiếu dữ liệu, không đổi thành 0.

`report-interval.ts` là hàm dùng chung clip/union/decimal của S08-P01:

- Mọi khoảng là `[start,end)`, cắt với `[W.start,effectiveTo)`, chỉ giao dương.
- W theo ngày VN, bao gồm fromDate/toDate; mặc định đầu tháng hiện tại tới hôm nay
  VN, tối đa 366 ngày, không nhận ngày tương lai hoặc ngày lịch không tồn tại.
- `effectiveTo=min(W.end,observedAt)`. Không làm tròn dòng trước tổng; hợp các
  khoảng chồng/tiếp giáp **trong mỗi PT và mỗi nguồn** rồi mới cộng các PT.
- Milliseconds nguyên cộng bằng bigint, trả chuỗi. Minutes/hours chuỗi thập phân
  tối đa 4 chữ số; UI giờ 2 chữ số. Counts không phải durations.
- planned từ ca CONFIRMED/COMPLETED; completedShift chỉ ca COMPLETED;
  completedBooking từ buổi status COMPLETED có giao dương, count distinct `_id`.
  Không đọc `memberships.sessions_used`, không suy hoàn tất từ BOOKED hoặc checkout.
- Tỷ lệ toàn phòng `100×sum(completedBooking)/sum(planned)`, không lấy trung bình
  tỷ lệ từng PT. Mẫu số 0: null/NOT_APPLICABLE. Ca/buổi chồng nhau, buổi ngoài ca,
  thiếu hoặc sai quan hệ ca/PT/member/completion: null/DATA_INCONSISTENT,
  không clamp100. Hợp khoảng chỉ ngăn cộng trùng, không sửa dữ liệu lỗi.
- knownActual hợp CLOSED in/out hợp lệ, cắt W nhưng không cắt giờ ca; gồm giờ
  thực giao kỳ dù ca kế hoạch ở ngoài kỳ. Thiếu attendance của ca trong báo cáo
  tăng missingCount; chưa out tăng openCount. actualTotal null khi còn thiếu,
  mở hoặc nguồn invalid; knownActual luôn là phần đã biết có nhãn chất lượng.
- Review theo created_at trong kỳ, độc lập interval buổi; tổng average là sum
  điểm/sum lượt. Count0 average null. Nguồn timestamp/rating lỗi phát cảnh báo;
  chỉ số không chắc chắn trả null, kèm knownReviewCount/knownRatingDistribution.

## API / OpenAPI

Cả hai API có `reports.trainers.read`, cố định chỉ ADMIN. US-02 kiểm JWT,
account ACTIVE, session và auth_version hiện hành mỗi request. STAFF/TRAINER/
MEMBER403; không có/expired/revoked token401. Catalog dùng `npm run seed:access`.

| GET `/api` | Query / kết quả |
| --- | --- |
| `/reports/trainers/performance` | trainerId?, fromDate?, toDate?, q?, page=1, limit=20≤100; `{items,page,limit,total,totalPages,totals,filter,range,observedAt,metricVersion,dataQuality,warningCodes,invalidRecordCount}` |
| `/reports/trainers/:id/performance` | fromDate?, toDate?, shiftPage?, attendancePage?, bookingPage?, reviewPage?, limit=20≤100; `{trainer,summary,sourcePages:{shifts,attendance,bookings,reviews},range,observedAt,metricVersion,dataQuality,warningCodes,invalidRecordCount}` |

Mỗi sourcePage có `{items,page,limit,total,totalPages}` độc lập. Trang rỗng có
totalPages0. PT sort tên vi ASC rồi ID ASC; nguồn sort giờ nguồn DESC, ID DESC.
`q` trim≤120, tìm literal bằng includes, chỉ lọc bảng; trainerId/kỳ lọc cả tổng.
Các query ngoài allowlist, ObjectId/page/date sai trả400, không bỏ filter sai.
Detail không có PT hoặc lịch sử404; lỗi theo EN01-D03, hạ tầng503 không giả báo cáo
rỗng. OpenAPI controller mô tả các trường duration/count nullable, quality và
bốn trang nguồn; tất cả GET `Cache-Control: no-store`.

Summary trả các bộ `planned*`, `completedShift*`, `completedBooking*`,
`knownActual*`, `actualTotal*` với hậu tố Milliseconds/Minutes/Hours;
shiftCount/completedShiftCount/completedBookingCount, missing/open/closedCount,
invalidSourceCount, overlappingShift/BookingCount, utilizationRate/Status,
reviewCount/averageRating/ratingDistribution và quality/warnings/invalidRecordCount.
Khi interval hỏng không xác định được tổng: duration/count tương ứng null;
knownPlanned*, knownCompletedBooking*, knownCompletedBookingCount giữ phần đã biết.
Không gắn null của attendance vào chỉ số kế hoạch vốn vẫn biết được.

## MongoDB, snapshot, projection và links

Mỗi request lấy observedAt lúc bắt đầu đọc, mở **read-only snapshot session**
MongoDB (>=5), các cursor đọc tuần tự trên primary và cùng session, timeoutMS5s
bao gồm getMore. Tổng/nhóm/trang chi tiết lấy từ cùng các nguồn đã đọc, không
join unwind nhân duration theo số review/attendance. Không hứa snapshot giữa
hai request; UI giữ range/observedAt đang hiển thị, ghi rõ snapshot detail riêng.
Đọc trạng thái đã committed, kể cả completion xác nhận muộn cho buổi kỳ cũ;
không time-travel theo completed_at. GET không sửa trạng thái hoặc audit nguồn.

Query ca/buổi theo `start_at<effectiveTo,end_at>W.start` và status; query review
theo created_at. Đọc thêm nguồn timestamp malformed để cảnh báo thay vì âm thầm
lọc mất; join tham chiếu ca/booking/member theo ID. Attendance theo shift_id của
ca trong kỳ hoặc interval công giao kỳ, kiểm cả ca hủy/mồ côi. OPEN/MISSING không
giả check_out=end hoặc actual0. Source projection chỉ có ID/giờ/status/actor/điểm;
không đọc contact, sức khỏe, evidence ngân hàng hoặc payload audit tùy ý.

Tái sử dụng index hiện có, không đổi schema hoặc migration:

| Collection | Index |
| --- | --- |
| work_shifts | `work_shifts_trainer_status_time (trainer_id,status,start_at,end_at)` |
| pt_bookings | `pt_bookings_trainer_status_time (trainer_id,status,start_at,end_at)` |
| trainer_attendance | `trainer_attendance_shift_unique (shift_id)` unique; `trainer_attendance_trainer_in (trainer_id,check_in_at)` |
| trainer_reviews | `trainer_reviews_trainer_time (trainer_id,created_at,_id)`; `trainer_reviews_time (created_at,_id)` |

Chi tiết giữ từng sourceID, thời gian raw/clipped, raw/clippedMilliseconds/Minutes/Hours,
completedAt/recordedAt/actorId, dataIssue. Bản ghi chồng nhau có mã lỗi ngay từng
nguồn. SourceLink chỉ allowlist `/api/work-shifts/:id/attendance`,
`/api/admin/pt-bookings/:id` hoặc `/api/admin/trainer-reviews/:id`; frontend kiểm lại loại/ID trước khi GET và hiển thị
audit hiện có. Endpoint nguồn kiểm permission độc lập, không cấp sửa từ report.
Review truy vết reviewId/bookingId tại bảng và GET nhận xét gốc theo ID, không tự chuyển sang kỳ buổi để lọc review.

US-32 vẫn lọc start_at và giữ định nghĩa S07; US-52 tự chọn intersect, không dùng
tổng US-32. Drill-down nguồn dùng ID, không áp lại bộ lọc start_at làm mất ca
qua biên kỳ. Source dữ liệu lỗi cần đối soát qua quy trình US-63/64 trước nghiệm
thu EN-08; cảnh báo không thay việc giải quyết sai lệch có căn cứ.

## Truy vết kiểm thử và giới hạn

| AC / TC | Kiểm thử |
| --- | --- |
| AC01 / TC01–05 | `trainer-performance.integration-spec.ts`: fixture240/120, BOOKED và carried usage, completion muộn, review ngoài kỳ buổi; đối chiếu committed MongoDB với oracle EN08 độc lập |
| AC02 / TC06–10 | `report-interval.spec.ts` và integration: half-open, giao kỳ, union, overlap có lỗi, weighted25%, overtime, missing/open/closed, cap observedAt |
| AC03 / TC11–15 | Integration: JWT/role/ACTIVE/auth_version/revoked, allowlist400/404, bốn trang, projection, nguồn có quyền riêng, snapshot khi concurrent commit, GET không ghi,503 sạch |
| UI / TC12–15 | `trainer-performance.test.tsx`: null/partial, tooltip, range/observedAt, nguồn qua biên kỳ, trang độc lập,503/loading/empty/refresh, stale/logout và bốn role |

Fixture nghiệp vụ lỗi được ghi trực tiếp **chỉ trong MongoDB test dùng riêng** để
kiểm báo cáo không che lỗi; không phải demo data hoặc nguồn thật đã được làm sạch.
Đối chiếu oracle đọc nguồn đã committed, không tính expected từ response.
Hồi quy phù hợp gồm US32/33/63, quyền EN04 và báo cáo US50/51; không thay tiêu chí
EN08 toàn hệ thống bằng kết quả suite của US52. Chưa tự commit/push/deploy.

Giới hạn phù hợp quy mô đề tài: projection nguồn trong kỳ và tham chiếu được đọc
vào bộ nhớ để union và phân trang sau tính; malformed source có thể nằm ngoài kỳ
và được cảnh báo thận trọng vì không xác định được ngày. Với dữ liệu lớn cần
stream/group ở DB nhưng phải giữ cùng snapshot, không phân trang trước union.
Không thêm env/dependency, không tự backfill thời gian thiếu hoặc audit giả.
