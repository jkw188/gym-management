# US-39 — UC-36: kiểm kê và điều chỉnh chênh lệch kho

Nguồn: `docs/PM/SPRINT7/[GM]Requirement_US-39.docx`, phiên bản 1.0 ngày 06/11/2026.
Giữ mã F01–05, AC01–03, TC01–12; tài liệu này mô tả triển khai, không đổi trạng thái Done của PM.
Phụ thuộc hợp đồng US-36 (chứng từ), US-37/S05-I01 (số dư/version/ledger), US-38 (xuất), EN-02 (transaction/idempotency).

## UC-36 và giao diện

Admin mở `/admin/stock-adjustments`, tìm/lọc theo mã phiếu/nguồn, trạng thái, ngày và trang.
Tạo nháp bằng SKU nội bộ gồm cả hàng ngừng bán; đọc tồn hiện tại trước khi nhập số đếm.
Số đếm gồm hàng reserved còn trong kho bán được. Nháp không cập nhật số dư hoặc version kho.
Mỗi dòng hiển thị tồn sổ/version tại mốc, thời gian đếm, tồn/giữ/version hiện tại, số đếm và delta.
Giá trị biến động `totalCost = Σ |delta| × unitCost`, có nhãn không phải doanh thu.

Có biến động sau mốc, kể cả chỉ reserve: GET detail trả `stale=true`; post trả `COUNT_SNAPSHOT_STALE`.
UI chặn ghi sổ, giữ số đếm/mốc cũ để đối chiếu; chỉ cập nhật các số hiện tại khi nhận xung đột.
Admin xem lịch sử kho, bấm **Kiểm đếm lại và nhập số mới**: đọc lại phiếu/version và inventory GET,
xóa toàn bộ số đếm trong form, yêu cầu kiểm thực tế và nhập lại tất cả dòng. Không gửi PATCH tự động.
Số mới có thể bằng số cũ nếu kiểm đếm thực tế vẫn cho cùng kết quả; backend xác minh expectedInventoryVersion.
Sửa nháp cũng đi qua bước này, bảo đảm không âm thầm giữ count cũ với mốc mới.

Sau lưu, Admin kiểm tra toàn phiếu qua dialog xác nhận trước post. Pending/unknown khóa form và đóng form,
giữ nguyên key/payload để lookup/replay. Lookup 404 không chứng minh thất bại.
POSTED chỉ đọc; sai sau post phải lập phiếu đối chiếu mới có nguồn. Không có DELETE/backdate/reverse,
không tự hủy đơn, ép reserved=0 hoặc đổi giá bán/thu tiền/đơn cũ.

## API và quyền

Mọi endpoint yêu cầu JWT/account ACTIVE/session/auth_version/role hiện hành theo US-02,
fixed policy `stockAdjustments.manage` chỉ ADMIN, kể cả replay và operation lookup.
Không có khái niệm chủ phiếu riêng: Admin quản lý chứng từ toàn phòng; ID sai kind hoặc không tồn tại trả 404.

| Endpoint | Hợp đồng |
| --- | --- |
| POST `/api/stock-adjustments` | UUID v4 key STOCK_ADJUST_CREATE; `{reason,sourceReference?,items:[{productId,countedQuantity,expectedInventoryVersion,unitCost}]}` → 201 DRAFT, version 0 |
| PATCH `/api/stock-adjustments/:id` | Key STOCK_ADJUST_UPDATE; input tạo + `version`; thay toàn bộ nháp, kiểm và chụp mốc mới từ server → 200, version +1 |
| POST `/api/stock-adjustments/:id/post` | Key STOCK_ADJUST_POST; chỉ `{version}` → 200 POSTED, postedAt/By, totalCost, movementIds (có thể rỗng) |
| GET `/api/stock-adjustments` | `status?,q?,fromDate?,toDate?,page?,limit?`; summary chỉ ADJUSTMENT |
| GET `/api/stock-adjustments/:id` | Header, items, stale, movements, movementIds, audit before/after |
| GET `/api/inventory/product-options` | Hợp quyền stockAdjustments.manage; gồm SKU INACTIVE; không trả cost/price/balance |
| GET `/api/inventory/:productId` | Nguồn expectedInventoryVersion khi kiểm đếm lại; không giữ chỗ |
| GET `/api/operations/:operation/:key` | Chỉ actor sở hữu còn quyền; trả HTTP/body đã commit |

`reason` trim 10–500, sourceReference trim ≤100 (bỏ trống chuẩn hóa `''`), 1–100 SKU không trùng.
Count và inventory/document version là JSON integer Int32 0–2147483647; không ép chuỗi thành số.
Cost là chuỗi nguyên VND 0–999999999999, tính decimal chính xác, lưu Decimal128; tổng dòng/phiếu cùng trần tiền.
Các field server (base/count time/actor/status/totals) và field lạ bị DTO strict từ chối.
Ngày/phân trang dùng convention US-36: q literal ≤120, page 1, limit 20/tối đa 100;
createdAt DESC/id DESC; mặc định 30 ngày gần nhất, tối đa 366 ngày theo Việt Nam.
DB timestamp UTC, API ISO, UI Asia/Ho_Chi_Minh.

Detail items trả `baseOnHand,baseInventoryVersion,countedQuantity,countedAt,quantityDelta,unitCost,lineTotalCost`,
snapshot SKU/tên, `currentOnHand,currentReserved,currentInventoryVersion,inventoryState,stale,inactiveWarning`.
GET chỉ đọc, không tự sửa baseline. POSTED stale=false vì đây là lịch sử, không còn là nháp cần cập nhật.
Current values luôn là số hiện tại; baseline/count/delta của POSTED giữ nguyên khi inventory/catalog tiếp tục thay đổi.

Lỗi EN01-D03: 400 DTO/ID/filter/tiền; 401 phiên; 403 quyền; 404 nguồn không có/sai kind;
409 VERSION_CONFLICT, DOCUMENT_NOT_EDITABLE, COUNT_SNAPSHOT_STALE, COUNT_BELOW_RESERVED,
INVENTORY_INTEGRITY_ERROR hoặc STOCK_LIMIT_EXCEEDED; 503 STOCK_NOT_READY/OPERATION_OUTCOME_UNKNOWN.
Không trả stack hay lỗi MongoDB thô.

## Schema/index và transaction

| Collection | Bổ sung/tái dùng |
| --- | --- |
| stock_documents | kind ADJUSTMENT, code ADJ-ObjectId unique; reason/source_reference, version, total_cost là giá trị biến động, actor/time |
| stock_document_items | counted_quantity/base_on_hand/base_inventory_version Int32 không âm, counted_at Date server; validator snapshot đủ trường/delta=count−base; quantity_delta có dấu; Decimal128 cost; unique(document_id,product_id) |
| stock_movements | ADJUSTMENT_POST:itemId khi delta≠0; source_type STOCK_ADJUST/source_id/code/document_item_id, delta(delta,0), before/after; event_key và (product_id,sequence) unique |
| stock_document_events | CREATED/UPDATED/POSTED, before/after, actor/time/request_key; unique POSTED mỗi phiếu |
| operation_requests | STOCK_ADJUST_CREATE/UPDATE/POST, actor/operation/client_key unique, hash chuẩn hóa gồm target/version, HTTP/body gốc |

Không thay index/collection/env/dependency. Các trường snapshot là tùy chọn cho RECEIPT/ISSUE cũ;
service ADJUSTMENT bắt buộc và kiểm lại đủ dữ liệu ở post. Không backfill count cho phiếu nhập/xuất.

Thứ tự ghi: key replay/hash → catalog_state revision thật → đọc chứng từ/catalog →
inventory guard_revision theo productId tăng (union SKU cũ/mới khi sửa) → kiểm mốc/điều kiện →
CAS stock_document → inventory/movements/audit/key → commit. Giữ S06-O01, không lấy khóa ngược thứ tự.
EN-02 chạy snapshot/majority/primary, cùng session, deadline retry 10 giây; đọc lại clock/điều kiện trong callback.
Không nested transaction/Promise.all trong session/side effect ngoài DB.

Create/PATCH kiểm expectedInventoryVersion dưới inventory guard rồi chụp on_hand/version/counted_at server.
Post lấy lại inventory guard, kiểm toàn bộ mốc version/onHand và count≥reserved, rồi dùng InventoryWriter duy nhất.
Delta=count−onHand (bằng count−base vì mốc còn đúng); onHand+=delta, reserved giữ nguyên.
Một movement tăng version một, sequence bằng version mới; delta=0 không gọi apply/không movement/tăng version.
Guard có thể tăng nhưng không tăng inventory.version. Writer cho phép chỉ lấy guard tại trần version cho nháp/delta0;
mọi movement không-zero vẫn bị chặn khi version đã đạt trần.
MISSING/INCONSISTENT/ledger đứt chặn ghi, không tạo balance 0 thay thế.
Lỗi dòng/movement/audit/key rollback toàn phiếu, kể cả guard và ledger.

Replay cùng key/payload trả đúng HTTP/body gốc trước kiểm version hiện tại; payload khác trả IDEMPOTENCY_CONFLICT.
Key mới trên POSTED trả kết quả ghi sổ hiện có, không movement/audit lần hai (convention US-36/38).
Các snapshot tên/SKU/count và item ID giữ nguyên khi post, bất biến sau post.

S05-I01 oracle kiểm ADJUSTMENT_POST có đúng dòng/phiếu POSTED, delta/snapshot/event_key,
base version=sequence−1, baseOnHand=beforeOnHand, count=afterOnHand và reservedDelta=0.
US-37 history chỉ cấp sourcePath `/stock-adjustments/:id` với chuỗi nguồn đã commit;
không lộ cost. UI chỉ Admin mở liên kết nguồn; xem phiếu kiểm lại quyền riêng.

## Truy vết kiểm thử và vận hành

| AC / TC | Bằng chứng source |
| --- | --- |
| AC01, TC01–04 | stock-adjustments.integration-spec: snapshot server, signed delta, DTO/RBAC, reserved-only/receipt/fulfill stale, recount PATCH |
| AC02, TC05–08 | count≥reserved, giảm về 0, delta0, Int32/cost/BSON, rollback dòng cuối/movement/audit/key, ledger oracle |
| AC03, TC09–11 | Hai Node process: hai phiếu, POS reserve/post, same-key fanout, edit/post; replay create/update/post, lookup và POSTED bất biến |
| AC03, TC12 | Source history, audit/snapshot; stock-adjustments.test.tsx: stale/recount, confirmation, double submit, unknown/replay/lookup404, routing/list |

Integration dùng MongoMemoryReplSet 8.0.17, DB tạm gym_test_us39, Supertest và harness en05-app.cjs;
build backend trước vì process dùng dist. POS/receipt/fulfill là endpoint thật, không mock tích hợp;
fault injection chỉ dùng để kiểm rollback. Chưa có checkout WEBSITE US-41 trong repository:
race checkout được kiểm bằng writer POS hiện có, cần bổ sung race WEBSITE khi US-41 được triển khai.

```powershell
cd backend
npm run typecheck
npm run typecheck:test
npm run build
npm run test:unit
npm run test:integration -- --runTestsByPath test/stock-adjustments.integration-spec.ts test/stock-issues.integration-spec.ts test/stock-receipts.integration-spec.ts test/inventory.integration-spec.ts test/pos.integration-spec.ts test/order-fulfill.integration-spec.ts test/idempotency.integration-spec.ts test/access-roles.integration-spec.ts
cd ../frontend
npm run build
npm test -- src/features/stock/stock-adjustments.test.tsx src/features/stock/stock-issues.test.tsx src/features/stock/stock-receipts.test.tsx src/features/inventory/inventory.test.tsx
```

Trước triển khai DB có sẵn, dùng quy trình bảo trì hiện có: MongoDB replica set, ensure-indexes,
seed:access và reconcile:inventory; xử lý dữ liệu sai có căn cứ, không reset balances để mở writer.
OpenAPI sinh từ controller/DTO tại `/api/docs-json`; sequence trong `stock-adjustments-sequence.mmd`.
Chưa tự commit/push/deploy, chưa nghiệm thu browser/DB vận hành hoặc đánh dấu Done trong PM.
