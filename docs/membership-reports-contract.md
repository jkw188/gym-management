# US-50 / UC-38 — Báo cáo hội viên và membership

Hợp đồng S08-M01, `metricVersion=S08-V1`. Nguồn: `docs/PM/SPRINT8/[GM]Requirement_US-50.docx` v1.0, F01–05, H01–04, AC01–03, TC01–15. Tài liệu này bổ sung thiết kế triển khai; không ghi đè baseline DOCX S01–S08. [Sequence](membership-reports-sequence.mmd).

## Quyền và API

JWT/session/account ACTIVE/auth_version/vai trò được kiểm mỗi request bằng cơ chế US-02 hiện có. `reports.memberships.read` chỉ ADMIN trong `ACCESS_POLICY`; chạy `npm run seed:access` để cập nhật danh mục quyền trên môi trường đã có dữ liệu. Quyền báo cáo không cấp quyền mutation hoặc quyền nguồn khác.

| GET dưới `/api/reports/memberships` | Query allowlist | Nội dung |
| --- | --- | --- |
| `/summary` | `asOfAt?`, `kind?=ALL` | KPI toàn phòng, byKind, metadata chất lượng |
| `/members` | Như summary; `activity?=ALL`, `q?`, `page?=1`, `limit?=20` | KPI và trang hội viên distinct **cùng snapshot** |
| `/members/:id` | `asOfAt?` | Hội viên và tất cả quyền nguồn, trạng thái hiện tại có nhãn riêng |

`kind=ALL/GYM/PT`. `activity=ALL/ACTIVE/INACTIVE`; dữ liệu chưa biết xuất hiện trong ALL với `activity=UNKNOWN`, không tự coi là INACTIVE. `q` trim, tối đa 120 ký tự, tìm literal không regex trên mã/tên. `limit<=100`; kiểm số nguyên, overflow phân trang. Query ngoài allowlist, ID sai, timestamp sai/không timezone/tương lai trả 400. Hội viên không có tại mốc trả 404. Lỗi hạ tầng trả 503 theo EN01-D03, không thành báo cáo rỗng. GET trả `Cache-Control: no-store`.

## S08-M01: timestamp và KPI

- `asOfAt` mặc định bằng `observedAt` lúc bắt đầu đọc nguồn; giữ chính xác mili giây và offset timezone. Không làm tròn về đầu ngày. `observedAt` mới cho mỗi lần đọc; không cam kết hai request cùng snapshot.
- Mẫu số là distinct `members._id` có `created_at<=asOfAt`, gồm hồ sơ ngoại tuyến và chưa mua gói. GYM/PT, activity, tìm kiếm và phân trang không thay mẫu số toàn phòng. byKind luôn mô tả riêng GYM/PT; filter.kind xác định nhóm được chọn cho KPI gốc.
- `effectiveStart=max(đầu ngày start_date VN, transaction.settled_at, membership.created_at)`.
- `effectiveEnd=min(đầu ngày sau end_date VN, superseded_at nếu có, cancelled_at nếu có)`; khoảng `[start,end)`. Giao dịch phải SETTLED, loại GYM/PT và cùng chủ hồ sơ/snapshot loại khi có.
- SUPERSEDED hiện tại vẫn tính trước `superseded_at`. CANCELLED chỉ tính lịch sử khi có bằng chứng settlement, creation và `cancelled_at`. Schema bổ sung trường Date tùy chọn để đọc chứng cứ hủy nếu nguồn từng hỗ trợ; US50 không tạo lệnh hủy gói.
- Không đọc `paid_at`, quota, trạng thái account, giá plan live hay check-in. Gói miễn phí SETTLED không payment vẫn tính. Group theo member trước KPI; `activeMemberships` là số document quyền, khác số người. Rate null nếu mẫu số 0.
- Chi tiết trả ID membership/sale/transaction/plan, snapshot tên/kỳ ngày, `createdAt`, effective interval, `qualifies=true/false/null`, reasonCodes và currentStatus/currentTransactionStatus. Bảng sort `members.created_at DESC,_id DESC`; quyền sort `memberships.created_at DESC,_id DESC`.

## Snapshot, schema và index

ReportsModule tái sử dụng TransactionRunner EN-02: readConcern snapshot, readPreference primary, một session; tất cả đọc tuần tự. Không ghi nguồn, sửa status, settlement, quota hay snapshot báo cáo định kỳ. Môi trường cần MongoDB replica set hiện có; standalone trả 503.

Repository đọc projection của members → service_sales → memberships → transactions trong cùng snapshot; join bằng ObjectId qua Map, không unwind payments/invoices/reviews. Mẫu số bắt đầu từ các hồ sơ đủ mốc, quyền group distinct theo hồ sơ. Projection không đọc contact, mật khẩu, ngân hàng hoặc số tiền. Quy mô sinh viên dùng tập nguồn trong bộ nhớ để cùng phát hiện nguồn mồ côi/settled thiếu membership; chưa tối ưu cho dataset lớn. Các scan nguồn hiện tại cần đọc toàn tập; không tuyên bố toàn bộ báo cáo dùng index để tránh scan.

Tái sử dụng index đã có: `members_created_desc(created_at:-1,_id:-1)`, `service_sales_member_kind(member_id:1,kind_snapshot:1)`, unique `_id`, `service_sales_transaction_unique`, `memberships_sale_unique`. Test explain trên fixture MongoDB kiểm lookup member/kind và điều kiện mẫu số sử dụng IXSCAN khi chọn index; không đại diện benchmark tải hoặc hiệu năng toàn bộ scan báo cáo. Không thêm index trùng, không syncIndexes hay backfill timestamp tự động khi startup/GET.

## Chất lượng và coverage

`dataQuality=COMPLETE/PARTIAL/UNAVAILABLE`, `invalidRecordCount`, `warningCodes` có trên cả ba endpoint. Các lỗi có thể ảnh hưởng mốc gồm thiếu settlement/creation/supersession/cancellation, thiếu nguồn, owner/kind lệch, trùng membership cùng sale, settled thiếu membership. Cận thời gian đã biết có thể chứng minh nguồn lỗi không ảnh hưởng mốc, khi đó không làm mất KPI chắc chắn.

Chỉ số bị ảnh hưởng trả null; nhóm GYM/PT độc lập giữ số chắc chắn. Thiếu ngày tạo hồ sơ làm mẫu số và KPI không xác định, quality UNAVAILABLE. `knownTotals` là phần đã biết, UI ghi nhãn chưa phải tổng đầy đủ. `qualifyingMembershipCount=null` nếu không chắc số quyền; member có một quyền chắc chắn vẫn ACTIVE. Không suy ngày từ updated_at/paid_at/account creation. Không xác định được phạm vi coverage thì **bỏ `historyCoverageFrom`**, UI ghi “Chưa xác định”. EN08/người vận hành phải đối chiếu nguồn và bổ sung lịch sử có chứng cứ trước nghiệm thu dataset thực.

KPI phản ánh lịch sử nghiệp vụ có tại observedAt, không phải bản báo cáo đã phát hành trước đây. Hiệu chỉnh nguồn có audit có thể làm thay kết quả mốc cũ.

## React và kiểm tra

Route Admin `/admin/reports/memberships`, liên kết ở trang chính Admin. Input datetime-local được hiểu là UTC+07:00 độc lập timezone máy. Nút Xem báo cáo áp dụng thời điểm/kind/bộ lọc; loading ẩn response cũ. Bảng và KPI lấy cùng `/members` response; đổi trang cũng đọc lại cả hai, giữ asOfAt. Chi tiết request riêng có observedAt riêng và nhãn giải thích, không gộp snapshot. Refresh/focus/online đọc lại nguồn. Loading/empty/error/partial/UNAVAILABLE và rate Không áp dụng được phân biệt; null không đổi thành 0.

Kiểm thử: `backend/test/membership-reports.integration-spec.ts` dùng MongoDB 8.0.17 replica set, login JWT thật, fixture 4 hồ sơ, oracle EN08 độc lập trên nguồn committed, lịch sử upgrade/VN/settlement, quality, filter, quyền, concurrent source commit, GET không mutation và lỗi 503. `frontend/src/features/reports/membership-reports.test.tsx` kiểm UTC+07, snapshot UI, nguồn lịch sử, partial, empty, lỗi, logout và route 4 vai trò. Chạy bằng scripts repository:

```powershell
cd backend
npm run test:integration -- --runTestsByPath test/membership-reports.integration-spec.ts
cd ../frontend
npm test -- src/features/reports/membership-reports.test.tsx
```

Test riêng US50 không xác nhận hoàn thành toàn gate EN08/EN07, US51/52 hoặc nghiệm thu dữ liệu triển khai thực tế.
