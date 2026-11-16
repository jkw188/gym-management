# EN-06: kiểm thử đồng thời đơn hàng và tồn kho

Nguồn: `docs/PM/SPRINT6/[GM]Requirement_EN-06.docx` v1.0.
Đã đọc văn bản và toàn bộ bảng của EN-06; DOCX này không có ảnh nhúng.
Giữ nguyên mã TC01–20 và AC01–04. **Chưa đủ điều kiện Done/nghiệm thu S06.**

## Phạm vi source hiện tại

US-43 đã bổ sung schema orders/items/events, Staff query và prepare writer,
UI cùng suite `order-prepare.integration-spec.ts`; xem `orders-prepare-contract.md`.
Chưa có cart/quote/Order Factory/fulfill/cancel/expiry/late-receipt/refund writer
của US40–45/53. `SettlementService.confirm` và payment
preview hiện từ chối RETAIL. Không tạo writer thay thế, mock DB, API người dùng,
quyền, UI hoặc endpoint payout S07 để làm bộ test xanh.

EN-06 bổ sung harness có thể chạy trên nền tảng đã có, cùng oracle và cổng
nghiệm thu đóng khi thiếu bằng chứng. Test nền tảng GYM/PT/nhập kho chỉ là
**PARTIAL**, không chứng minh rằng luồng RETAIL chưa tồn tại đã an toàn.

## Chạy và bằng chứng

Sau `npm ci` trong `backend`:

```powershell
cd backend
npm run typecheck:test
npm run test:unit
npm run test:en06:foundation
npm run test:en06
```

- Hai lệnh cuối đều build source trước khi fork hai Node process bootstrap
  AppModule/config HTTP/JWT/session/Guard thật. Cùng DB, connection độc lập,
  hai PID khác parent. Không mutex nghiệp vụ trong process.
- Runner mặc định tạo MongoDB **mongod thật**, replica set WiredTiger 8.0.17
  bằng dependency `mongodb-memory-server` hiện có; đây không phải DB mock.
  Lần đầu cần binary MongoDB, có thể đặt `MONGOMS_DOWNLOAD_DIR` vào cache.
- URI ngoài chỉ nhận `MONGODB_TEST_URI` có DB gốc `gym_test_*` tối đa 24 ký tự,
  khác DB phát triển và phải hỗ trợ transaction. Không load `.env` cá nhân.
  Namespace có runId/suite/worker, ownership marker ngẫu nhiên; cleanup kiểm
  đúng tên và marker qua `test-database.cjs` trước khi drop DB được thuê.
- `test:en06:foundation` chỉ trả 0 khi cả chín nhóm nền tảng chạy đủ 10 vòng,
  DB oracle đạt, request outcomes đã resolve và 11 dependency thiếu đúng danh
  sách công bố. Assertion lỗi/thiếu vòng/một app/unknown đều làm lệnh thất bại.
- `test:en06` là cổng nghiệm thu: trả 1 khi còn PARTIAL/BLOCKED/NOT_RUN/FAILED,
  thiếu hai expiry worker hoặc thiếu bằng chứng. Hiện tại kết quả đúng là
  `NOT_ACCEPTED` ngay cả khi foundation đã xanh. Không có tùy chọn giảm số vòng.
- Mỗi run lưu `artifacts/en06-<runId>/environment.json`, `processes-indexes.json`,
  `cases.json`, `jest.json`, `summary.json`, `report.md`. Có commit, dirty flag,
  SHA256 source/harness/lockfile, Node/MongoDB, clock, fixture runId, PID,
  request status/resolution, DB before/after/checkpoints, số vòng và owner
  theo user story để triage. Không ghi token, secret, URI credential, contact
  hoặc bank reference vào evidence; response/payload nhạy cảm chỉ lưu hash.

CI riêng `.github/workflows/en06.yml` chạy foundation trên PR/push và luôn
upload evidence. Workflow dispatch mặc định `full_acceptance=true` để chạy cổng
nghiệm thu đầy đủ. Foundation xanh không thay thế cổng này hoặc EN-04; trước
Done S06 bắt buộc chạy toàn bộ TC01–20 cùng EN-04 và hồi quy GYM/PT.
Workflow chỉ được thêm vào source, không có nghĩa đã chạy CI từ xa hoặc đã
được cấu hình branch protection.

## Harness, fault và oracle

- Clock dùng `ServerClock` hiện có (vai trò ClockProvider), override qua Nest
  DI chỉ ở child test. Mốc `2035-11-14T17:00:00.000Z` là 00:00 ngày 15/11 VN;
  IPC hỗ trợ đổi clock không mở HTTP hook. Suite US-43 riêng kiểm prepare tại
  deadline−1 ms/đúng deadline/+1 ms bằng snapshot fixture. TC13 toàn EN-06 giữ
  BLOCKED vì chưa có create/normal RETAIL payment/fulfill để nghiệm thu liên thông.
- Client barrier phát tối đa 20 request/batch, chia đều hai process ở các
  batch tranh chấp. IPC pause trước `DataGuardsService.acquire` giúp hai process
  đến điểm khóa thật; đảo thứ tự gửi qua từng vòng nhưng giữ thứ tự kết quả
  tương ứng input. Fixture catalog/member/link/plan/receipt/sale dùng API thật;
  chỉ bootstrap account và singleton quản trị test qua repository/model thật.
- Throw test-only **sau** ghi movement, stock audit, payment, invoice, settle,
  recipient, outbox và operation record, trước commit; so sánh DB hash toàn
  collection trước/sau abort. Mất response được thực hiện ở `response.end`
  sau commit bằng hủy socket, không rollback commit đã thành công.
- Resolver đợi batch `allSettled`, lookup từ app còn lại, replay cùng payload,
  actor, operation/key tối đa ba lần nếu transport mất/503 outcome unknown.
  Lookup404 không được coi là thất bại đã biết. Còn unknown thì fail.
- Child kiểm schema/index thật, financial integrity và catalog migration;
  index S06 chưa tồn tại vẫn được ghi là thiếu. Không tự tạo index giả của
  orders/refunds để qua kiểm tra. Hook không import vào production main.
- Oracle đọc tuần tự trong transaction snapshot/majority từ primary: ledger
  sequence liên tục, delta/before/after/số dư cuối, không cộng DRAFT; reserved
  bằng tổng item của HELD; movement/source và terminal effect; payment/reference,
  invoice, refund và notification orphan/unique; tiền dùng bigint VND nguyên.
  Gross tính mọi SUCCEEDED payment kể cả transaction CANCELLED; chỉ refund
  SUCCEEDED mới trừ cash. Đường oracle order/refund theo tên field requirement
  còn cần nối schema thật khi các story triển khai, chưa có DB fixture nghiệm
  thu cho các nhánh đó. Unit âm kiểm oracle không thay bằng chứng race DB thật.

## Ma trận còn thiếu

| TC | Kiểm tra đang thực thi | Phần ngăn nghiệm thu / owner |
| --- | --- | --- |
| TC01 | BLOCKED | Checkout 20 Member tranh SKU1 — US41 |
| TC02 | BLOCKED | WEBSITE/POS shared reservation — US41/53 |
| TC03 | BLOCKED | CartVersion dùng một lần — US40/41 |
| TC04 | PARTIAL: 20 receipt replay + mất response | Order/reserve/cart clear replay — US41/53 |
| TC05 | PARTIAL: key khác target/version | Quote/channel/checkout fingerprint — US41/53 |
| TC06 | BLOCKED | Quote/create cạnh tranh sửa catalog — US41 |
| TC07 | PARTIAL: POSTED hai phiếu + reader + ledger | Reservation S06 cạnh tranh nhập — US41/53 |
| TC08 | PARTIAL: 20 confirm GYM/PT tranh reference | RETAIL dispatch — US41 |
| TC09 | PARTIAL: 20 key confirm một transaction | RETAIL SETTLED giữ HELD/chưa giao — US41 |
| TC10 | BLOCKED | Cancel/normal payment/refund — US41/45 |
| TC11 | BLOCKED | Cancel/fulfill — US44/45 |
| TC12 | BLOCKED | Hai expiry worker thật, paid/unpaid — US45 |
| TC13 | BLOCKED: prepare kiểm riêng ở suite US43 | Create/payment/fulfill deadline ±1 ms còn thiếu — US41/44 |
| TC14 | BLOCKED | Expiry backlog/restart và cô lập lỗi — US45 |
| TC15 | BLOCKED | Late receipt/refund nghĩa vụ — US45 |
| TC16 | BLOCKED | Late amount/second payment/duplicate — US45 |
| TC17 | PARTIAL: GYM/PT invoice0 không payment0 | WEBSITE/POS miễn phí HELD — US41/53 |
| TC18 | PARTIAL: fault writer kho/thu hiện có + transport loss | Order/item/cart/refund fault — US41/45/53 |
| TC19 | PARTIAL: Guard/IDOR/own invoice/REST offline/hai outbox worker | Retail own/link/auth/socket duplicates — US42/45 |
| TC20 | PARTIAL: GYM/PT terms/invoice buyer snapshot | Retail snapshot/POS không đổi cart — US40/41/53 |

Outbox worker hiện có không thay cho expiry worker. Không fixture trạng thái
refund SUCCEEDED để giả đã thực chi, không thêm API hoàn tiền. Khi owner story
bổ sung writer thật: nối API/fixture/hook tại điểm ghi của writer, thêm race và
DB oracle tương ứng, chạy đủ 10 vòng rồi mới bỏ trạng thái incomplete. Không
đổi label thành PASSED hoặc bỏ assert để vượt gate. Dùng report thực tế để gắn
runId/commit vào Tasks/NhatKy; không sửa tracker Done tự động.
