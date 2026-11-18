# EN-07 — Chuẩn bị và vận hành UAT

Truy vết: `[GM]Requirement_EN-07.docx` v1.0, F01–05, S01–02, D01–05, AC01–03; EN-01/02/03/04, US-02 và EN-08. Sequence: [en07-sequence.mmd](en07-sequence.mmd).

**Trạng thái: chuẩn bị triển khai, chưa deploy và chưa nghiệm thu.** Ngày 18/11/2026, người dùng xác nhận chưa có hạ tầng UAT; chưa có domain, provider, MongoDB UAT, tài khoản vận hành hoặc ngân sách được giao. `example.invalid` chỉ là placeholder. Không có URL thật hoặc kết quả HTTPS/restore/EN-08 trong repository. Không đăng ký dịch vụ trả phí, không triển khai production từ bộ này.

## 1. Topology và điều kiện đầu vào

Phương án tham chiếu để người vận hành lựa chọn: một máy Linux chạy Docker Engine + Compose v2 hỗ trợ `env_file.required`, một Caddy phục vụ React static và proxy giữ nguyên `/api`, `/socket.io` sang **một** Nest instance. Namespace thông báo `/notifications`, transport `/socket.io/`, WebSocket cùng cổng 443. MongoDB là replica set/managed cluster bên ngoài container, phiên bản tương thích dữ liệu đã kiểm; test hiện dùng MongoDB 8.0.17. Không tự tạo cluster, không bật nhiều backend replica, không dùng hosting ngủ/serverless cho workers.

Caddy quản lý chứng thư và redirect HTTP; domain phải có DNS trỏ đúng máy, inbound 80/443, outbound ACME và MongoDB được cho phép. Nest không publish port ra host. `TRUST_PROXY_HOPS=1` chỉ hợp lệ khi mọi đường đến Nest đều đi qua duy nhất Caddy; bỏ proxy thì dùng 0. Nếu thêm CDN/load balancer, phải thiết kế lại trusted proxy và kiểm cookie/IP, không tăng số hop tùy ý. Không bật access log chứa query/token; Caddy admin API tắt.

DB UAT tên `gym_uat_<name>` (chữ thường/số/gạch dưới), tách credentials và dữ liệu dev/test. `DEPLOYMENT_ENV=uat` đi cùng `NODE_ENV=production`, HTTPS origin chính xác và `UAT_DATA_CLASSIFICATION=DEMO_ONLY`. App từ chối cấu hình sai, test-only `EN04_*`/`EN05_*`/`EN06_*`, thiếu quote secret/location; không sửa contract dev/test. UAT startup kiểm replica set/index và transaction ghi-abort trước mở cổng. Swagger theo cấu hình production hiện có: tắt. Health chỉ trả trạng thái, readiness khác liveness.

DB app user chỉ được đọc/ghi DB UAT; dùng user migration/backup/restore riêng với quyền cần thiết theo provider, không cấp root cho app. Kết nối DB dùng TLS và network allowlist/private network theo hạ tầng đã giao. Người vận hành phải ghi cách xác minh TLS/chứng thư và quyền DB vào deployment record; regex URI không chứng minh TLS. Không dùng DB người thật dù tên DB khớp guard.

## 2. Inventory và record

- Runtime: Node **24.13.0**, npm **11.11.1**, hai lockfile trong repo. Docker build dùng `npm ci`; không copy `node_modules`/`.env` từ máy tác giả. Caddy được pin `2.10.2-alpine`; trước sử dụng phải pull/build và ghi image digest thực, không coi tên tag là bằng chứng đã chạy.
- `/etc/gym-uat/release.env`: copy [release.env.example](../deploy/release.env.example), điền commit đầy đủ trong `RELEASE_ID`, domain thật, đường dẫn backend env. File này không chứa secret. `UAT_MAINTENANCE=1` mặc định chặn tất cả route public bằng 503.
- `/etc/gym-uat/backend.env`: copy [uat.env.example](../deploy/uat.env.example), hạn chế owner/quyền đọc; không đặt trong Git. `MONGODB_URI`, JWT, quote secret độc lập tối thiểu 32 byte, seed credentials nhận riêng qua secret store. SMTP/OTP pepper chỉ bật khi dùng US-05; SMTP sandbox, không gửi tới email người thật. Không ghi giá trị secret vào record/log/command line. Runtime không cần giữ các mật khẩu seed sau khi bàn giao: bỏ chúng khỏi env chạy thường ngày; giữ bản secret store riêng cho tác vụ seed.
- `VITE_API_BASE_URL=https://<domain-thật>/api` được tạo lúc build web từ `UAT_DOMAIN`. Đây là cấu hình public duy nhất, không chứa credentials. Đổi domain phải rebuild web.
- Transfer mặc định tắt (`RECEIVING_ACCOUNTS=[]`, `RECEIVING_ACCOUNT_DETAILS=[]`, `PAYOUT_ACCOUNTS=[]`). Demo dùng CASH mô phỏng, tên/ghi chú **DEMO ONLY**. Nếu bật transfer, chỉ dùng tài khoản sandbox được phê duyệt và có nhãn demo; không nhập tài khoản nhận tiền thật.

Tại gốc checkout chạy `node scripts/uat-record.cjs`: tạo draft mới ở `artifacts/en07-deployment.json`, không ghi đè record có sẵn. Record đo commit, dirty flag, runtime và SHA-256 hai lockfile; chưa tự gắn URL/provider/TC đạt. Bổ sung provider/service identifiers không secret, chi phí, người giữ quyền/vận hành, domain thật sau deploy, image digests, config version, phiên bản tools và link evidence. Draft từ checkout dirty không đại diện một release chỉ bằng commit; phát hành phải dùng checkout sạch và tạo record lại tại thư mục artifact riêng. Lưu bản record/evidence đã duyệt trong kho bàn giao được bảo vệ.

## 3. Build và dựng môi trường lần đầu

Các lệnh host dưới đây dùng Bash trên máy Linux tham chiếu, từ gốc checkout. Trước mỗi bước xác nhận exit code 0; không chạy tiếp khi lỗi. Không in `docker compose config` đầy đủ vì có thể lộ env; dùng `--quiet`. Không dùng `.env` cá nhân ở checkout làm cấu hình UAT.

```sh
git status --porcelain
node --version
npm --version
node scripts/quality-gate.cjs
docker compose --env-file /etc/gym-uat/release.env -f deploy/compose.uat.yml config --quiet
docker compose --env-file /etc/gym-uat/release.env -f deploy/compose.uat.yml build --pull
docker compose --env-file /etc/gym-uat/release.env -f deploy/compose.uat.yml run --rm --no-deps backend node scripts/uat.cjs config-check
```

Quality gate EN-04 đã có: cài hai lockfile, typecheck source/test, build, unit/frontend/integration/e2e và kiểm evidence; sử dụng DB test riêng, không dùng secret UAT. Repository chưa có script lint. Pin runtime/npm đúng trước chạy. Docker build chưa được xem là đạt nếu chỉ build ngoài Docker.

Sau khi người vận hành xác nhận DB mới, riêng, chỉ dữ liệu demo:

```sh
docker compose --env-file /etc/gym-uat/release.env -f deploy/compose.uat.yml run --rm --no-deps backend node scripts/admin.cjs ensure-indexes
docker compose --env-file /etc/gym-uat/release.env -f deploy/compose.uat.yml run --rm --no-deps backend node scripts/admin.cjs check-environment
docker compose --env-file /etc/gym-uat/release.env -f deploy/compose.uat.yml run --rm --no-deps backend node scripts/admin.cjs seed-admin
docker compose --env-file /etc/gym-uat/release.env -f deploy/compose.uat.yml run --rm --no-deps backend node scripts/admin.cjs seed-access
docker compose --env-file /etc/gym-uat/release.env -f deploy/compose.uat.yml run --rm --no-deps -e UAT_DEMO_SEED=ALLOW_DEMO_ONLY backend node scripts/uat.cjs seed-demo
docker compose --env-file /etc/gym-uat/release.env -f deploy/compose.uat.yml up -d backend
docker compose --env-file /etc/gym-uat/release.env -f deploy/compose.uat.yml exec backend node scripts/uat.cjs workers
docker compose --env-file /etc/gym-uat/release.env -f deploy/compose.uat.yml up -d web
```

Production `ensure-indexes` dùng migrations/schema đã có, không `syncIndexes`, không tự xóa record trùng. **Không chạy lần đầu trên DB đang nhận ghi.** UAT cập nhật có dữ liệu phải qua backup/rehearsal mục 5 trước lệnh này. Nếu DB standalone/thiếu unique index thì `check-environment` và startup chặn; không bypass để demo.

Seed Admin/roles giữ contract EN-01: chạy lại không reset password/timestamps. Demo chỉ chạy opt-in, DB `gym_uat_*` không phải `gym_uat_restore_*`, classification DEMO_ONLY và business DB mới (cho phép Admin + dữ liệu hạ tầng index/roles ban đầu). Unique marker `_uat_fixtures/_id=en07-demo-v1` chặn hai seed đồng thời. Tạo bốn vai trò với credentials env; GYM/PT đã thanh toán/kích hoạt, ca PT/booking ngày mai giờ VN, lớp Yoga, sản phẩm/phiếu nhập, POS đã giao, trả một hàng và hoàn CASH qua API/RBAC/transaction thật. CLI chỉ mở listener loopback tạm, không bật worker hoặc test clock. `COMPLETED` chạy lại không ghi business data. Fixture cũ không tự dời lịch; dựng DB demo mới khi cần lịch mới.

Seed lỗi giữa chừng lưu `FAILED` và các ID đã tạo, dừng và yêu cầu người vận hành đối chiếu; không tự xóa/reset hoặc chạy lại nhân giao dịch. Khắc phục qua API thật, hoặc dựng một DB demo mới có tên mới sau review. Trạng thái marker COMPLETED chỉ nói phần fixture được hỗ trợ đã tạo; `blockedDependencies` vẫn ghi thiếu WEBSITE/report, không có nghĩa EN07 Done. Không lưu password/token trong marker. CLI login/logout bằng bearer; cookie trình duyệt vẫn phải kiểm riêng.

Chỉ sau kiểm index/readiness/fixture, đổi `UAT_MAINTENANCE=0` trong release env và recreate web:

```sh
docker compose --env-file /etc/gym-uat/release.env -f deploy/compose.uat.yml up -d --no-deps --force-recreate web
docker compose --env-file /etc/gym-uat/release.env -f deploy/compose.uat.yml exec backend node scripts/uat.cjs smoke
```

`smoke` kiểm HTTPS bằng TLS mặc định (không bỏ verify), live/ready + requestId, không lộ Swagger và SPA deep link. Không đánh dấu TC07–11/15 đạt chỉ từ lệnh này. URL thật chỉ điền vào record sau khi truy cập thành công.

## 4. Browser smoke, worker và mất DB

Người vận hành dùng browser thật trên domain UAT, credentials bàn giao riêng của ADMIN/STAFF/TRAINER/MEMBER:

1. Xác minh HTTPS/chứng thư hợp lệ, HTTP redirect; refresh trực tiếp `/member/memberships` trả SPA, API prefix giữ nguyên, response có requestId. Thử `/api/docs`, `/api/docs-json`, endpoint test/reset: không có Swagger/test hook công khai.
2. Mỗi vai trò login, reload/refresh session, đổi trang, logout rồi gọi lại `/api/auth/me` bằng access token cũ phải 401. Kiểm cookie `gym_refresh`: HttpOnly, Secure, SameSite=Lax, path `/api/auth`; không đưa token vào URL/log/screenshot. Token chỉ giữ bộ nhớ frontend. Origin lạ và vai trò sai phải bị chặn backend. Ghi từng role đã quan sát.
3. MEMBER xem gói đã kích hoạt, PT booking/lớp; TRAINER xem lịch; STAFF đối chiếu POS, kho, phiếu trả/hoàn; ADMIN xem tài khoản/gói/danh mục. Không thao tác tiền thật. WEBSITE checkout và report chưa có writer/API: ghi BLOCKED, không dựng dữ liệu giả để coi smoke đạt.
4. Mở hai phiên khác account, offline/reconnect network: REST sync lấy lại thông báo, không trùng; logout/thu hồi auth không phát nội dung vào socket phiên cũ. Thử token hết hạn/thu hồi; đối chiếu response và DB, không chỉ biểu tượng UI.
5. Có outbox READY, reminder đến hạn, đơn HELD hết 24 giờ theo **giờ thật**: ghi IDs/counters, restart `backend`, kiểm catch-up (outbox ~5s, expiry ~5s, reminder <=60s) và không lặp payment/kho/notification. Không bật fault/clock hooks trên UAT. Dùng `node scripts/uat.cjs workers` quan sát queue status/DEAD, oldest lag, expiredHeld, occurrence count; reminder log `REMINDER_BATCH` có lag/failed/existing. Counts riêng chưa chứng minh worker đang xử lý; phải ghi before/after cùng nguồn.
6. Chặn mạng DB có kiểm soát: ready503, live có thể200, ghi bị từ chối và UI hiển thị lỗi thật; khôi phục DB, quan sát readiness và worker catch-up, kiểm lại business IDs. Thao tác trên UAT demo trong cửa sổ bảo trì, ghi thời điểm/lý do/kết quả.

Giám sát logs an toàn từ main/filter/reminder, không log env/body/auth headers; `docker compose logs` chỉ lưu nơi được bảo vệ và rà dữ liệu nhạy cảm trước chia sẻ. Đồng bộ UTC/NTP host, business timezone VN. Dừng container gửi SIGTERM, có `init` và grace 60s; phải quan sát kết thúc in-flight và restart bằng TC09, không suy ra từ cấu hình. Host restart/backup cần người vận hành thử thật và ghi thời gian.

## 5. Backup, restore và migration rehearsal

Phương án công cụ cho topology tham chiếu: MongoDB Database Tools do operator cài trên máy quản trị tin cậy, pin phiên bản tương thích MongoDB thực và ghi `mongodump --version`, `mongorestore --version` trong record. Image app không cài sẵn tools. Nếu dùng snapshot provider, ghi đúng công cụ/provider/snapshot ID, không coi lệnh tham chiếu dưới đây là bằng chứng snapshot đã có.

**Dừng toàn bộ writers trước dump:** bật maintenance=1 và recreate web; stop backend (kể cả workers), chặn client/CLI ghi khác và xác nhận không có tác vụ quản trị. Có downtime; chưa cam kết zero-downtime. Flag `UAT_WRITES_STOPPED=CONFIRMED` là xác nhận vận hành, không tự dừng các process khác. TTL của MongoDB vẫn có thể thay dữ liệu session trong khoảng dump: CLI so snapshot trước/sau và fail nếu có thay đổi; xử lý cửa sổ ổn định rồi tạo archive mới, không bỏ kiểm tra.

Trên máy quản trị có checkout/build đã kiểm, chạy tại `backend`; không nạp `.env` cá nhân. Tạo `/etc/gym-uat/operations.env` trong secret store với `NODE_ENV=production`, `DEPLOYMENT_ENV=uat`, `MONGODB_DB` là DB nguồn UAT, `MONGODB_URI` của user backup/restore riêng có quyền tạo/ghi/index trên namespace restore được giao. Không dùng app user chỉ có quyền DB nguồn để restore; không cần sao chép JWT/password demo vào file vận hành này. Node `--env-file` đọc file secret ngoài Git, không đưa URI/password vào argv; thư mục backup owner-only, ổ đĩa/backup store mã hóa, ACL và retention do operator ghi rõ. Mode 600 của CLI không thay thế ACL trên Windows hoặc mã hóa at rest. Không đưa archive vào Git.

```sh
# Chỉ đặt flag sau khi đã dừng writers và workers thực tế.
export UAT_WRITES_STOPPED=CONFIRMED
node --env-file=/etc/gym-uat/operations.env scripts/uat.cjs backup /protected-backups/release1.archive.gz
node --env-file=/etc/gym-uat/operations.env scripts/uat.cjs restore-rehearsal /protected-backups/release1.archive.gz gym_uat_restore_release1
node --env-file=/etc/gym-uat/operations.env scripts/uat.cjs migration-plan gym_uat_restore_release1
```

Secret được CLI truyền cho Database Tools qua file YAML tạm mode600 và xóa trong `finally`; tool stdout/stderr thô bị tắt, lỗi chỉ có mã. Operator phải cấu hình ACL thư mục temp riêng tư nếu chạy Windows.

`backup` từ chối ghi đè archive/manifest, kiểm ledger/quan hệ nguồn, băm BSON với kiểu Int32/Int64/Decimal/date/IDs được giữ, counts và hợp đồng index (cả thứ tự compound keys), tổng tiền thu/hoàn từ dữ liệu nguồn; dump gzip có SHA-256, snapshot trước/sau phải khớp. Manifest cạnh archive có phiên bản tools và thời gian đo thực. Archive tồn tại nhưng thiếu manifest hợp lệ nghĩa là backup chưa được xác nhận, không dùng cho rehearsal. Chỉ lần restore thành công mới chứng minh archive đọc được.

`restore-rehearsal` kiểm archive hash/source DB, chỉ cho target mới `gym_uat_restore_*` không có collection, dùng nsInclude/nsFrom/nsTo, không `--drop`, không restore đè UAT. So counts/hashes/indexes/nguồn/ledger/tổng thu-hoàn; ghi `*.restore.json` cả khi mismatch. Không chạy app/workers trên DB restore trước so sánh (chúng có thể sửa catch-up). Receipt `_uat_restore_receipt` chỉ tạo sau so thành công. `migration-plan` yêu cầu receipt này, chạy chính `ensure-indexes` trên bản restore, kiểm lại nguồn/ledger/tổng tiền và báo collection thay đổi; **không phải dry-run giả trên DB live**. Sau review kết quả clone mới chạy migration trên UAT đang dừng ghi theo mục 3. Giữ archive/manifest/evidence an toàn; không có lệnh tự drop DB restore.

Đối chiếu thêm report fixture từ API báo cáo khi module có thật; hiện `ReportsModule` rỗng nên mục này BLOCKED. Tổng tiền trong manifest là oracle phục hồi vận hành, không thay báo cáo nghiệp vụ US-50/51. Ghi phạm vi dữ liệu, downtime và backup/restore elapsed thực; không tự công bố RPO/RTO.

## 6. Cập nhật và rollback

Trước đổi phiên bản: chốt commit sạch, release notes, schema changes, previous image digests/commit/config, backup đọc được + restore rehearsal + migration-plan đã review. `ensure-indexes` hiện không nguyên tử toàn bộ migration; nếu lỗi, tiếp tục maintenance, không mở writer và không xóa record để ép index. Fixture không chạy lại trên DB đang dùng.

Deploy thứ tự: maintenance → dừng backend → backup/rehearsal → migrations/index → seed roles/Admin nếu cần → backend/worker → readiness → frontend/routes → browser smoke → EN-08 cùng commit/URL. Chỉ mở UAT sau các gate môi trường; chỉ ghi bản **nghiệm thu** sau EN-08 đạt. EN-08 chưa có runner trong source hiện tại, không thay bằng EN-04 hay đánh dấu TC15 tự động.

Nếu backend không ready hoặc smoke fail: bật/giữ maintenance, dừng tiếp nhận ghi. Khi schema tương thích, đổi `RELEASE_ID` về commit/artifact trước và dùng đúng config version, tránh build lại source mới dưới tag cũ; `docker compose up -d --no-deps backend web` rồi kiểm health/browser/worker. Khi schema không tương thích hoặc đã có ghi mới: dừng và đối soát các giao dịch sau backup, review kế hoạch restore/cutover sang **DB mới** trước thay cấu hình. Không restore đè hoặc âm thầm bỏ giao dịch mới. Ghi commit, thời điểm, lý do, phạm vi dữ liệu, người quyết định và evidence kiểm lại trong record. TC12 phải diễn tập thực, không đánh dấu đạt từ mô tả này.

## 7. Ma trận nghiệm thu và kiểm tra source

| TC | Công cụ/bằng chứng cần có | Trạng thái ban đầu |
| --- | --- | --- |
| 01 | Checkout sạch, quality gate, Docker build, commit/runtime/lock hash và image digest | Chưa chạy trên host UAT |
| 02–05 | Guard config/DB, secret audit, replica/index, Admin seed 2 lần + demo sai DB | Có test source; còn kiểm trên UAT |
| 06–08 | HTTPS/SPA/API, 4 browser role auth, socket reconnect/revoke | Chưa chạy UAT |
| 09–10 | Restart/catch-up, ngắt DB, đối chiếu nguồn và lỗi UI | Chưa chạy UAT |
| 11 | Archive hash + restore JSON + nguồn/ledger/payment/refund + report | Chưa chạy tools; report bị chặn |
| 12–14 | Rollback thực, người khác tái tạo, Swagger/test hook không public | Chưa chạy UAT |
| 15 | EN-08 trên đúng commit/URL, evidence đạt | Chưa chạy, thiếu runner |

Lệnh kiểm phát triển (build trước integration vì CLI dùng dist): backend `npm run typecheck`, `npm run typecheck:test`, `npm run build`, `npm run test:unit -- --runTestsByPath test/en07.spec.ts test/foundation.spec.ts`, `npm test -- --runTestsByPath test/en07.integration-spec.ts test/environment-check.integration-spec.ts`; frontend `npm run build`, auth/logout/notifications tests. Test EN07 dùng MongoMemoryReplSet thật, credentials ngẫu nhiên, mô phỏng copy BSON chỉ để kiểm oracle — **không phải** bằng chứng `mongodump/mongorestore` hay UAT.

Kiểm tra cục bộ ngày 18/11/2026: EN-04 chưa đạt, integration chạm giới hạn 20 phút và không tạo report hoàn chỉnh. Đã đối chứng trên checkout riêng của HEAD `cf852014de6f71b2ad00e535fccae8ecd79b4aba`: 29 ca lỗi có sẵn trong 6 suite `trainer-reviews-migration` (5), `members-query` (5), `scheduling-backfill` (12), `scheduling-migration` (4), `logout` (2), `public-sessions-schema` (1). Các lỗi liên quan fixture PT thiếu audit (`TRAINER_DATA_INVALID`), clock trong test hội viên, kỳ vọng revision guard, JwtService dùng ký token trong test và regex nhận nhầm collection attendance. Giữ nguyên kiểm tra/constraint; cần xử lý và chạy lại gate trước nghiệm thu. Lượt chạy tuần tự EN07 + environment-check + password-reset đạt 61/61; unit đạt 232, frontend đạt 759 và E2E S01 đạt 68. Đây là bằng chứng source cục bộ, chưa thay trạng thái TC UAT trong bảng trên.

Hợp đồng nghiệp vụ/API/schema hiện có không đổi. Bổ sung env triển khai, CLI nội bộ và marker chỉ dùng UAT; không thêm endpoint seed/clock/fault/reset. Theo dõi EN-01 config/health, US-02 trust proxy/cookie, EN-03 lifecycle/queue và EN-08 release gate theo sequence ở đầu tài liệu.

Tài liệu công cụ chính thức đã đối chiếu: [Caddy reverse_proxy và WebSocket](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy), [SPA routes](https://caddyserver.com/docs/caddyfile/patterns), [automatic HTTPS](https://caddyserver.com/docs/automatic-https), [mongodump](https://www.mongodb.com/docs/database-tools/mongodump/), [mongorestore và namespace mapping/config](https://www.mongodb.com/docs/database-tools/mongorestore/).
