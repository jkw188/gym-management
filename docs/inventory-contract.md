# US-37 — UC-27: tra cứu tồn kho và lịch sử biến động

Phần mở rộng S07 US-38: picker hợp thêm `stockIssues.manage` (ADMIN), không trả cost hay mở quyền nhập.
ISSUE_POST kiểm nguồn `document_item_id → ISSUE POSTED`, delta âm/reservedDelta 0,
snapshot/event key khi đối chiếu ledger. History cấp sourcePath `/stock-issues/:id` có căn cứ;
UI chỉ Admin điều hướng về phiếu xuất. Chi tiết: `stock-issues-contract.md`.
Các mô tả writer/nguồn tương lai trong baseline bên dưới cần hiểu cùng phần mở rộng này.

Nguồn: `docs/PM/SPRINT5/[GM]Requirement_US-37.docx` phiên bản 1.0.
Giữ nguyên mã F01–05, I01, AC01–03 và TC01–14 trong requirement.
Hợp đồng này mô tả API, use case, MongoDB và tích hợp thực tế; không thay đổi trạng thái Done trong PM.

## UC-27 và API chỉ đọc

Staff/Admin mở `/staff/inventory` hoặc `/admin/inventory`, tìm SKU/tên, lọc danh mục,
trạng thái sản phẩm hoặc tình trạng tồn, xem số dư hiện tại rồi mở sổ theo kỳ.
Chi tiết biến động hiển thị snapshot sản phẩm, sequence, delta và before/after thực tế/giữ;
liên kết nguồn chỉ mở loại nguồn được allowlist. Không có nút/API sửa số dư.
UI tải lại khi người dùng bấm tải lại hoặc quay lại tab sau nhập kho.

| Endpoint | Query và kết quả |
| --- | --- |
| GET `/api/inventory` | `q?,categoryId?,productStatus? ACTIVE/INACTIVE,stockState? IN_STOCK/OUT_OF_STOCK/ERROR,page?,limit?`; page + asOf |
| GET `/api/inventory/:productId` | Identity, categoryId, productStatus raw, effectiveActive, inventoryState, onHand/reserved/available/version/asOf |
| GET `/api/inventory/:productId/movements` | `fromDate?,toDate?,kind?,page?,limit?`; page + range `{fromDate,toDate,timeZone}` + asOf |
| GET `/api/stock-movements/:id` | Allowlist của một movement, không có giá nhập hoặc chứng từ tài chính |
| GET `/api/inventory/product-options` | Picker US-36: `q?,categoryId?,page?,limit?`; identity/status/effectiveActive/inventoryState, không balances/cost/price |

List trả `{items,page,limit,total,totalPages}`; mặc định trang 1, limit 20, tối đa 100,
rỗng totalPages=0. Sản phẩm sắp name ASC rồi id ASC. q trim tối đa 120 ký tự, regex literal đã escape.
Không tự bỏ filter sai; unknown query fields trả 400 qua ValidationPipe hiện có.
Movement kind nhận mã chữ hoa/số/gạch dưới tối đa 60 ký tự; mã chưa phát sinh trả danh sách rỗng,
không tự giả lập nghiệp vụ S06/S07. Movement sắp sequence ASC kể cả khi lọc kỳ và phân trang.
Product/movement không tồn tại trả 404; ObjectId sai trả 400. GET không upsert/repair/khóa ghi.

Mỗi response chạy trong một `TransactionRunner` snapshot/primary/majority, các truy vấn dùng cùng session,
thực hiện tuần tự. List dùng aggregate lookup + facet để count và items cùng predicate.
`asOf` là thời gian server của lần đọc; version là phiên bản số dư trong snapshot, không phải guard_revision.
Các response độc lập có thể khác snapshot/asOf. MongoDB phải hỗ trợ transaction.

## Số dư, kỳ và quyền nguồn

- `available=onHand-reserved`, chỉ khi 0≤reserved≤onHand≤2147483647 và version hợp lệ.
  reserved đọc từ inventory thật, không lấy cart và không hardcode 0.
- ACTIVE/INACTIVE và category ngừng bán đều được tra nội bộ. effectiveActive chỉ true khi
  sản phẩm và danh mục đều ACTIVE; ngừng bán không đồng nghĩa hết tồn.
- Thiếu inventory: `MISSING`, tất cả số dư/version null. Số dư sai: `INCONSISTENT`, available null;
  các giá trị số hữu hạn gốc được giữ để đối chiếu, dữ liệu không phải số trả null.
- ERROR chỉ MISSING/INCONSISTENT. IN_STOCK/OUT_OF_STOCK chỉ dữ liệu hợp lệ và available >0/=0.
- Kỳ mặc định đến hôm nay theo Việt Nam, từ ngày lùi 29 ngày; tối đa 366 ngày gồm hai đầu.
  Ngày YYYY-MM-DD phải tồn tại. Query dùng `[00:00 fromDate +07:00,00:00 sau toDate +07:00)`.
  DB Date UTC, API ISO 8601, UI Asia/Ho_Chi_Minh. Không gọi số dư hiện tại là tồn cuối kỳ.
- Before/after lấy nguyên snapshot từng movement, không cộng delta riêng trang hoặc reset trang 2 về 0.
  Không có movement thì list rỗng; tồn 0 không cần movement mở đầu.

Backend giữ fixed RBAC của repository: `inventory.read` và `stockReceipts.manage` là hai policy độc lập
trong `ACCESS_POLICY`, baseline hiện đều STAFF/ADMIN; không thêm cơ chế tùy chỉnh role/mapping qua HTTP.
Các endpoint kho dùng `FixedPermission('inventory.read')`; picker dùng hợp hai policy.
Endpoint nguồn vẫn dùng `FixedPermission('stockReceipts.manage')`. Thu hồi phiên/đổi vai trò được JWT
strategy kiểm theo DB hiện hành. Seed mapping là catalog giải thích fixed RBAC, không phải grant động.
Test TC08 cấu hình riêng quyền phiếu chỉ ADMIN qua metadata policy của fixture, giữ nguyên Guard/JWT thật.

Movement DTO chỉ gồm id/productId/sequence/kind, snapshot SKU/tên, deltas/before/after,
createdAt/asOf và sourceType/sourceId/sourceCode/sourcePath. Không có unitCost/totalCost/price,
guard_revision, event_key hay actor. RECEIPT_POST phải tham chiếu đúng document_item_id→phiếu RECEIPT POSTED
mới cấp sourcePath `/stock-receipts/<ObjectId>`. Đây là đường dẫn API nội bộ, không phải URL ngoài.
UI kiểm lại đúng pattern/type/id, chuyển sang `/<role>/stock-receipts?documentId=...`; mở phiếu gọi API nguồn
và hiển thị lỗi nếu 403. Nguồn tương lai chưa triển khai chỉ có metadata và sourcePath null.

## S05-I01 do US-37 sở hữu

InventoryWriter là đường ghi dùng chung cho US-36 và các writer S06/S07 sau này:

1. Trong transaction, khóa inventory bằng cách tăng guard_revision Int64 thật, productId tăng dần.
2. Đọc và kiểm bất biến số dư, chuỗi ledger từ 0, sequence liên tục và nguồn receipt hợp lệ.
   Tồn cũ khác 0 thiếu ledger, mất event, nguồn sai hoặc chain đứt trả 409 INVENTORY_INTEGRITY_ERROR.
3. Kiểm delta/after và trần Int32 trước CAS phiếu; lấy đủ khóa kho trước CAS document version.
4. apply chỉ nhận balance do chính writer khóa trong session đó và đúng productId.
   Conditional update on_hand/reserved/version, version +1/movement; insert cùng session.
5. Movement có unique event_key và unique(product_id,sequence), sequence bằng version mới.
   No-op bị từ chối, không tăng sequence; guard lock không tăng version. Tràn trả STOCK_LIMIT_EXCEEDED.
   Lỗi movement/audit/operation rollback cả số dư, version, guard và phiếu.

Thứ tự khóa mở rộng EN-02 khi cần: security_state → plans → catalog_state → schedule_guards
→ members theo id → cart_states theo memberId → inventory theo productId → transactions
→ stock_documents theo id → notification_counters. Chỉ lấy khóa liên quan, không quay lại khóa trước,
không Promise.all/nested transaction trong session. Luồng US-36 lấy catalog → inventory → CAS phiếu.

| Collection | Ràng buộc/metadata |
| --- | --- |
| inventory | unique product_id; on_hand/reserved/version Int32; guard_revision Int64; updated_at; available không lưu |
| stock_movements | unique event_key; unique(product_id,sequence); index(product_id,created_at,sequence), document_item_id, order_item_id, return_item_id |
| stock_movements nguồn | document_item_id/order_item_id/return_item_id giữ tham chiếu nghiệp vụ; source_id/type/code là metadata điều hướng |

US-36 giờ ghi thêm source_type=`STOCK_RECEIPT`, source_code=code phiếu tại phát sinh.
Hai field tùy chọn để tương thích movement đã có; đọc receipt cũ lấy code từ nguồn POSTED trong cùng snapshot.
Không rewrite SKU/tên/cost/snapshot lịch sử và không backfill receipt giả.
Schema/index nền tảng đã có từ US-36; US-37 tái sử dụng, không thêm index trùng.

Kiểm ledger trước ghi hiện duyệt toàn chuỗi của SKU để đảm bảo dữ liệu cũ được đối chiếu.
Đây là lựa chọn phù hợp quy mô dự án; khi ledger lớn cần thiết kế checkpoint có căn cứ và test riêng,
không bỏ kiểm integrity hoặc tự công nhận một số dư cũ làm mốc mở đầu.

## Đối chiếu và vận hành

Trong backend: `npm run reconcile:inventory` (build rồi chạy CLI chỉ đọc).
Chỉ cần MONGODB_URI/MONGODB_DB cấu hình như hiện có; autoIndex/autoCreate tắt.
Lệnh đọc cùng snapshot, kiểm từng sản phẩm, inventory thiếu/trùng/mồ côi, ledger mồ côi,
chain sequence=1..version, before đầu 0, delta/số dư trung gian, after cuối và nguồn nhập.
In `{checked,consistent,issues:[{productId,codes}]}` không cost/credential; exit 1 nếu có sai lệch.
Không tự sửa dữ liệu/index hoặc tạo mốc mở đầu. Người vận hành phải đối chiếu nguồn thật và chuẩn bị
backfill có bằng chứng trong đợt bảo trì trước mở lại writer. Không có công cụ auto-backfill trong US-37.

Trước triển khai DB hiện có: dừng writer liên quan, chạy `ensure-indexes`, `seed:access`,
`reconcile:inventory`, xử lý sai lệch có căn cứ, rồi mở lại writer. Không reset balances để qua đối chiếu.
Không có env hoặc dependency mới, không triển khai nghiệp vụ giữ/bàn giao/hủy đơn của S06.

## Truy vết kiểm thử

| Requirement / TC | Bằng chứng source |
| --- | --- |
| F01/F02, TC01–04/10 | inventory.integration-spec: reserved thật/cart không tác động, inactive, quyền/phiên cũ, null và dữ liệu lỗi |
| F03/I01, TC05–08/12–13 | inventory.integration-spec và stock-receipts.integration-spec: receipt thật, snapshot, nguồn/cost, race, fixture reserve/handover/cancel, rollback, legacy ledger |
| F04, TC09/11 | inventory.integration-spec: mốc UTC/ngày VN, trang 2, kỳ mặc định, commit chen giữa count/items vẫn cùng snapshot |
| F05, TC08/14 | inventory.integration-spec và inventory.test.tsx: allowlist không cost/URL ngoài, endpoint nguồn kiểm quyền riêng, route tĩnh picker |
| UI, TC14 | inventory.test.tsx và stock-receipts.test.tsx: pending/empty/error/retry, số dư null, source navigation, route/returnTo và reload |

```powershell
cd backend
npm run typecheck
npm run typecheck:test
npm run build
npm run test:integration -- --runTestsByPath test/inventory.integration-spec.ts test/stock-receipts.integration-spec.ts test/retail-catalog.integration-spec.ts
cd ../frontend
npm run build
npm test -- src/features/inventory/inventory.test.tsx src/features/stock/stock-receipts.test.tsx src/features/retail/retail.test.tsx
```

Integration dùng mongod thật 8.0.17 replica set tạm riêng `gym_test_us37` và Supertest;
suite nhập kho còn kiểm hai tiến trình Node thật nên cần build backend trước.
Frontend jsdom là kiểm tự động, vẫn cần nghiệm thu browser/DB triển khai thực tế.
Chưa tự commit/push/deploy, chưa có bằng chứng CI hay commit sạch để đánh dấu Done trong PM.
