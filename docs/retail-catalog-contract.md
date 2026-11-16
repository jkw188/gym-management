# US-34 / UC-35: danh mục và sản phẩm bán lẻ

Nguồn: `docs/PM/SPRINT5/[GM]Requirement_US-34.docx` phiên bản 1.0.
UC-35 (Bảng 3.2.35) ánh xạ tới hai màn hình `/admin/categories`, `/admin/products`;
ADMIN xem danh sách/chi tiết → tạo/sửa → xem trước → xác nhận → tải lại.
Không DELETE, sửa SKU, nhập tồn hay giá vốn trong catalog. Không thay trạng thái Done trong kế hoạch.

## Quyền và API

`categories.manage`, `products.manage` chỉ ADMIN, dùng cùng `ACCESS_POLICY` cho Guard và seed.
JWT/session/role hiện hành được kiểm cả ở mutation, replay và `/api/operations/:operation/:key`.

| Endpoint dưới `/api/admin` | Input / kết quả |
| --- | --- |
| GET `/categories` | q?, status?, page=1, limit=20 (tối đa100); gồm cả INACTIVE |
| GET `/categories/:id` | id, name, status, version, affectedActiveProductCount, createdAt, updatedAt |
| POST `/categories` | name, status; CATEGORY_CREATE; 201 version0 |
| PATCH `/categories/:id` | version, name?, status?; CATEGORY_UPDATE; 200 version+1 |
| GET `/products` | q?, categoryId?, raw status?, page?, limit? |
| GET `/products/:id` | id, categoryId/name/status, sku, name, description/imageUrl nullable, price, status, effectiveActive, version, timestamps |
| POST `/products` | categoryId, sku, name, price, status, description?, imageUrl?; PRODUCT_CREATE; 201 |
| PATCH `/products/:id` | version và ít nhất một field trong categoryId/name/price/status/description/imageUrl; PRODUCT_UPDATE; 200 |

List trả `{items,page,limit,total,totalPages}`; rỗng totalPages=0. Sort name ASC, _id ASC bằng simple collation;
q trim, tìm literal không phân biệt hoa/thường, tối đa120 ký tự. Không tự bỏ filter sai hoặc query lạ.
Không trả creator, name_key, guard revision, số dư hoặc cost trong DTO/replay.

400 VALIDATION_ERROR cho field lạ/null sai/giá sai/URL sai/SKU sai; 404 NOT_FOUND cho id không tồn tại;
409 CATEGORY_NAME_EXISTS, SKU_EXISTS, CATEGORY_NOT_ACTIVE, VERSION_CONFLICT hoặc IDEMPOTENCY_CONFLICT.
503 CATALOG_NOT_READY khi thiếu singleton/index hoặc có TTL ngoài hợp đồng; lỗi theo EN01-D03.

## Schema mục 4.2 và quy tắc dùng chung

| Collection | Bổ sung / ràng buộc |
| --- | --- |
| categories | `_id=id`, name NFC(trim), name_key lowercase có dấu, unique simple kể cả INACTIVE; status; version BSON Int32; timestamps/actor |
| products | `_id=id`, category_id tồn tại; sku trim+uppercase ASCII, unique simple và bất biến; name trim; description≤2000; image_url≤500; price Decimal128; status/version/timestamps/actor |
| inventory | Một product_id unique; on_hand/reserved/version Int32 bằng0, guard_revision Int64 bằng0, updated_at khi tạo product. Không movement khởi tạo |
| catalog_events | entity_type/id, actor_id, action CREATED/UPDATED/ACTIVATED/DEACTIVATED, before/after DTO allowlist, occurred_at, request_key SHA256 unique |
| catalog_state | Singleton `_id:"retail",revision:Int64≥0`, chỉ nội bộ; migration khởi tạo trước nhận ghi |
| operation_requests | Thêm CATEGORY_CREATE/UPDATE, PRODUCT_CREATE/UPDATE; unique actor+operation+key, không TTL |

`effectiveActive = product.status === ACTIVE && category.status === ACTIVE`.
Ngừng/bật category giữ nguyên trạng thái từng SKU. Form lấy lại affectedActiveProductCount trước xác nhận đổi trạng thái category;
đây là preview tại thời điểm đọc, server vẫn kiểm version/trạng thái trong transaction.
Nội dung/giá của product ACTIVE trong category INACTIVE vẫn sửa được; tạo/kích hoạt hoặc chuyển product ACTIVE cần category đích ACTIVE.
Ngừng product không đụng reserved, đơn hàng, giỏ hoặc snapshot tài chính đã có.

Tiền API là chuỗi nguyên0–999999999999, normalize bỏ số0 đầu; không JSON float/exponent/phần lẻ.
PATCH bỏ field giữ nguyên, chỉ description/imageUrl được null/rỗng để xóa; POST rỗng lưu vắng.
Hiện chưa có route upload ảnh nội bộ được cho phép: chỉ nhận HTTPS không credential/whitespace/backslash;
backend không tải URL. Ảnh404 dùng placeholder; mô tả render React text.

## S05-C01 và EN-02

Mọi create/update catalog qua IdempotencyService, TransactionRunner, cùng một session:
đọc kết quả key → tăng thật catalog_state.revision → đọc category/product → CAS version hoặc insert →
inventory0 nếu tạo product → audit → operation_requests → commit majority.
Không nested transaction, Promise.all trong session hoặc side effect ngoài DB trong callback.
Hash bao gồm DTO chuẩn hóa, version và targetId. Request cùng key/payload replay đúng HTTP/body gốc;
payload khác409. 503/đứt mạng giữ key, tra cứu hoặc gửi lại; 404 OPERATION_UNKNOWN không chứng minh thất bại.

Thứ tự chung: security_state → plans → catalog_state → schedule_guards → members theo id →
cart_states theo memberId → inventory theo productId → transactions → stock_documents theo id → notification_counters.
Chỉ lấy khóa liên quan; read-only không lấy khóa. Writer US-36/40 tương lai phải lấy catalog trước kiểm quan hệ/trạng thái/giá.
US-37 sở hữu S05-I01: writer kho tăng inventory.guard_revision theo productId tăng dần trước đọc số dư.
S06 checkout/POS lấy cùng catalog lock trước snapshot giá; đơn đã có dùng snapshot.

US-35 và US-40 chưa có triển khai trong repository ở lần tích hợp US-34 này.
Khi bổ sung: public list/detail dùng cùng predicate effectiveActive; giỏ đọc giá hiện tại từ products, không freeze giá;
không công bố rằng đã kiểm thử end-to-end các API phụ thuộc chưa tồn tại.

## Migration và vận hành

Backup, dừng writer catalog/kho/giỏ, chạy `npm run ensure-indexes`, rồi `npm run seed:access` tại backend.
Migration preflight toàn bộ category/product/inventory trước backfill: trùng tên sau NFC/lowercase,
SKU sau uppercase, category mồ côi, inventory trùng/thiếu/mồ côi/số dư sai, version/revision, audit actor/timestamp thiếu đều bị chặn.
Không gộp/xóa SKU hoặc tự suy ra creator/timestamps. Product thiếu inventory phải đối chiếu rồi backfill riêng có căn cứ;
không tự tạo0 khi chưa chứng minh lịch sử. Số dư/reserved/guard revision đã có được giữ nguyên.
Startup cũng chạy preflight read-only; không mở app trên dữ liệu không hợp lệ.
Writer kiểm index và singleton trước ghi; singleton chỉ tạo sau preflight/backfill/index thành công.
Không thêm env/dependency, không chạy migration vào DB cá nhân trong kiểm thử.

## Kiểm thử và giới hạn bằng chứng

- Backend: `npm run test:integration -- --runTestsByPath test/retail-catalog.integration-spec.ts`.
  MongoDB8.0.17 replica set thật, hai Nest app/connection cùng DB; JWT/session/Guard thật.
  TC01–06/08–11: normalization, quyền, DTO, trạng thái, unique index, CAS/race/replay, rollback inventory/audit và revision.
  TC07: kiểm giá hiện tại catalog và fixture snapshot đơn không bị đổi; chưa có API giỏ US-40.
  TC12: inject lỗi trả503 sau commit, lookup/replay đúng IDs; không giả lập mất TCP trên hosting.
  TC13/14: URL, projection, migration, dữ liệu thiếu và khóa/index chưa sẵn sàng.
- Frontend: `npm test -- --pool=threads --maxWorkers=1 src/features/retail/retail.test.tsx` (HTTP giả lập/jsdom): preview ảnh hưởng,
  SKU readonly, không field tồn/cost, stale giữ input, unknown giữ key qua lookup404, list loading/empty/error,
  ảnh lỗi/markup text và route chặn role khác.
- Kiểm thủ công browser: đăng nhập ADMIN, tạo category và SKU giá0/5000, xác nhận preview;
  ngừng category xem số SKU, raw ACTIVE nhưng hiệu lực ẩn, bật lại; hai tab sửa cùng version;
  thử URL ảnh404 và tắt mạng khi lưu rồi tra cứu/gửi lại cùng key.
- Build/typecheck và các suite hồi quy không thay thế nghiệm thu public/cart/POS chưa triển khai;
  không gắn bằng chứng vào commit vì chưa được yêu cầu commit.

## Tích hợp US-36

Phiếu nhập dùng cùng S05-C01, không đổi giá bán/trạng thái catalog.
InventoryWriter và UC-25 được mô tả trong [stock-receipts-contract.md](stock-receipts-contract.md).
US-36 bổ sung picker nội bộ theo US-37 cho Staff/Admin; không dùng endpoint public hoặc cấp quyền products.manage cho Staff.
