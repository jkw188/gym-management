# EN-08 — hồi quy và đối chiếu cốt lõi S01–S08

Nguồn: `[GM]Requirement_EN-08.docx` v1.0, F01–05, X01–02, O01–05, AC01–04, TC01–20, E01–03. Liên quan EN-04/05/06/07, UC-38, S08-M01/C01/P01 do US-50/51/52 sở hữu. [Sequence thực tế](en08-sequence.mmd).

**Trạng thái: có harness và oracle tham chiếu; chưa nghiệm thu EN-08.** US50/51/52 đã có API/UI báo cáo và suite tích hợp riêng; chưa chạy lại toàn gate trên candidate mới, chưa có UAT HTTPS EN-07; WEBSITE cart/checkout và self-service upgrade còn thiếu. Không tạo API hoặc ghi báo cáo giả để vượt gate. QR/Workout/giao vận S09–S11 deferred, không nằm trong gate cốt lõi.

## Chạy lại

Từ checkout cùng mã nguồn, dùng Node **24.13.0**, npm **11.11.1** và hai lockfile. Cài `npm ci` tại backend và frontend trước lần đầu. Từ gốc repository:

```powershell
node scripts/en08.cjs
```

Hoặc tại backend: `npm run test:en08`. Không có cờ bỏ qua test, giảm vòng hay biến BLOCKED thành PASS. Runner thực thi tuần tự, tiếp tục thu bằng chứng sau lỗi hồi quy:

1. EN-04: `npm ci`, typecheck source/test/frontend, build hai ứng dụng, toàn bộ unit/frontend/integration và E2E S01. Lint chỉ chạy nếu repository định nghĩa script lint; hiện chưa có.
2. `npm run test:en05` và `npm run test:en06` ở chế độ **nghiệm thu đầy đủ**, không dùng regression/foundation thay thế.
3. Jest `jest.en08.config.cjs`: S07 bổ sung trả hàng, payout và broadcast, hai Node child process/kết nối độc lập/chung DB, mỗi nhóm 10 vòng ×20 request. Chẵn cùng key, lẻ khác key hoặc confirm/fail. Return/payout dùng IPC pause trước guard; broadcast dùng client barrier. Mọi request settled rồi resolve bằng lookup/replay theo helper EN06. Không suy hiệu năng/tải từ số request.
4. Probe thật: tạo test tạm **trong thư mục artifacts**, lần lượt PASS, cố ý FAIL, cố ý SKIP. Chạy Jest thật, kiểm gate chỉ nhận PASS; không sửa source hoặc làm yếu test cũ. Probe FAIL cố ý có Jest exit1 nhưng kiểm chứng gate đạt khi nó bị từ chối. Không tính probe FAIL là lỗi sản phẩm.
5. Ghi 20 TC, AC, ma trận và các dependency còn thiếu. Exit **1 / NOT_ACCEPTED** khi chưa đủ bằng chứng. Exit0 của unit hoặc S07 riêng không phải EN08 Done.

Quality gate EN04 hỗ trợ `EN04_EVIDENCE_DIR` để mỗi EN08 run có thư mục riêng. EN08 gọi thêm `--continue-on-failure` để vẫn thu bằng chứng E2E khi integration lỗi; mọi lỗi vẫn giữ exit khác0 và trạng thái failed. Lệnh EN04 mặc định vẫn dừng khi lỗi. Integration toàn dự án được giới hạn 60 phút/bước, các bước khác 20 phút; timeout không được tính PASS. Không đổi API, schema, env runtime hay dependencies nghiệp vụ.

`scripts/quality-step.cjs` quản lý cả cây process npm/shell/Jest/Nest, trả exit124 khi timeout. Không chỉ dừng npm rồi để Jest tiếp tục ghi DB ở bước kế tiếp. Test OS thật `en08-process.spec.ts` kiểm một command cùng descendant đều đã dừng. Runner EN08 cũng dùng cleanup này khi timeout/dừng. Runtime/sandbox không cho dừng cây process phải ghi lỗi, không coi là cleanup thành công.

## Namespace và môi trường

Runner không load `.env` cá nhân; chỉ truyền allowlist môi trường hệ điều hành, cấu hình test sinh ngẫu nhiên và cache. URI ngoài chỉ dùng `MONGODB_TEST_URI`, được kiểm với cấu hình dev ban đầu trước khi loại biến dev khỏi child env. NODE_ENV khác test bị từ chối. Không ghi URI, token, mật khẩu hoặc bank reference vào JSON evidence.

AppModule và CLI `admin.cjs` cũng bỏ qua `.env` khi NODE_ENV=test; trước thay đổi này, ConfigModule có thể nạp thêm cấu hình cá nhân dù runner đã lọc env. Test `en08-environment.integration-spec.ts` khởi chạy server/CLI thật trong thư mục tạm có `.env` mồi, yêu cầu thiếu cấu hình test phải dừng trước kết nối DB. Dev/production giữ cách nạp cấu hình hiện hành; UAT tiếp tục dùng env tường minh.

Mặc định chạy `mongod` **thật**, replica set WiredTiger 8.0.17 bằng `mongodb-memory-server` hiện có, không DB mock. Lần đầu có thể cần binary MongoDB; cache qua `MONGOMS_DOWNLOAD_DIR`. S07 dùng lease EN04 `gym_test_<base>_<runId>_<worker>_<suite>`, kiểm prefix/ENV/owner marker trước reset/drop. Không có HTTP endpoint fault/clock; IPC hook chỉ trong executable test, production main không import. Hai process verify index từ schema thật trước mở listener; lưu PID/parent/index contract. Suite kế thừa một số story còn dùng tên DB cũ trên **replica set tạm riêng**; EN08 không đổi harness đó hoặc tuyên bố chúng dùng cùng leased DB. URI ngoài không biến các suite legacy này thành test trên cluster ngoài.

## Ma trận và bằng chứng

[scripts/en08-matrix.json](../scripts/en08-matrix.json) giữ **66 requirement, 237 AC**, mã AC nguyên văn (bao gồm AUTH-ACxx/USER-ACxx/EN01-ACxx), phạm vi TC, UC, API/UI trong requirement, source/suite ứng viên và SHA256 DOCX. Danh sách ứng viên được tìm từ mã truy vết; **không phải chứng nhận coverage**. Mỗi AC giữ NOT_RUN và NEEDS_AC_REVIEW/UNMAPPED tới khi kiểm từng assert và gắn evidence. Không lấy tỷ lệ task Done làm nghiệm thu. Tài liệu DOCX hiện bị Git ignore; người tái chạy cần bản gốc đúng hash. Snapshot ma trận trong run ghi rõ file thiếu hoặc hash khác, không khẳng định đã có requirement khi không có.

`artifacts/en08-<runId>/` gồm:

| File | Ý nghĩa |
| --- | --- |
| `summary.json`, `report.md` | Commit, dirty, fingerprint source đầu/cuối, runtime/platform/timezone, lock hashes, command/exit/timestamp từng bước, 20 TC, AC và phạm vi còn thiếu |
| `traceability.json`, `mandatory-suites.json` | Baseline/hash requirement và tập file test bắt buộc tại lúc chạy; thiếu file/suite hoặc TODO/SKIP đều không qua EN08 |
| `en04/*.json` | Kết quả static/build và tất cả suite EN04; giữ riêng theo run |
| `s07/environment.json`, `s07/processes-indexes.json` | Namespace, fixture/clock, MongoDB/replica/index thật và hai PID |
| `s07/s07-cases.json` | 10 vòng/nhóm, từng request/payload hash/key/PID/resolved outcome và DB trước/sau; extra source IDs/hash của return/attempt/broadcast |
| `gate-probe/*` | Source probe, kết quả Jest đã bỏ raw errors và kết quả gate PASS/FAIL/SKIP |

EN05/EN06 vẫn ghi thư mục `artifacts/en05-*`, `artifacts/en06-*`; summary EN08 liên kết **run mới tạo**, kiểm cùng commit. Giữ cả các thư mục này khi bàn giao. Không lấy kết quả run cũ hoặc JSON tự điền để hợp thức hóa release. Source dirty được fingerprint để tái hiện kiểm tra phát triển, nhưng không đáp ứng commit đóng băng. Không tự commit/push/deploy. Workflow EN08 chỉ `workflow_dispatch`, luôn upload evidence kể cả gate fail; chưa có nghĩa CI từ xa đã chạy.

## Oracle độc lập và UC-38

`backend/test/helpers/en08-report-oracle.cjs` chỉ đọc cấu trúc source fixture, không import ReportService, pipeline, helper tiền/ngày ứng dụng. `backend/test/fixtures/en08-reports.cjs` có ID prefix `test_`, không người/ngân hàng thật. Expected là literal tính tay từ requirement, không sinh bằng actual. Unit test oracle riêng chỉ xác minh **reference**. Suite `membership-reports.integration-spec.ts` của US50 ghi fixture 4 hồ sơ vào MongoDB replica set, gọi API bằng JWT ADMIN thật và đối chiếu oracle độc lập trên nguồn committed. Suite `cash-flow.integration-spec.ts` của US51 nạp fixture cash EN08 vào replica set, so API thật với cashOracle trên nguồn committed; kiểm khoản muộn, hoàn khác kỳ, phương thức chi độc lập, tổng vượt2^53, snapshot/getMore và chất lượng dữ liệu. Hợp đồng mới: [US51/UC38/S08-C01](cash-flow-contract.md). US52 đã có suite đối chiếu committed-source riêng; chưa chạy lại toàn runner EN08; TC07–12 trong bằng chứng EN08 cũ vẫn BLOCKED, không tự chuyển PASS.

| Hợp đồng | Source/field oracle | Expected chính |
| --- | --- | --- |
| S08-M01 / US50 | `members.created_at`, `memberships.service_sale_id/created_at/superseded_at`, `service_sales.member_id/start_date/end_date/transaction_id`, `transactions.kind/status/settled_at` | 4 hồ sơ, active2=50%, 3 membership; quota0/free/locked không đổi định nghĩa; lịch sử SUPERSEDED trước mốc vẫn tính; thiếu history trả null/partial |
| S08-C01 / US51 | `payments._id/status/paid_at/amount/method/transaction_id`, `refunds.status/refunded_at/payment_id/method/amount`, `transactions.kind` | 2 triệu thu −100k hoàn =1,9 triệu; nghĩa vụ hiện tại70k; late300k hoàn ngày04 không còn outstanding; bigint và số âm giữ chính xác |
| S08-P01 / US52 | `work_shifts.trainer_id/status/start_at/end_at`, `pt_bookings.shift_id/status/start_at/end_at`, `trainer_attendance.shift_id/check_in_at/check_out_at`, `trainer_reviews.created_at/rating` | 240/120 phút=50%, known140/actualTotal null, completedShift0; clip/union theo PT, weighted1/1+0/3=25%; review theo ngày gửi |

Oracle không mô phỏng toàn bộ filter/phân trang/daily groups/data-quality; các hành vi này được kiểm riêng trong suite của story. US52 đã có `trainer-performance.integration-spec.ts` đọc committed MongoDB rồi đối chiếu oracle độc lập với `items[].summary` và `totals`; xem [hợp đồng US52](trainer-performance-contract.md). Projection cash oracle dùng `grossReceipts/refundPaid/netCash` ở root; adapter lấy `response.totals` từ US51. `compareMetrics` giữ range/asOfAt/observedAt/source IDs, expected/actual và signed difference; không dùng comparator làm bằng chứng source committed khi fixture chưa được ghi. Các kết quả gate EN08 lịch sử vẫn giữ trạng thái cũ cho tới khi chạy lại gate đầy đủ.

S07 dùng thêm `backend/test/helpers/en08-source-oracle.ts` đọc snapshot MongoDB thật, kiểm lượng trả lũy kế, restock theo đúng return item, giá snapshot, một nghĩa vụ/phiếu, budget tính cả FAILED và payout≤payment. Unit âm kiểm oracle bắt duplicate movement, orphan, quá lượng/budget và hàng hỏng bị cộng kho. Điều này chứng minh nguồn S07 trong các batch đã chạy, vẫn không thay đối chiếu report API US50/51/52.

UC-38 API/UI do US50/51/52 sở hữu: `/api/reports/memberships/*`, `/api/reports/cash-flow/*`, `/api/reports/trainers/*`, React `/admin/reports/*`. US50 hiện có controller/DTO, quyền `reports.memberships.read`, projection nguồn cùng snapshot và React `/admin/reports/memberships`; tái sử dụng index nguồn. Xem [hợp đồng US50](membership-reports-contract.md) và [sequence](membership-reports-sequence.mmd). US51/52 đã có API/UI tương ứng, quyền `reports.cashFlow.read`/`reports.trainers.read` và suite committed-source riêng; xem [US51](cash-flow-contract.md), [US52](trainer-performance-contract.md) và [sequence US52](trainer-performance-sequence.mmd). Cần chạy lại gate trên candidate được review; GET snapshot đồng nhất, drill-down distinct, GET không side effect, UI trạng thái và kỳ tương ứng. Kết quả các suite story không tự thay trạng thái nghiệm thu EN08 toàn hệ thống.

## Triage và điều kiện mở gate

| Mã | Ảnh hưởng / tái hiện | Owner theo requirement | Trạng thái / retest commit |
| --- | --- | --- | --- |
| EN08-DEP-01 | US50/51/52 có API/UI và đối chiếu committed-source trong suite riêng. TC07–12 cần chạy lại gate đầy đủ trên candidate được review | US50/51/52 | BLOCKED ở gate EN08; chưa có retest commit |
| EN08-DEP-02 | Thiếu cart/WEBSITE checkout và self-service upgrade: EN05/06 full acceptance chưa đạt | US20/35/36/37/40/41 và liên quan | BLOCKED; xem summary EN05/06 cùng run |
| EN08-DEP-03 | Chưa có HTTPS UAT/restore/browser bốn role/restart thật: TC15/17/20 | EN07 + người vận hành được giao | BLOCKED; chưa có URL/retest commit |
| EN08-GAP-01 | S07 ISSUE/ADJUST, completion/review/reopen/reminder còn cần đủ hai process/10 vòng từng conflict; không coi hai app cùng PID là hai process | EN08 + story S07 | Chưa đủ; các suite hiện có vẫn chạy nguyên assert |
| EN08-GAP-02 | Ma trận cần review từng AC, fault inventory và negative permissions trên toàn bộ API/UI | EN08 + chủ story | Chưa được chấp nhận; không có reviewer/người xử lý được tự gán |
| EN08-FIX-01 | Suite migration US65 cũ tạo trainer thiếu created/updated/actor, CLI trả TRAINER_DATA_INVALID trước migration review | EN08 / fixture US65 | Bổ sung tiền đề fixture, giữ toàn bộ assert; kết quả retest lưu riêng, chưa gắn commit tự tạo |
| EN08-FIX-02 | Suite US11/33 mock nhầm một ServerClock trong module graph nhiều provider; reader/review writer vẫn dùng giờ thật nên kỳ fixture sai | EN08 / clock fixture US11/33 | Freeze prototype toàn bộ instance trong test; giữ nguyên assert thời điểm/trạng thái/kỳ/nguồn review, không đổi source nghiệp vụ |
| EN08-FIX-03 | Attendance migration commit tăng schedule guard ngay cả khi không có backfill, làm ensure-indexes lặp thay revision | US63 / migration | Giữ guard trong lúc validate, abort riêng transaction không cần ghi; thêm test revision không đổi và giữ assert US28 gốc |
| EN08-FIX-04 | Logout fixture lấy JwtService không cấu hình của feature khác; scheduling backfill fixture PT thiếu audit giống FIX01 | EN08 / fixture US03, US28 | Ký token test bằng secret/issuer/audience đúng fixture, bổ sung tiền đề PT; không bypass Guard/giảm assert auth hoặc migration |
| EN08-FIX-05 | Test US26 nhận nhầm attendance PT của US63 là đăng ký lớp miễn phí | EN08 / schema test US26 | Chỉ cho phép đúng hai model attendance theo ca, kiểm shift_id và không có class/session reference; vẫn cấm mọi enrollment/registration khác |

Các lỗi sản phẩm phát sinh khi chạy có test name/command trong evidence; lập mã lỗi, mức ảnh hưởng, nguồn IDs, người xử lý thực tế, commit sửa và retest. Không reset DB thủ công để giấu mismatch. Ba TODO nguồn hiện tại tại US64 correction/completion vẫn bị EN08 từ chối dù EN04 phân loại TODO riêng; phải bổ sung hoặc dẫn tới test tương đương đã được review, không xóa chỉ để xanh.

Trước nghiệm thu cần: checkout sạch cùng commit/URL, đủ mọi suite/20 TC/237 AC có bằng chứng được review; không outcome unknown; không lỗi quyền/tiền/tồn/quota/chỉ số/dữ liệu; tất cả fixture report qua nguồn thật và oracle independent; EN07 browser HTTPS/cookie/realtime, restart worker và restore/report verification; người khác tái chạy từ runbook. Hồ sơ học thuật/UC38/schema/API/test results cập nhật theo **sản phẩm thật**, chưa làm giữ BLOCKED. Bộ harness này không tự ghi Done vào tracker/Excel hoặc sửa requirement DOCX.
