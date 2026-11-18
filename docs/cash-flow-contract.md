# US-51 / UC-38 / S08-C01 — Khoản thu và hoàn tiền

Đặc tả triển khai bổ sung cho `docs/PM/SPRINT8/[GM]Requirement_US-51.docx` v1.0; giữ nguyên baseline DOCX và mã truy vết. Nguồn thời gian/phương thức kế thừa US-22, US-45, US-46; fixture và oracle độc lập kế thừa EN-08-O03. Không thay đổi lệnh settlement, hủy đơn hoặc payout.

## Use case UC-38

Actor ADMIN có `reports.cashFlow.read` mở `/admin/reports/cash-flow`, chọn kỳ ngày VN, loại GYM/PT/RETAIL, phương thức thu/chi; hệ thống trả KPI, nhóm ngày/loại/phương thức và trang sự kiện cùng snapshot. Admin mở một sự kiện để đối chiếu ID/mã chứng từ. Chi tiết dùng request mới và có observedAt riêng. Không có quyền sửa nguồn từ báo cáo.

- Thu = mỗi `payments._id` SUCCEEDED một lần, theo `paid_at`, loại từ `transaction.kind`. Không yêu cầu transaction SETTLED hoặc order COMPLETED; khoản muộn đơn hủy vẫn cộng thu, giữ `lateReceipt=true` và invoice có thể null.
- Đã hoàn = mỗi `refunds._id` SUCCEEDED một lần theo `refunded_at`; loại qua payment gốc → transaction. Không yêu cầu payment/sale/return trong cùng kỳ. Không join invoice_items, return_items hoặc refund_attempts để cộng tiền.
- Thu trừ hoàn = thu − đã hoàn, giữ số âm. Không cộng invoices.total_amount, credit hoặc list_price; gói miễn phí không tạo event giả.
- PENDING/FAILED là số dư nghĩa vụ **hiện tại tại observedAt** và count, không phải chi trong kỳ hay số dư lịch sử cuối kỳ.
- Không thay timestamp bằng verified_at/settled_at. Xác minh muộn có thể làm thay đổi kết quả kỳ cũ khi chạy lại.

## API và thời gian

Cả ba API dùng JWT/session/account ACTIVE/auth_version/role hiện hành của US-02 và `FixedPermission('reports.cashFlow.read')` theo catalog cố định. STAFF/TRAINER/MEMBER 403, phiên không hợp lệ 401. Seed access chỉ đồng bộ catalog giải thích, không dùng mapping DB để cấp thêm quyền ngoài policy.

| API | Input và output |
| --- | --- |
| `GET /api/reports/cash-flow/summary` | `fromDate?`, `toDate?`, `kind=ALL/GYM/PT/RETAIL`, `paymentMethod=ALL/CASH/TRANSFER`, `payoutMethod=ALL/CASH/TRANSFER`; summary bên dưới |
| `GET /api/reports/cash-flow/events` | Cùng filter; thêm `eventType=ALL/RECEIPT/REFUND`, `q?`, `page=1`, `limit=20` (max100); summary + `{eventFilter,items,page,limit,total,totalPages}` |
| `GET /api/reports/cash-flow/events/:eventType/:id` | RECEIPT/REFUND và ObjectId hợp lệ; cùng filter kỳ tùy chọn; summary + event. Không truyền kỳ thì dùng ngày thực tế của event để mở được nguồn cũ; nguồn thiếu timestamp dùng kỳ mặc định và cảnh báo |

Ngày YYYY-MM-DD hợp lệ và gồm cả hai đầu. Mặc định fromDate=đầu tháng hiện tại, toDate=hôm nay VN; mỗi giá trị thiếu dùng mặc định tương ứng. `W=[00:00 VN fromDate,00:00 VN sau toDate)`, tối đa366 ngày, toDate≤hôm nay VN; `occurredAt<=observedAt`. `range` trả ngày, timezone, `start`, `endExclusive`, `effectiveTo=min(end,observedAt)`, `isOngoing`. Group ngày VN, trả tất cả ngày trong kỳ kể cả0; ngày hiện tại `isComplete=false`.

`paymentMethod` chỉ lọc RECEIPT, `payoutMethod` chỉ lọc REFUND SUCCEEDED. Response ghi rõ `filter.paymentMethodScope=RECEIPTS_ONLY` và `payoutMethodScope=SUCCEEDED_REFUNDS_ONLY`. Nghĩa vụ hiện tại chỉ lọc kind, `dateFilterApplied=false`, `methodFiltersApplied=false`: nghĩa vụ chưa chi chưa thể biết phương thức chi thực tế. eventType/q/page chỉ lọc bảng, không đổi KPI.

Summary gồm `range`, `observedAt`, `metricVersion=S08-V1`, `dataQuality`, `warningCodes`, `invalidRecordCount`, `totals`, `knownTotals`, `filter`, `byKind`, `byDate`, `byMethod`, `currentOutstandingRefunds`. Mỗi nhóm có `{totals,knownTotals}` với grossReceipts/refundPaid/netCash. Nhóm UNKNOWN giúp đối chiếu dữ liệu cũ. Tiền nguồn phải Decimal128 nguyên dương hợp lệ EN02-D02; giải mã decimal rồi cộng/trừ bằng BigInt nguyên VND chính xác, không qua Number và không áp trần một giao dịch cho tổng. JSON trả chuỗi nguyên, net có dấu.

Event trả eventId=`loại:id`, occurredAt, amount, kind, method, status, paymentId/refundId, transactionId/code, orderId/code?, returnId?, invoiceId/code?, lateReceipt và warningCodes. Sort occurredAt DESC,eventType ASC,id DESC; thiếu timestamp ở cuối. q trim≤120, tìm literal bằng includes trên mã/ID được cho phép (không dùng regex đầu vào). Rỗng totalPages=0; query lạ, ngày sai, ID sai, pagination sai trả400. Nguồn không nằm trong kỳ/filter hoặc không tồn tại trả404.

Không đọc/xuất contact, buyer snapshot, evidenceNote, bankReference, receiving/payout account hoặc reference ngân hàng. UI hiện ID/mã nguồn; mọi API chứng từ vẫn kiểm quyền riêng. Cache-Control no-store. Lỗi theo EN01-D03, DB503 không chuyển thành báo cáo rỗng. OpenAPI khai báo query, projection, nullable money, quality và lỗi trong controller.

## Snapshot, schema/index và chất lượng

Mỗi request mở `ClientSession({snapshot:true})`, đọc tuần tự trên primary; driver chốt atClusterTime ở lần đọc đầu, các source/getMore dùng cùng session. MongoDB phiên bản đang dùng8.0 hỗ trợ snapshot session (yêu cầu≥5, replica set/sharded có snapshot reads). finally đóng session, cursor timeoutMS5000 giới hạn cả các batch; không mở write transaction. observedAt lấy từ server trước khi đọc. Không hứa hai request cùng snapshot. Không mutation trong GET, không tự settlement/payout/completion.

Repository đọc riêng tập payments SUCCEEDED, refunds SUCCEEDED/PENDING/FAILED và projection transactions/orders/invoices, map theo ID; tổng thu và chi độc lập trước khi hợp nhất theo ngày. Phải đọc cả nguồn thiếu ngày để không âm thầm làm mất bản ghi lỗi. Theo quy mô dự án sinh viên và convention US50, hiện đọc các tập projection vào bộ nhớ; chưa phân trang nguồn ở DB hoặc benchmark tải lớn. Index hỗ trợ tra cứu nguồn nhưng không tuyên bố toàn bộ báo cáo tránh scan.

| Collection | Index bổ sung/giữ nguyên |
| --- | --- |
| payments | Thêm `payments_status_paid(status:1,paid_at:-1,_id:-1)`; giữ unique reference và partial unique transaction SUCCEEDED EN02 |
| refunds | Thêm `refunds_status_refunded(status:1,refunded_at:-1,_id:-1)`; giữ payment_id/order_id, unique obligation_key/reference và partial unique payout_reference_key |
| transactions/invoices | Dùng `_id`/transaction_id hiện có; invoice chỉ phục vụ drill-down |

Chạy `npm run ensure-indexes` và `npm run seed:access` ở backend trước triển khai. Không thêm collection/schema field/env/dependency; không backfill timestamp/method, không sửa/xóa dữ liệu qua GET.

`SOURCE_KIND_UNKNOWN`, `INVALID_AMOUNT`, `EVENT_TIMESTAMP_INVALID`, `PAYMENT_METHOD_UNKNOWN`, `PAYOUT_METHOD_UNKNOWN` được đếm theo source (một bản ghi nhiều lỗi vẫn count1). Nguồn lỗi ngoài kỳ đã chứng minh bằng timestamp không ảnh hưởng KPI kỳ. Thiếu timestamp có thể ảnh hưởng mọi ngày trong kỳ; thiếu kind có thể ảnh hưởng loại chưa xác định. Chỉ số bị ảnh hưởng null, các phần chắc chắn giữ nguyên. knownTotals có nhãn PARTIAL khi có lỗi; chỉ cộng tiền/giới hạn kỳ/filter đã biết, không dùng invoice để bù.

Thiếu phương thức vẫn nhóm UNKNOWN và cảnh báo; không lọc method thì tổng tiền đã biết vẫn xác định được, còn lọc method cụ thể thì phần không chắc chắn null. Không đoán method refund từ payment. Nghĩa vụ lỗi có quality riêng, knownAmount/knownCount và số chuẩn null khi thiếu căn cứ. Quality tổng COMPLETE khi không có lỗi, PARTIAL khi có phần xác định được, UNAVAILABLE khi không có event chắc chắn để tính dòng tiền. Cảnh báo không thay thế đối soát/làm sạch dữ liệu thực trước nghiệm thu EN08.

## Kiểm thử và nghiệm thu

| Truy vết | Suite/assert chính |
| --- | --- |
| AC01 / TC01–05 / EN08-O03 | `cash-flow.integration-spec.ts`: nạp fixture EN08 vào MongoDB replica set, JWT thật, so API với oracle độc lập trên nguồn committed; 2.000.000/100.000/1.900.000; GYM1.000.000/PT500.000/RETAIL400.000; nghĩa vụ70.000. Child records và invoice0/credit không nhân tiền |
| AC02 / TC06–10 | Net âm, ngày VN/verification khác kỳ, observedAt bao gồm đúng timestamp nhưng loại tương lai, ngày trống0; filter thu/chi độc lập; 10.000 payment hợp lệ tổng9.999.999.999.990.000; orphan/NaN/thiếu ngày/method |
| AC03 / TC11–14 | JWT bốn role/revoked/locked, không lộ evidence/bank; late receipt không invoice; commit payout xen giữa reads vẫn giữ cùng snapshot; 400/404/503/no-write/index explain |
| AC03 / TC15 | `cash-flow.test.tsx`: bộ lọc và dữ liệu hiển thị, tiền âm/chính xác, VN, nghĩa vụ hiện tại, nguồn chi tiết/snapshot riêng, PARTIAL/null, loading/empty/503, online refresh, stale response/logout, route bốn role |

Lệnh từ backend: `npm run test:integration -- --runTestsByPath test/cash-flow.integration-spec.ts`.
Từ frontend: `npm test -- src/features/reports/cash-flow.test.tsx`.
EN08 tự phát hiện các suite này khi chạy lại toàn bộ; `scripts/en08-matrix.json` gắn nguồn/suite ứng viên, không tự đổi NOT_RUN thành PASS. Toàn gate EN08 còn cần frozen commit, review AC, US52 và UAT/operator evidence. Không tự commit theo yêu cầu dự án.
