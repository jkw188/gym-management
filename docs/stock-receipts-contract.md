# US-36 — UC-25: lập và ghi sổ phiếu nhập

Nguồn: `docs/PM/SPRINT5/[GM]Requirement_US-36.docx` phiên bản 1.0.
US-34 sở hữu S05-C01; US-37 sở hữu S05-I01 và hợp đồng picker.
Tài liệu mô tả implementation, không thay đổi mã F/AC/TC hoặc chính sách requirement.

## UC-25 và API

Staff/Admin có `stockReceipts.manage` thao tác RECEIPT của toàn nhóm vận hành.
Backend dùng fixed RBAC từ ACCESS_POLICY, kiểm session hiện hành trước request/replay/lookup.
Member/PT không được xem phiếu hoặc giá nhập. Không DELETE, sửa POSTED, hủy ghi sổ hoặc sửa tồn trực tiếp.

| Endpoint | Nội dung |
| --- | --- |
| GET `/api/stock-receipts` | `status?,q?,fromDate?,toDate?,page?,limit?`; q literal code/sourceReference; createdAt DESC, id DESC |
| GET `/api/stock-receipts/:id` | Header/version/items snapshot/tổng cost/postedBy/At; movementIds và movements allowlist của chính phiếu |
| POST `/api/stock-receipts` | `{reason,sourceReference?,items:[{productId,quantity,unitCost}]}` → 201 DRAFT version 0 |
| PUT `/api/stock-receipts/:id` | `{version,reason,sourceReference?,items:[...]}` → thay toàn bộ DRAFT, version +1 |
| POST `/api/stock-receipts/:id/post` | Chỉ `{version}` → 200 POSTED kèm movementIds |
| GET `/api/inventory/product-options` | Phần phụ thuộc US-37: `q?,categoryId?,page?,limit?`; gồm ACTIVE/INACTIVE, không cost/price/balances |

Picker nhận quyền `inventory.read` hoặc `stockReceipts.manage` (cả hai hiện là STAFF/ADMIN).
Trả identity/status/effectiveActive/inventoryState VALID/MISSING/INCONSISTENT.
Đọc picker/list/detail dùng snapshot transaction, không tăng catalog revision hoặc sửa dữ liệu.
Các màn hình tồn kho/history US-37 và hợp đồng S05-I01 được mô tả trong [inventory-contract.md](inventory-contract.md).

Các command yêu cầu UUID v4 Idempotency-Key: STOCK_RECEIPT_CREATE/UPDATE/POST.
Scope actor + operation + key; hash payload chuẩn hóa gồm target/version; replay giữ HTTP/body gốc,
khác payload trả IDEMPOTENCY_CONFLICT. Lookup `/api/operations/:operation/:key` chỉ actor sở hữu còn quyền.
Key mới đến POSTED trả kết quả hiện có, bỏ qua version nháp cũ; không tạo movement/audit POSTED lần hai.
Không nhận items/status/actor/time ở endpoint post. OPERATION_UNKNOWN chưa chứng minh thất bại;
OPERATION_OUTCOME_UNKNOWN cần giữ key để lookup hoặc replay.

Reason trim 10–500, sourceReference trim tối đa 100; bỏ trống chuẩn hóa thành chuỗi rỗng.
1–100 dòng, mỗi product duy nhất, quantity JSON integer 1–1000000; cost chuỗi nguyên VND 0–999999999999.
Tổng dòng/tổng phiếu tính decimal ở backend, cùng giới hạn tiền. Hàng tặng cost 0 ghi căn cứ trong reason.
Không tự đổi giá bán, tạo payment/invoice. SKU/category INACTIVE được nhận hàng nhưng vẫn ngừng bán.
Snapshot nháp làm mới tại ghi sổ, snapshot POSTED không bị đổi khi catalog đổi tên/giá.

Ngày API YYYY-MM-DD hợp lệ theo Việt Nam, từ đầu fromDate đến trước đầu ngày sau toDate.
Mặc định toDate hôm nay, fromDate lùi 29 ngày; khoảng gồm cả hai đầu tối đa 366 ngày.
DB Date UTC; API ISO 8601; UI Asia/Ho_Chi_Minh. Trang mặc định 1/20, limit ≤100, rỗng totalPages 0.

## MongoDB và S05-I01

| Collection | Trường và constraint chính |
| --- | --- |
| stock_documents | `_id=id`; code RCV-ObjectId hex24 unique; RECEIPT/ISSUE/ADJUSTMENT; DRAFT/POSTED; reason/source_reference; version Int32; total_cost Decimal128; actor/time server |
| stock_document_items | `_id=id`; document_id/product_id unique; quantity_delta Int32; unit_cost/line_total_cost Decimal128; sku_snapshot/name_snapshot |
| inventory (US-34) | product_id unique; on_hand/reserved/version Int32; guard_revision Int64; updated_at; 0≤reserved≤on_hand≤2147483647 |
| stock_movements | event_key unique RECEIPT_POST:documentItemId; unique(product_id,sequence); sequence=version mới; deltas/before/after; kind/source_id/document_item_id/actor_id; snapshot/Date server |
| stock_document_events | CREATED/UPDATED/POSTED; before/after allowlist; actor/time; request_key unique; unique partial(document_id,action) khi POSTED |
| operation_requests (EN-02) | Ba operation STOCK_RECEIPT_*; kết quả và business writes cùng commit; không TTL |

StockModule quản lý phiếu; InventoryModule export InventoryWriter cho writer kho tiếp theo.
Writer không upsert inventory khi post. Inventory thiếu, BSON sai kiểu, reserved bất thường trả
409 INVENTORY_INTEGRITY_ERROR; trần tồn/sequence trả 409 STOCK_LIMIT_EXCEEDED.
Writer lấy guard theo productId tăng, kiểm tất cả balances trước cập nhật, ghi có điều kiện và một movement/mỗi lần version tăng.
US-37 bổ sung kiểm chuỗi ledger từ 0 và tham chiếu nguồn sau khóa: tồn cũ thiếu ledger hoặc chain sai chặn writer,
không tự công nhận tồn cũ làm mốc mở đầu. Chạy `npm run reconcile:inventory` để đối chiếu chỉ đọc.
Movement nhập mới giữ source_type STOCK_RECEIPT/source_code tại ghi sổ; tham chiếu document_item_id vẫn bắt buộc.
Guard tăng không tăng sequence. Tạo/sửa nháp không đổi on_hand/reserved/version và không tạo movement.

UnitOfWork EN-02: catalog_state tăng revision thật → đọc catalog/phiếu/dòng → inventory.guard_revision theo id tăng
→ CAS document version → snapshots/balances/movements/audit/operation → commit.
Sửa nháp khóa union SKU cũ/mới trước CAS. Tạo nháp chỉ khóa catalog.
POSTED với key mới chỉ cần catalog và operation record, không ghi lại kho.
Không Promise.all/nested transaction trong session hoặc side effect ngoài DB trước commit.
Snapshot/majority/primary và retry deadline 10 giây dùng TransactionRunner hiện có.

## Vận hành và kiểm tra

Trước mở writer trên DB hiện có: dừng catalog/stock/cart writers, đối chiếu dữ liệu cũ,
chạy `npm run ensure-indexes` và `npm run seed:access` trong backend, rồi mở lại writers.
Lệnh indexes thêm constraint stock, không rewrite phiếu hoặc tạo ledger/receipt giả cho tồn cũ.
Duplicate index/data phải được đối chiếu; không tự xóa lịch sử để mở ghi.
Catalog migration US-34 quản lý BSON/version/guard của inventory; không reset tồn.
Command kiểm index stock/inventory/operation; thiếu hoặc TTL không hợp lệ trả 503 STOCK_NOT_READY.
MongoDB phải là replica set; không fallback nhiều lệnh ghi rời.

UI `/staff/stock-receipts`, `/admin/stock-receipts`: tạo nháp → chọn SKU thực nhận → lưu nhận tổng server
→ đối chiếu → Ghi sổ → xác nhận → POSTED cùng movement/source/sequence/before/after.
Chỉnh sửa chưa lưu chặn Ghi sổ. Đóng form chỉ bỏ chỉnh sửa chưa lưu.
Pending/unknown khóa form; giữ key/payload để lookup/replay, không tạo ý định mới khi chưa resolve.

AC01–03, TC01–15: `backend/test/stock-receipts.integration-spec.ts`.
TC16 và UI/recovery/routing: `frontend/src/features/stock/stock-receipts.test.tsx`.
Integration dùng MongoMemoryReplSet 8.0.17, Supertest, hai Nest app và hai tiến trình Node thật qua
test harness scripts/en05-app.cjs. Build backend trước vì process dùng dist.
Fixture DB tạm gym_test_us36 của riêng replica set test, không dùng dữ liệu vận hành.

```powershell
cd backend
npm run build
npm run typecheck:test
npm run test:integration -- --runTestsByPath test/stock-receipts.integration-spec.ts test/retail-catalog.integration-spec.ts test/idempotency.integration-spec.ts
cd ../frontend
npm run build
npm test -- src/features/stock/stock-receipts.test.tsx src/features/retail/retail.test.tsx
```

Không thay đổi requirement DOCX hoặc trạng thái Done trong PM. Chưa tạo commit/deploy.
