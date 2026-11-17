# US-33 / UC-34 — tổng hợp đánh giá huấn luyện viên

Nguồn đã đối chiếu: `PM/SPRINT7/[GM]Requirement_US-33.docx` v1.0,
US-31 v1.0 và US-65 v1.0; Q10. Giữ nguyên các baseline DOCX và mã AC/TC.
Hợp đồng bổ sung này mô tả API, use case, schema/index và kiểm thử triển khai;
không thay đổi trạng thái nghiệm thu trong requirement.

## UC-34: đối chiếu chất lượng PT (US-33-F01–F05)

Admin đăng nhập, mở `/admin/trainer-reviews`, chọn PT/kỳ gửi/điểm, xem số lượt,
trung bình, phân bố theo PT và tổng toàn tập lọc. Danh mục có cả INACTIVE và PT
không có review: count=0, average=null, UI hiển thị dấu không áp dụng và “Chưa có
đánh giá”. Không xếp hạng thưởng/phạt hoặc công khai nhận xét.

Admin mở nhận xét gốc, đối chiếu mã/giờ buổi, giờ gửi và tên snapshot của PT/học
viên. Không có sửa/xóa/ẩn/thay author/rating. UI render plain text bằng React,
giữ xuống dòng; HTML/URL không trở thành thẻ hoặc liên kết ngoài.

Nhánh lỗi: bộ lọc sai 400; phiên không còn hợp lệ 401; sai role 403; detail không
có hoặc nguồn không hợp lệ 404; DB lỗi 503. Envelope EN01-D03. UI có loading,
empty/error/retry, online tải lại; đổi account/logout hủy request và bỏ state cũ.

## API và quyền

`trainers.reviews.read` chỉ ADMIN trong fixed policy US-02; kiểm JWT, account,
session và auth_version ở mỗi request. Không dùng public API hoặc mở cho Staff.
`npm run seed:access` đồng bộ danh mục quyền; policy không phụ thuộc cache ở UI.

| GET `/api` | Kết quả |
| --- | --- |
| `/admin/trainer-reviews/summary` | `{items,page,limit,total,totalPages,asOf,range,totals,invalidReviewCount}`; phân trang theo PT |
| `/admin/trainer-reviews` | Cùng envelope, phân trang theo review gốc; createdAt DESC, id DESC |
| `/admin/trainer-reviews/:id` | Review nguồn với booking, memberDisplayName, trainerId, trainerNameSnapshot, rating, comment, createdAt, asOf |

Hai list nhận đúng allowlist `trainerId?,fromDate?,toDate?,rating?,page?,limit?`.
Detail không nhận query. ID là ObjectId; query ngoài allowlist trả 400.
page=1, limit=20, tối đa 100; totalPages=0 khi total=0, trang vượt dữ liệu giữ total
nhưng items rỗng. Summary sort PT theo created_at DESC, _id DESC, theo convention
US-32; không sort theo điểm. Không có PT khớp trainerId trả list rỗng.

Mỗi summary item gồm trainerId, currentTrainerName (nhãn tên hiện tại), status và
metrics. Review trả tên chụp lúc gửi, không tra tên hiện tại thay snapshot. Không
trả contact, hồ sơ sức khỏe, password, created_by hoặc dữ liệu tài khoản.

## Kỳ và công thức chung US-31/33/65

Nguồn duy nhất là `trainer_reviews` do US-65 ghi. `created_at` là thời điểm gửi,
khác `pt_bookings.start_at/end_at`. Helper `review-period.ts` dùng chung US-31/33:
ngày VN thật YYYY-MM-DD, `[00:00 fromDate +07:00, 00:00 ngày sau toDate +07:00)`;
thiếu toDate lấy hôm nay, thiếu fromDate lấy 29 ngày trước toDate. Tối đa 366 ngày
tính cả hai đầu. Ngày không thật, kỳ ngược/quá dài trả 400 chỉ rõ field.

Metrics `{reviewCount,ratingSum,averageRating,distribution}` trên toàn tập đã lọc,
bao gồm rating filter. Count hợp lệ, sum điểm, average=sum/count (count=0 → null);
UI làm tròn 2 chữ số, server giữ độ chính xác. Distribution có đủ khóa 1–5 và tổng
bằng count. Toàn phòng = tổng điểm / tổng lượt; không lấy trung bình điểm PT.
PT A một điểm 5, B ba điểm 1 → totals=4 lượt, 8 điểm, average=2.00.

US-33 phân loại nguồn hợp lệ khi rating là số nguyên 1–5; booking tồn tại,
COMPLETED, khớp trainer_id/member_id với review; hồ sơ trainer/member tồn tại;
giờ buổi là Date hợp lệ và end>start; comment/tên snapshot là string hoặc thiếu
ở nguồn cũ. Snapshot thiếu trả chuỗi rỗng, UI ghi rõ; không suy từ contact hoặc
thay tên lịch sử. Không kiểm gói còn hiệu lực ở thời điểm đọc review.

Nguồn sai hoặc mồ côi trong kỳ/filter bị loại khỏi items và điểm, detail 404.
`invalidReviewCount` tính trên cùng predicate kỳ/PT/điểm; không phân bổ review mồ
côi cho PT khác. Log `INVALID_TRAINER_REVIEW` với reviewId, không comment/PII.
Review thiếu/sai created_at không xác định được kỳ nên không vào tập kỳ; cần
đối soát migration trước vận hành. GET không backfill/chữa rating hoặc owner.

## Snapshot và index

TransactionRunner hiện có dùng primary + snapshot; trong callback chỉ đọc,
không acquire guard hay ghi revision, không Promise.all trên session. Facet dùng
chung predicate cho nhóm tổng, trang review và ID lỗi. Summary đọc danh mục PT
trong cùng session, ghép với nhóm tổng rồi phân trang; totals không bị cắt theo
trang. Chỉ tải danh mục PT/nhóm tổng/ID lỗi vào bộ nhớ, không tải toàn bộ comment.
Các request summary/list/detail có thể có asOf khác nhau và UI hiển thị riêng.

Giữ unique booking_id, index (trainer_id,created_at,_id) và
(member_id,created_at,_id); bổ sung (created_at,_id) tên `trainer_reviews_time`.
`npm run ensure-indexes` dùng schema qua migration có sẵn US-65; không thêm
collection điểm trung bình, env hoặc dependency. Replica set là yêu cầu hiện có.

## Truy vết kiểm thử

`backend/test/admin-trainer-reviews.integration-spec.ts`: AC01/TC01–04 nguồn US-65
qua HTTP thật, quyền và phiên; AC02/TC05–08 trọng số, rating filter, trang độc lập,
review null/mồ côi, biên VN; AC03/TC09–12 text/projection/chỉ đọc/503. Thêm test
snapshot khi xóa PT giữa hai lệnh đọc và kiểm index được tạo.

`frontend/src/features/trainer-reviews/admin-trainer-reviews.test.tsx`: totals do
server trả, null/INACTIVE, bộ lọc áp dụng, phân trang độc lập, drill-down GET, XSS,
ngày buổi/ngày gửi riêng, loading/error/retry/online/empty, đổi account, request
về muộn và route ADMIN. Frontend test dùng mock ở ranh giới HTTP client; backend
integration dùng MongoDB replica set thật do mongodb-memory-server quản lý.

OpenAPI sinh từ DTO/controller trong môi trường development tại `/api/docs`.
Sequence: `trainer-reviews-sequence.mmd`. Không tự commit/push/deploy.
