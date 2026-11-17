# US-38 — UC-36: xuất kho ngoài bán hàng

Nguồn: `docs/PM/SPRINT7/[GM]Requirement_US-38.docx`, bản 1.0 ngày 06/11/2026.
Giữ mã F01–05, AC01–03, TC01–12; không đánh dấu Done trong PM.

## Use case và API

Admin mở `/admin/stock-issues`, tìm/lọc phiếu, tạo hoặc thay toàn bộ nháp,
kiểm tra tồn khả dụng rồi xác nhận ghi sổ. Chỉ dùng cho hao hụt, hư hỏng, sử dụng nội bộ;
UI yêu cầu lý do/căn cứ, không có chọn đơn hay adapter xuất bán. `sourceReference` là căn cứ văn bản,
không kích hoạt cập nhật order. Bàn giao WEBSITE/POS tiếp tục dùng writer US-44/53.

Mọi endpoint yêu cầu JWT/session/account hiện hành và fixed policy `stockIssues.manage` chỉ ADMIN.
Picker hợp thêm policy này nhưng không trả cost hay cấp thêm quyền nhập kho.
Seed quyền dùng `ACCESS_POLICY` hiện có.

| Endpoint | Input / output |
| --- | --- |
| POST `/api/stock-issues` | Key `STOCK_ISSUE_CREATE`; `{reason,sourceReference?,items:[{productId,quantity,unitCost}]}` → 201 DRAFT version 0 |
| PATCH `/api/stock-issues/:id` | Key `STOCK_ISSUE_UPDATE`; toàn bộ input tạo + version → 200, version +1 |
| POST `/api/stock-issues/:id/post` | Key `STOCK_ISSUE_POST`; chỉ `{version}` → 200 POSTED, postedAt/By, totalCost, movementIds |
| GET `/api/stock-issues` | status?,q?,fromDate?,toDate?,page?,limit? → summary phân trang, chỉ kind ISSUE |
| GET `/api/stock-issues/:id` | header, quantity dương, snapshot SKU/tên/cost, movements, version, audit trước/sau |

Lệnh ghi cần UUID v4 `Idempotency-Key`. DTO strict từ chối field lạ, actor/orderId/items tại post.
Sai ID/filter/input: 400; phiên: 401; quyền: 403; không có/sai kind: 404; version/state/tồn: 409;
thiếu index: 503 STOCK_NOT_READY. Envelope lỗi dùng EN01-D03, không trả lỗi MongoDB thô.

Reason trim 10–500, sourceReference trim tối đa 100, bỏ trống chuẩn hóa `''`.
1–100 SKU khác nhau; quantity JSON integer 1–999. Có thể xuất SKU/category ngừng bán,
nhưng product/category phải tồn tại và inventory/ledger phải hợp lệ. Nháp không đổi số dư, version kho,
sequence hay tạo movement; guard_revision có thể tăng để kiểm inventory trong transaction.
Giá ghi nhận Admin nhập là chuỗi nguyên VND 0–999999999999, không phải giá vốn bình quân.
Tổng dòng/tổng phiếu tính bằng decimal, cùng giới hạn tiền, lưu Decimal128; không tin tổng client.

Query ngày/phân trang/literal search kế thừa US-36: mặc định 30 ngày gần nhất theo Việt Nam,
tối đa 366 ngày gồm hai đầu, khoảng `[from 00:00 +07:00, ngày sau to 00:00 +07:00)`.
q trim ≤120, tìm code/sourceReference; page mặc định 1, limit 20/tối đa 100; rỗng totalPages 0.
DB timestamp UTC, API ISO, UI `Asia/Ho_Chi_Minh`.

## Transaction, schema và S05-I01

`StockDocumentsService` tái dùng luồng US-36 với policy RECEIPT/ISSUE;
`StockIssuesService` và `StockReceiptsService` chọn kind cố định. StockModule dùng InventoryWriter chung,
không tạo writer số dư riêng. Endpoint PUT và contract nhập kho giữ nguyên.

Thứ tự: replay key/hash → catalog_state revision thật → đọc nháp/product/dòng → khóa inventory theo productId tăng
→ kiểm mọi q ≤ onHand−reserved → CAS stock_document → snapshot/movement/audit/key → commit.
Sửa nháp khóa hợp SKU cũ/mới; tạo ISSUE cũng kiểm inventory dưới khóa.
Version cũ chặn VERSION_CONFLICT; thiếu khả dụng chặn INSUFFICIENT_AVAILABLE_STOCK toàn phiếu,
không tự giảm lượng, hủy reservation hay giảm reserved. MISSING/INCONSISTENT chặn, không upsert số dư.
Một dòng/movement/audit/key lỗi rollback mọi ghi, kể cả guard. US-38 không phát sinh notification/outbox mới.

| Collection | Hợp đồng US-38 trên schema/index US-36 |
| --- | --- |
| stock_documents | kind ISSUE, ISS-ObjectId code unique, DRAFT/POSTED, version, reason/source_reference, actors/times, total_cost Decimal128 |
| stock_document_items | unique(document_id,product_id), quantity_delta âm, unit_cost/line_total_cost Decimal128, snapshots; item IDs giữ nguyên khi post |
| stock_movements | ISSUE_POST:itemId event_key unique; unique(product_id,sequence), delta(−q,0), before/after, source_type STOCK_ISSUE, source_id/code, document_item_id; không order_item_id giả |
| stock_document_events | CREATED/UPDATED/POSTED, before/after chứa version và reason, actor/time/request_key; POSTED duy nhất mỗi document |
| operation_requests | STOCK_ISSUE_CREATE/UPDATE/POST, unique(actor_id,operation,client_key); hash chuẩn hóa gồm target/version, response gốc cùng transaction |

POSTED bất biến, không update/delete/reverse. Cùng key/payload replay HTTP/body gốc trước kiểm version hiện tại;
payload khác trả IDEMPOTENCY_CONFLICT. Key mới trên POSTED trả kết quả đã ghi sổ,
không trừ thêm hoặc thêm audit POSTED. Sai sót cần nghiệp vụ điều chỉnh US-39 có căn cứ, không sửa movement cũ.
InventoryWriter kiểm ledger ISSUE_POST về đúng dòng/phiếu ISSUE POSTED, delta âm, reservedDelta 0 và snapshot.
Mỗi movement tăng inventory.version một, sequence bằng version mới; guard không tăng sequence.
EN-02 dùng snapshot/majority/primary và deadline 10 giây; không nested transaction, Promise.all trong session hoặc side effect ngoài DB.

GET lịch sử kho cấp sourcePath `/stock-issues/:id` khi chuỗi nguồn đúng; không trả cost.
UI chỉ Admin có liên kết `/admin/stock-issues?documentId=...`, kiểm pattern/type/id trước điều hướng;
endpoint nguồn kiểm lại quyền. Picker không thêm giá/số dư/cost vào response.

UI khóa form khi pending/unknown, giữ key/payload cho lookup `/api/operations/:operation/:key`
hoặc gửi lại nguyên yêu cầu. Lookup 404 và 503 OPERATION_OUTCOME_UNKNOWN không chứng minh thất bại.
Conflict giữ số lượng, yêu cầu tải lại phiếu và kiểm tồn; không tự giảm lượng. Trước xác nhận,
UI đọc tồn thật và hiển thị thời điểm đọc; backend kiểm lại dưới khóa khi post.

## Truy vết kiểm thử và vận hành

| Requirement / TC | Kiểm thử |
| --- | --- |
| F01/02, TC01–04/08 | stock-issues.integration-spec: nháp, quyền/phiên/role đổi, DTO/tiền, inactive, sai kind, Swagger |
| F03/04, TC05–07 | Receipt/POS writer thật tạo 10/4, xuất 6 và chặn 7; rollback dòng cuối/movement/audit/key; ledger oracle |
| F04/05, TC09–11 | Hai tiến trình Node: ISSUE/ISSUE, ISSUE/POS reserve, ISSUE/RECEIPT, ISSUE/POS fulfill; 20 same-key, key mới, CAS edit/post |
| F05, TC12 | Mất phản hồi sau commit → lookup/replay; source navigation, immutable snapshot/audit |
| UI, TC12 | stock-issues.test.tsx: confirmation, pending, unknown/lookup 404, conflict/reload, thiếu tồn, routing; inventory.test.tsx: link ISSUE đúng quyền |

Suite integration dùng MongoMemoryReplSet 8.0.17, DB tạm `gym_test_us38`, hai Nest app và hai process
qua harness `scripts/en05-app.cjs`; cần build backend trước. Fixture không dùng dữ liệu vận hành.
Checkout WEBSITE US-41 và adjustment US-39 chưa có writer trong repository nên chưa thể nghiệm thu
race chéo với các endpoint đó; không thay bằng mock rồi coi tích hợp thật đã đạt.
Không thêm adapter/feature ngoài US-38 để lấp dependency chưa có.

```powershell
cd backend
npm run typecheck
npm run typecheck:test
npm run build
npm run test:unit
npm run test:integration -- --runTestsByPath test/stock-issues.integration-spec.ts test/stock-receipts.integration-spec.ts test/inventory.integration-spec.ts test/pos.integration-spec.ts test/order-fulfill.integration-spec.ts test/idempotency.integration-spec.ts test/access-roles.integration-spec.ts
cd ../frontend
npm run build
npm test -- src/features/stock/stock-issues.test.tsx src/features/stock/stock-receipts.test.tsx src/features/inventory/inventory.test.tsx
```

MongoDB vận hành cần replica set và schema/index US-36/37: chạy `ensure-indexes`, `seed:access`,
`reconcile:inventory` khi triển khai theo quy trình bảo trì hiện có. Không có env/dependency/index mới,
không rewrite/backfill dữ liệu. OpenAPI sinh từ controller/DTO tại `/api/docs-json`.
Nghiệm thu browser/DB triển khai thực tế cần chạy riêng; không tự commit/push/deploy.
