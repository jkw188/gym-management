# Gym Management — EN-01, EN-04 và các nghiệp vụ Sprint 1

React + TypeScript (Vite), NestJS 11 với Express và MongoDB/Mongoose, kiến trúc Modular Monolith.
EN-01 bổ sung nền tảng dùng chung; US-02 triển khai đăng nhập theo bốn vai trò, JWT/Passport, refresh và khôi phục phiên. US-06 bổ sung danh sách, chi tiết, tạo và sửa thông tin tài khoản dành cho Admin; US-07/08 bổ sung khóa/mở khóa và đổi vai trò qua transaction bảo vệ Admin cuối cùng.
US-01 bổ sung đăng ký tài khoản Member công khai tại `/register`.

## Chuẩn bị môi trường sạch

- Node.js **24.13.0** (`.nvmrc`), npm **11.11.1** (`packageManager` trong hai package.json) và MongoDB đang chạy (local hoặc dịch vụ riêng). CI dùng cùng phiên bản Node/npm; không nâng dependencies để chạy EN-04. Không bắt buộc Docker hoặc replica set ở EN-01.
- Cài riêng từng ứng dụng bằng `npm ci` trong `backend` và `frontend`; không cài ở thư mục gốc.
- Sao chép `.env.example` thành `.env` trong từng ứng dụng **nếu chưa có file**. PowerShell: `Copy-Item .env.example .env`; macOS/Linux: `cp .env.example .env`. Với `.env` đã có, bổ sung các biến còn thiếu, không ghi đè cấu hình cá nhân.
- `.env`, credentials, `node_modules`, build và cache không được đưa vào Git. Không đặt secret vào `VITE_*`.

| Biến backend | Quy tắc |
| --- | --- |
| `NODE_ENV` | `development`, `test` hoặc `production`; mặc định development |
| `PORT` | Số nguyên 1–65535; mặc định 3000 cho dev/test; production phải khai báo |
| `FRONTEND_ORIGIN` | Chính xác một HTTP(S) origin, không path/query/credentials/dấu `/` cuối; mặc định dev/test `http://localhost:5173`; production phải khai báo |
| `MONGODB_URI` | Bắt buộc; `.env.example` dùng local `mongodb://127.0.0.1:27017`; URI có credentials chỉ lưu trong `.env` |
| `MONGODB_DB` | Bắt buộc; dev minh họa `gym_management`; test chấp nhận `gym_test_…` cho EN-04 và tên `gym_management_test`/`gym_management_test_…` của các test cũ. Runner EN-04 chỉ cấp database `gym_test_…` có suffix run/worker/suite và kiểm quyền sở hữu trước cleanup |
| `SEED_ADMIN_PHONE`, `SEED_ADMIN_NAME`, `SEED_ADMIN_PASSWORD` | Chỉ bắt buộc khi seed; không có mật khẩu mặc định |
| `SEED_ADMIN_EMAIL` | Tùy chọn; trim/lowercase, rỗng thì bỏ field |
| `JWT_ACCESS_SECRET` | Bắt buộc; sinh từ ít nhất 32 byte ngẫu nhiên, không có mặc định và không đưa vào frontend |
| `JWT_ACCESS_TTL_SECONDS`, `REFRESH_TTL_SECONDS` | Mặc định và chỉ chấp nhận `900`, `604800`; access không vượt hạn tuyệt đối phiên |
| `JWT_ISSUER`, `JWT_AUDIENCE` | Mặc định và chỉ chấp nhận `gym-api`, `gym-web` |

Tên biến sai/thiếu được báo khi startup, không in giá trị. Chọn server MongoDB timeout 10 giây, không retry startup nhiều lần; thất bại thoát khác 0. Kết nối đóng khi shutdown.

Sinh secret cục bộ bằng `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`, rồi đặt vào `backend/.env`; không đưa secret vào commit hoặc log. Đổi secret sẽ làm các access token hiện có không còn xác minh được.

## Khởi tạo index và Admin

Trong `backend`, sau khi điền MongoDB và thông tin seed trong `.env`:

```sh
npm ci
npm run ensure-indexes
npm run seed:admin
npm run start:dev
```

Mỗi lệnh quản trị tự build trước khi chạy, dùng chung schema/service với backend. `ensure-indexes` chỉ tạo index được khai báo, **không gọi `syncIndexes` và không xóa index**. Nếu dữ liệu cũ trùng, lệnh thất bại; cần rà dữ liệu và backup trước khi xử lý, không tự xóa dữ liệu.

Dev/test tạo và xác minh index trước khi nhận ghi. Production tắt autoIndex/autoCreate, phải chạy `npm run ensure-indexes` bằng quyền quản trị trước khi khởi động; startup chỉ xác minh index đã tồn tại, thiếu index thì dừng. Production `npm run build` rồi `npm run start:prod`.

Seed upsert bốn role `ADMIN`, `STAFF`, `TRAINER` (hiển thị PT), `MEMBER`. Phone `0901234567`, `84901234567`, `+84 901 234 567` đều thành `+84901234567`. Dùng thông tin Admin của bạn, mật khẩu 12–128 ký tự Unicode; không trim mật khẩu, không dùng mật khẩu minh họa cho môi trường thật.

Seed chạy lại giữ nguyên password, họ tên, email, timestamps của Admin ACTIVE đã có. Phone thuộc Member/vai trò khác hoặc Admin LOCKED trả xung đột và exit khác 0; không tự nâng quyền/mở khóa. Ghi các bước độc lập, lỗi giữa chừng có thể chạy lại. Hai seed đồng thời được bảo vệ bằng unique index và đọc xác minh bản ghi thắng khi gặp duplicate. Log không có mật khẩu/hash.

## Replica set và transaction EN-02

Transaction nhiều document (EN-02, US-05) cần MongoDB chạy replica set; standalone bị từ chối, không chuyển sang ghi rời. Sau `npm run ensure-indexes`, kiểm tra môi trường trước nghiệm thu:

```sh
npm run check-environment
```

Lệnh kiểm topology và mọi index tài chính EN-02, rồi ghi thử/rollback; in `ENVIRONMENT_READY` khi đạt. Thiếu điều kiện thì in `ENVIRONMENT_NOT_READY` và thoát mã 1, không tự tạo index hoặc commit dữ liệu probe.

EN-02 cung cấp khóa ghi chung và migration Int64 cho `plans.guard_revision`, `members.service_revision`, `transactions.guard_revision` qua `ensure-indexes`; các module sở hữu nghiệp vụ phải khởi tạo revision=0 khi tạo document mới và dùng khóa trước khi kiểm tra dữ liệu.

## Frontend và health

Terminal thứ hai, trong `frontend`:

```sh
npm ci
npm run dev
```

`frontend/.env` dùng `VITE_API_BASE_URL=http://localhost:3000/api`. Mở `http://localhost:5173/login` để đăng nhập hoặc `/health` để kiểm tra nền tảng. Màn hình health gọi riêng live và ready qua fetch dùng chung, có loading, thông báo lỗi và nút **Thử lại**; live thành công chưa đồng nghĩa DB sẵn sàng.

| Endpoint public | Phản hồi |
| --- | --- |
| `GET /api/health/live` | 200 `{ "status": "ok" }` khi tiến trình phục vụ |
| `GET /api/health/ready` | 200 `{ "status": "ready" }` sau khi ping DB; 503 nếu mất kết nối/ping thất bại |
| `/api/docs`, `/api/docs-json` | Swagger UI/OpenAPI ở development/test; không mở ở production |

Mỗi HTTP response có `X-Request-Id` do server sinh. Lỗi dạng `{ "error": { "code": "...", "message": "...", "details": [{ "field": "...", "message": "..." }] }, "requestId": "<uuid>" }`; `details` là tùy chọn. Validation/ID sai 400, trùng index 409, DB unavailable 503; giữ 401/403/404/429. Không trả raw database error, stack, URI hoặc dữ liệu nhạy cảm. Log lỗi chỉ ghi allowlist timestamp/requestId/code/status, không serialize headers/body/exception.

Global ValidationPipe bật transform/whitelist/forbidNonWhitelisted, tắt implicit conversion. Field lạ trong lỗi được thay bằng `unknownField` để không phản chiếu dữ liệu client. Endpoint DTO/RBAC thử chỉ tồn tại trong test; API tài khoản thật được bảo vệ bằng JWT/RBAC. Hai health endpoint vẫn public.

## Đăng ký tài khoản US-01 / UC-03

Đối chiếu `[GM]Requirement_US-01.docx` phiên bản 1.0: khách chưa đăng nhập tạo danh tính truy cập, không tự nhận hồ sơ hội viên hoặc gói tập. Phone là bắt buộc, email tùy chọn; quy định này thay phần “SĐT/Email” trong UC-03 cũ. Đã đăng nhập mở `/register` sẽ chuyển về trang theo vai trò; đang kiểm tra phiên phải chờ khôi phục xong.

| API công khai | Kết quả |
| --- | --- |
| `POST /api/auth/register` | JSON `{fullName,phone,password,email?}`; `201 {id,nextAction:"LOGIN"}` sau khi insert được xác nhận; không cookie/token |
| `400 VALIDATION_ERROR` | Thiếu/sai/thừa trường; details chỉ có tên trường và lỗi an toàn |
| `409 REGISTRATION_CONFLICT` | Phone/email trùng accounts; thông báo chung, không phân biệt vai trò/trạng thái hoặc trường đã tồn tại |
| `409 REGISTRATION_NEEDS_HELP` | Phone trùng members chưa liên kết; hướng dẫn liên hệ quầy, không tiết lộ hồ sơ |
| `409 ROLE_NOT_CONFIGURED` | Chưa seed MEMBER; không tạo role trong request |
| `429 TOO_MANY_REQUESTS` | Tối đa 5 yêu cầu đăng ký/IP/60 giây, có Retry-After, không khóa tài khoản |
| `503 SERVICE_UNAVAILABLE` | Không đọc được nguồn cần kiểm tra hoặc ghi thất bại; không báo thành công giả |

`fullName` 2–120 ký tự Unicode sau trim/gộp khoảng trắng; phone raw string tối đa 32 và chuẩn EN01-D01; email trim/lowercase tối đa 190, rỗng/omit bỏ field, null bị 400. Password 12–128 ký tự Unicode, không trim, dùng PasswordService Argon2id EN-01. Chỉ chấp nhận bốn field DTO; confirm chỉ kiểm frontend, role/status/ID/version do server quản lý.

Luồng UC-03: React kiểm trường và confirm → RegistrationGuard giới hạn riêng và kiểm JSON → RegisterDto → AuthController → UsersService chuẩn hóa/tra role/định danh → adapter nội bộ đọc members → PasswordService hash → UsersRepository insert accounts với role MEMBER, ACTIVE, version/auth_version=0 → 201 → `/login?reason=registered` kèm thông báo thành công. Không auto login hoặc tạo members, membership, trainer, auth_sessions. Sơ đồ hiện hành: [registration-sequence.mmd](docs/registration-sequence.mmd).

Adapter members chỉ mô tả `phone`, `account_id` theo báo cáo mục 4.2.7 và kiểm bản ghi có account_id thiếu/null. Index đọc `members_phone_lookup` không unique; các constraint ghi hồ sơ đầy đủ thuộc US-09. Chạy lại `npm run ensure-indexes` trước startup production; startup chỉ xác minh index, không tạo/xóa/sửa hồ sơ. Không thêm env/dependency hoặc yêu cầu transaction cho đăng ký.

Unique indexes accounts quyết định chống trùng phone/email khi đồng thời. Việc đọc members không bảo đảm duy nhất một người giữa nhiều collection nếu quầy tạo hồ sơ cùng lúc; tuyệt đối không tự nối/ghi đè bằng phone. US-09 chịu trách nhiệm đối chiếu có xác minh. Limiter memory áp dụng cho một backend instance, tách biệt ngưỡng login; không tin X-Forwarded-For khi chưa cấu hình proxy tin cậy.

UI có nhãn, hiện/ẩn password và confirm, focus trường lỗi/thông báo, khóa form khi pending; lỗi 400 đặt cạnh trường, 409 giữ bản nháp và hướng dẫn phù hợp, 429 hiển thị thời gian chờ. Password chỉ giữ trong memory của form và xóa khi thành công, không vào URL/storage. Lỗi mạng/mất response sau submit báo chưa xác định kết quả và cho chuyển đăng nhập hoặc liên hệ quầy; không tự gửi lại POST. Gửi lại do người dùng chủ động vẫn có thể gặp 409; API không có idempotency key.

Truy vết nghiệm thu giữ nguyên mã US-01:

| AC | TC và bằng chứng tự động |
| --- | --- |
| US-01-AC01 | TC01–02: `backend/test/registration.integration-spec.ts`, tạo đúng account, không sinh hồ sơ/phiên; login/me thật qua US-02 |
| US-01-AC02 | TC03–05: DTO/field cấm, Unicode, email rỗng/null, hash Argon2id/giữ khoảng trắng, response/log an toàn |
| US-01-AC03 | TC06–09: phone/email chuẩn hóa, hai POST đồng thời, hồ sơ ngoại tuyến thiếu/null account_id, quầy ghi sau bước kiểm tra không tự liên kết |
| US-01-AC04 | TC10–13: role thiếu, lỗi insert MongoDB và mất kết nối thật, limiter riêng/Retry-After; `frontend/src/features/auth/registration.test.tsx` kiểm form/focus/bàn phím/pending/lỗi mạng/chuyển login |

Backend chạy MongoDB 8.0.17 thật do mongodb-memory-server quản lý, database riêng `gym_management_test_us01`; test không thay MongoDB bằng dữ liệu giả. TC09 dùng hàng rào tại bước hash để đặt thao tác ghi hồ sơ thật đúng sau bước đọc. Frontend dùng jsdom/HTTP giả lập; vẫn cần kiểm tra trình duyệt thật và review trước khi ghi Done toàn bộ US-01.

Kiểm tra nhanh: sau ensure-indexes và seed:admin, chạy backend/frontend, mở `/register`, nhập tên/số điện thoại mới/password ≥12 ký tự cùng confirm (email tùy chọn). Mong đợi về `/login` có thông báo, rồi đăng nhập đến `/member`. Thử đăng ký lại với phone `0`/`+84` tương đương để thấy lỗi chung; dùng DB test tạo member chưa liên kết cùng phone để kiểm tra hướng dẫn liên hệ quầy. Không xóa role hoặc ngắt DB của môi trường thật để thử lỗi.

## Xác thực US-02

| API | Hợp đồng |
| --- | --- |
| `POST /api/auth/login` | `{phone,password}`; Origin bằng FRONTEND_ORIGIN, Content-Type application/json; 200 `{accessToken,tokenType,expiresIn,user}` và cookie refresh |
| `POST /api/auth/refresh` | Body `{}`, cùng Origin/Content-Type; cookie `gym_refresh`; 200 cùng cấu trúc login, rotate cookie; token cũ 401 không xóa cookie hoặc revoke phiên |
| `GET /api/auth/me` | Bearer access token; 200 `{id,fullName,phone,email?,roleCode}` lấy từ account/role hiện tại |

Ví dụ trong PowerShell (nhập password thật trong terminal riêng; không ghi vào script được commit):

```powershell
$credential = Get-Credential -UserName '0901234567' -Message 'Tài khoản Gym'
$loginBody = @{ phone = $credential.UserName; password = $credential.GetNetworkCredential().Password } | ConvertTo-Json
$auth = Invoke-RestMethod -Method Post -Uri 'http://localhost:3000/api/auth/login' -Headers @{ Origin = 'http://localhost:5173' } -ContentType 'application/json' -Body $loginBody -SessionVariable gymSession
Invoke-RestMethod -Uri 'http://localhost:3000/api/auth/me' -Headers @{ Authorization = "Bearer $($auth.accessToken)" }
$auth = Invoke-RestMethod -Method Post -Uri 'http://localhost:3000/api/auth/refresh' -Headers @{ Origin = 'http://localhost:5173' } -ContentType 'application/json' -Body '{}' -WebSession $gymSession
```

Login dùng phone chuẩn EN01-D01 và PasswordService Argon2id, không trim password. Sai/không tồn tại/LOCKED/role hỏng trả chung `401 INVALID_CREDENTIALS`; không tồn tại vẫn verify dummy hash. Input sai 400, Origin thiếu/sai 403 `INVALID_ORIGIN`, DB lỗi 503. Limiter memory cho một backend instance: 5 lần theo cặp IP/phone đã chuẩn hóa và 20 lần theo IP trong 60 giây; 429 có `Retry-After`, không tự khóa account. Express không trust proxy mặc định; nếu có proxy phải cấu hình chính xác proxy tin cậy trước khi dùng IP chuyển tiếp, không tin `X-Forwarded-For` từ Internet.

`auth_sessions` lưu `_id=id`, `account_id` có index, `refresh_hash` SHA-256 hex unique/select false, `auth_version` BSON Int32 không âm, `created_at`, `expires_at`, `revoked_at?`. TTL trên expires_at chỉ dọn dữ liệu; Guard kiểm hạn tường minh. Login luôn tạo phiên mới, hạn tuyệt đối 7 ngày. Refresh compare-and-set theo hash cũ, phiên còn hạn/chưa revoked; hai refresh đồng thời chỉ một thành công, không kéo dài expires_at. `ensure-indexes` bao gồm cả session; production phải chạy lại lệnh này trước khi khởi động US-02, không xóa index/dữ liệu cũ.

JWT HS256 chỉ chứa sub/sid/av/iat/exp cùng iss/aud, tối đa 900 giây. Guard xác minh chữ ký/algorithm/issuer/audience/exp và đọc session/account/role mỗi request: đúng chủ, ACTIVE, chưa revoked, còn hạn, auth_version của account/session/av khớp. `@Roles(...)` dùng role DB và chạy sau JWT; route mới mặc định cần xác thực, `@Public()` chỉ dành cho route chủ động công khai. US-06 đổi phone/email và US-07/08/67 phải tăng accounts.auth_version; chỉ sửa tên tăng version, không tăng auth_version. US-03 sẽ ghi revoked_at; US-02 không mở API logout.

Cookie host-only `gym_refresh`: HttpOnly, SameSite=Lax, Path=/api/auth, Expires theo hạn phiên; production luôn Secure, development chỉ bỏ Secure ở localhost/loopback. CORS credentials=true với một origin tường minh. Production phải đặt frontend/API cùng site và HTTPS qua hosting/proxy; không sửa sang wildcard hoặc đưa refresh token vào JSON để khắc phục cấu hình cookie. Auth responses, kể cả lỗi, có Cache-Control: no-store.

Frontend AuthProvider có checking/authenticated/anonymous; reload gọi refresh rồi me trước khi render route bảo vệ. Access chỉ trong memory, không dùng localStorage/sessionStorage; fetch login/refresh có credentials: include. API có auth dùng `apiClient.request<T>(path, init)`, shared refresh promise và retry tối đa một lần; 403 giữ role và báo thiếu quyền, lỗi mạng giữ trạng thái/thông báo để thử lại. `apiGet` tiếp tục dành cho health public. Nhiều tab có thể tranh cookie: tab thua refresh chuyển về login cục bộ, không thu hồi phiên của tab thắng.

Route mặc định: ADMIN `/admin`, STAFF `/staff`, TRAINER `/trainer`, MEMBER `/member`. `/login` khi đã xác thực chuyển về shell đúng vai trò; returnTo chỉ chấp nhận route đã triển khai đúng role, loại URL ngoài/role khác. Form có label, hiện/ẩn password, lỗi trường, pending chống gửi lặp và giữ input khi lỗi mạng. Shell chưa có nghiệp vụ dashboard; không có chức năng logout của US-03.

Báo cáo DOCX trong `docs` được cập nhật UC-04 (bao gồm Staff), mục 4.2.5 và sơ đồ login/refresh theo [nguồn Mermaid](docs/auth-sequence.mmd). Requirement US-02 là nguồn cho phone và lỗi chung; sơ đồ email/lỗi riêng cũ được thay thế.

## Quản lý tài khoản US-06

Admin đăng nhập, chọn **Quản lý tài khoản** hoặc vào `/admin/users`. Màn hình có danh sách, tìm tên/email/phone, lọc vai trò/trạng thái, phân trang và form **Thông tin tài khoản**. Vai trò khác bị chặn cả route UI lẫn toàn bộ API; Guard dùng session, account, role hiện hành trong MongoDB.

| API (Bearer Admin) | Input / kết quả |
| --- | --- |
| `GET /api/users` | `page=1`, `limit=20` (tối đa 100), `q` tối đa 120 ký tự, `roleCode`, `status`; `{items,page,limit,total,totalPages}` |
| `GET /api/users/roles` | `{items:[{code,name}]}` từ role seed theo ADMIN, STAFF, TRAINER, MEMBER; không tự seed |
| `GET /api/users/:id` | UserDto có version; ID sai `400 INVALID_ID`, không có `404 USER_NOT_FOUND` |
| `POST /api/users` | `{fullName,phone,email?,password,roleCode}`; 201 ACTIVE, version=0; không nhận confirm/version/status/id |
| `PATCH /api/users/:id` | `{version,fullName?,phone?,email?}`; bắt buộc ít nhất một trường dữ liệu; 200 bản hiện tại/mới |

UserDto chỉ chứa `id,fullName,phone,email?,roleCode,roleName,status,version,createdAt,updatedAt`; không trả model thô, hash, auth_version hoặc token. Tìm kiếm literal (escape regex), chuẩn hóa khoảng trắng tên, email và phone; hỗ trợ cả tiền tố phone nội địa khi tìm một phần. Sort `created_at DESC, _id DESC`; items/total dùng cùng filter, không cam kết snapshot giữa các request. Không có kết quả trả `items=[]`, `totalPages=0`.

Tạo dùng PasswordService Argon2id của EN-01, mật khẩu 12–128 ký tự Unicode, giữ nguyên khoảng trắng; confirm chỉ ở frontend. FullName 2–120 ký tự sau chuẩn hóa; phone raw tối đa 32 ký tự; email trim/lower tối đa 190, trống thì bỏ field. Role code hợp lệ nhưng chưa seed trả `409 ROLE_NOT_CONFIGURED`. Tạo Member/PT chỉ ghi accounts, không tạo hồ sơ, membership hoặc phiên.

PATCH omit giữ nguyên, `email=null` bỏ field bằng `$unset`; email chuỗi trắng sau chuẩn hóa cũng được bỏ theo EN01-D01. `fullName`/`phone` null/rỗng bị 400. `roleCode/roleId/role_id`, status, password/hash, auth_version, ID, timestamps và liên kết nghiệp vụ đều bị từ chối 400. Khóa/mở khóa thuộc US-07, đổi role US-08, đổi/reset mật khẩu US-67/US-05; US-06 không có DELETE.

Lệnh update lọc `_id + version`, tăng version đúng một lần và updated_at; stale trả `409 VERSION_CONFLICT`, account đã mất trả 404. No-op sau chuẩn hóa không ghi/tăng timestamps/version/auth_version, vẫn kiểm version hiện hành. Phone/email thực sự đổi tăng auth_version **trong cùng lệnh ghi**; Guard/refresh US-02 từ chối phiên cũ. Chỉ sửa tên giữ phiên. Admin đổi định danh chính mình sẽ xóa access trong memory, về login và yêu cầu đăng nhập bằng thông tin mới; refresh đang chờ không khôi phục phiên cũ.

Kiểm tra trùng trước giúp báo lỗi; unique index quyết định khi request đồng thời. Lỗi trả `409 PHONE_ALREADY_EXISTS` hoặc `EMAIL_ALREADY_EXISTS` kèm details.field an toàn. `/api/users` dùng filter lỗi riêng để trả `401 UNAUTHENTICATED` / `503 SERVICE_UNAVAILABLE` đúng US-06; Auth/Health giữ mã lỗi có sẵn. Query giới hạn thời gian 5 giây và driver timeout 10 giây theo EN-01. Không thêm schema/index/env/dependency hay transaction.

UI khóa submit khi pending, giữ dữ liệu khi validation/trùng/version conflict; stale version chặn lưu tiếp và chỉ tải bản mới sau khi xác nhận bỏ bản nháp. POST không tự retry khi lỗi mạng/503 hoặc response mất; nếu không biết kết quả, tìm lại theo phone trước khi thử tạo lại. Tạo thành công luôn hiện ID dù list tải lỗi; nút tải lại chỉ GET, không gửi POST lần nữa. Đây không phải API có idempotency key.

Sơ đồ [sequence](docs/users-sequence.mmd) và [class](docs/users-class.mmd) cùng phần UC-28/mục accounts trong báo cáo DOCX mô tả US-06 và nhánh khóa/mở khóa US-07.

## Khóa/mở khóa tài khoản US-07 — UC-28

Admin chọn **Khóa / Mở khóa** tại `/admin/users`; hộp thoại GET lại account hiện hành, yêu cầu lý do trim 10–500 ký tự và xác nhận. Cảnh báo riêng khi tự khóa. Thao tác chỉ đổi quyền truy cập; không sửa trạng thái PT, membership, booking, đơn hàng hoặc xóa lịch sử.

`PATCH /api/users/:id/status` (Bearer ADMIN) nhận `{status:"ACTIVE"|"LOCKED",version,reason}`; trả `{user:<UserDto US-06>,changed,reauthenticationRequired}`. Không nhận actorId, roleCode hoặc trường hệ thống. Version cũ luôn trả `409 VERSION_CONFLICT`, kể cả trạng thái đích trùng hiện tại. Version đúng và cùng trạng thái trả `changed=false`, không tăng version/auth_version/updated_at hoặc ghi audit.

`UsersModule` xuất `AccountSecurityService.changeStatus` và `changeRole` dùng chung cho US-07/08; API/giao diện đổi role được mô tả ở mục US-08 bên dưới. Mọi luồng giảm quyền Admin, bao gồm script vận hành tương lai, phải qua dịch vụ này. Trong transaction snapshot/majority, ghi tăng revision Int64 của `security_state {_id:"account-administration"}` trước khi đọc lại actor, phiên, auth_version, target/version và đếm Admin ACTIVE thực tế. Việc ghi chung bảo vệ cả hai app/connection; không dùng mutex process hoặc count ngoài transaction. Cấm khóa/hạ vai trò Admin ACTIVE cuối cùng (`409 LAST_ACTIVE_ADMIN`). Seed chỉ thêm Admin ACTIVE, không mở khóa hoặc nâng quyền account đã có.

Chuyển trạng thái thật tăng version và auth_version đúng một lần, cập nhật updated_at và insert `security_events` trong cùng transaction. Audit chỉ có `_id,actor_id,target_id,action,before,after,reason,created_at,request_id`; action LOCK/UNLOCK/CHANGE_ROLE, before/after chỉ status hoặc roleCode. Index `{target_id:1,created_at:-1,_id:-1}` và `{actor_id:1,created_at:-1}`; không có API sửa/xóa audit. Login/access/refresh kế tiếp bị chặn khi khóa; mở khóa chỉ cho đăng nhập mới, không phục hồi token cũ. Verified claims dùng symbol nội bộ để kiểm tra lại phiên trong transaction, không xuất vào JSON.

Driver retry transient conflict/unknown commit theo `TransactionRunner` với deadline 10 giây. Không retry lỗi nghiệp vụ. Thiếu document khóa trả `503 SECURITY_STATE_NOT_READY`; standalone, DB lỗi hoặc hết deadline trả `503 SERVICE_UNAVAILABLE`. Không có đường ghi bỏ transaction. Kết quả 503 hoặc mất response có thể chưa xác định: UI chặn submit tiếp, yêu cầu GET lại trạng thái/version, không tự lấy version mới để gửi PATCH. 409 cũng yêu cầu tải lại/xác nhận mới. Submit và GET đối chiếu trạng thái không tự refresh hoặc replay; self-lock thành công xóa phiên trong memory về login, GET 401 sau mất response cũng về login.

### Môi trường dev và nghiệm thu quản trị (EN-04)

MongoDB replica set bắt buộc cho US-07/US-08. EN-01 CRUD một document vẫn chạy được standalone. Có thể dùng replica set hiện có hoặc khởi tạo local bằng `mongod --replSet rs0 --dbpath <thư-mục-dữ-liệu> --bind_ip 127.0.0.1`, sau đó chạy `rs.initiate()` trong mongosh và cấu hình `MONGODB_URI=mongodb://127.0.0.1:27017/?replicaSet=rs0`. Thư mục dữ liệu phải được tạo trước.

Trước khi nhận API, trong `backend` chạy `npm run ensure-indexes`, `npm run check-environment`, rồi seed Admin nếu chưa có. `ensure-indexes` tạo hai index audit và khởi tạo revision=0 bằng `$setOnInsert`; chạy lại giữ revision đã có, không ghi đè tài khoản. Không xóa/sửa account hoặc security_state trực tiếp khi vận hành ứng dụng. Không thêm env/dependency. EN-02 tiếp tục sở hữu nền tảng transaction rộng hơn; US-07 dùng phần bảo vệ quản trị cần sẵn sàng ở S01.

Kiểm tra US-07: `npm run build` rồi `npm test -- --runTestsByPath test/account-security.integration-spec.ts` trong backend; `npm test -- --pool=threads --maxWorkers=1 src/features/users/account-status.test.tsx` trong frontend. Backend chạy mongod thật 8.0.17 trên replica set test riêng với hai Nest app và hai connection, JWT/Guard/session và index thật; kiểm tra lock/lock, lock/role và role/role, rollback khi audit hoặc trước commit lỗi, retry transient, deadline unknown commit, thiếu khóa, DB ngắt và standalone. Bộ test US-07 kiểm cuộc đua role qua service bằng principal thật; bộ US-08 bổ sung kiểm qua HTTP API đổi role. Test frontend dùng jsdom/HTTP giả lập, chưa thay thế kiểm tra bố cục, focus và cookie trên trình duyệt/hosting thật.

## Hợp đồng MongoDB EN01-D01/D02

`UsersModule` sở hữu duy nhất AccountSchema/RoleSchema và repository; `UsersService` xuất tra cứu nội bộ. `AuthModule` gọi UsersService, không tạo AccountSchema khác. Các trường MongoDB dùng snake_case; mapper API dùng camelCase. ID public là chuỗi ObjectId 24 hex; `_id` không xuất qua mapper; không nhận id/_id từ DTO client.

| Collection | Trường/ràng buộc |
| --- | --- |
| `roles` | `_id`, `id` ObjectId bằng nhau, id unique; `code` enum ADMIN/STAFF/TRAINER/MEMBER unique; `name` ≤120; `created_at`, `updated_at` Date UTC |
| `accounts` | `_id`, `id` bằng nhau, id unique; `role_id` tham chiếu roles.id; `full_name` 2–120 Unicode, trim/gộp khoảng trắng |
| `accounts` định danh | `phone` chuẩn hóa bắt buộc unique; `email` tùy chọn ≤190, bỏ field nếu rỗng; partial unique `{email: {$type: 'string', $gt: ''}}` |
| `accounts` bảo mật | `password_hash` ≤255, select false, xóa khỏi document JSON kể cả đã select; Argon2id m=19456 KiB/t=2/p=1, salt thư viện sinh; helper hash/verify chung |
| `accounts` trạng thái | `status` ACTIVE/LOCKED, mặc định ACTIVE; `version`, `auth_version` BSON Int32 không âm, mặc định 0; hai phiên bản có mục đích khác nhau |
| `accounts` thời điểm | `created_at`, `updated_at` Date UTC do server quản lý |

Index tường minh: roles_id_unique, roles_code_unique, accounts_id_unique, accounts_phone_unique, accounts_email_unique (partial). `_id` có unique index mặc định MongoDB. Mongoose 9 được chọn vì hỗ trợ Int32 trực tiếp, tương thích peer dependencies của @nestjs/mongoose 11.0.4.

Chuẩn hóa phone bỏ khoảng trắng/dấu chấm/gạch nối/ngoặc cân bằng; `0` + 9–10 chữ số đổi sang +84; `84` + 9–10 chữ số thêm +; quốc tế `+` + 8–15 chữ số, chữ số đầu khác 0. Email lowercase/trim; họ tên chỉ render như text. Account thay đổi không tự cập nhật hoặc liên kết hồ sơ members/trainers.

Báo cáo `docs/Nhom02_BuiNhatDuong_NguyenChiCuong_BaoCaoTuan03.docx` mục 4.2.1/4.2.4 được cập nhật theo EN-01: mã STAFF/TRAINER thay EMPLOYEE/PT, auth_version/updated_at, timestamps role và ràng buộc mới. Nếu database cũ đã có EMPLOYEE/PT hoặc dữ liệu chưa chuẩn hóa, cần kế hoạch migration/backup và kiểm tra tham chiếu trước khi dùng; EN-01 không tự đổi dữ liệu cũ.

## Kiểm tra tự động và nghiệm thu

Trong `backend`:

```sh
npm run typecheck
npm run typecheck:test
npm run build
npm run test:unit
npm run test:integration
```

`npm test` giữ hành vi chạy unit và integration hiện có; `test:unit` tự tìm `test/**/*.spec.ts` và `src/**/*.spec.ts`, `test:integration` tự tìm `test/**/*.integration-spec.ts`. Bộ EN-04 riêng tại `test/**/*.e2e-spec.ts` chạy bằng `npm run test:e2e`, không bị chạy lặp trong `npm test`. Cần `npm run build` trước integration vì có subprocess từ `dist/main.js` và CLI thật. Integration dùng **tiến trình mongod thật** do mongodb-memory-server quản lý, MongoDB 8.0.17, port động và database test riêng, gồm `gym_management_test_us01`; không dùng DB dev/.env, không mô phỏng MongoDB. Binary được tải/cache lần đầu, có thể cần vài phút và quyền mạng/chạy mongod. Đặt `MONGOMS_DOWNLOAD_DIR` vào thư mục writable như `.cache/mongodb-binaries` nếu môi trường giới hạn user cache, hoặc `MONGOMS_SYSTEM_BINARY` khi đã cài mongod phù hợp. Khi hoàn tất, test đóng app và dọn database tạm.

Trong `frontend`: `npm run typecheck`, `npm run build`, `npm test` (Vitest + jsdom/Testing Library). Test US-02 kiểm tra bốn role, checking/restore, returnTo, form/pending/lỗi mạng, single-flight và retry giới hạn; mock HTTP ở frontend, không thay cho kiểm thử cookie trên browser/hosting thật. Hai ứng dụng chưa có script lint; không báo đã chạy lint. Thư viện US-02 thêm JWT/Passport/cookie-parser và type declarations ở backend, React Router ở frontend; Vitest/jsdom/Testing Library chỉ dành cho test. Override js-yaml hiện có dưới Swagger được giữ nguyên.

US-06 có `backend/test/users.spec.ts`, `backend/test/users.integration-spec.ts` và `frontend/src/features/users/users.test.tsx`: validation/mapper, 401/403 qua login/Guard/session thật, list/search/paging, role thiếu, hash/không sinh profile/phiên, trùng phone/email và version đồng thời, no-op/$unset, hiệu lực access/refresh, MongoDB ngắt thực tế, OpenAPI, UI pending/lỗi/version conflict và response POST mất. Test frontend giả lập HTTP, không xác nhận bố cục/cookie trên trình duyệt thật. Nếu worker mặc định của Vitest bị timeout trong môi trường hạn chế, chạy `npm test -- --pool=threads --maxWorkers=1`.

## US-08 — Gán vai trò và thu hồi quyền (UC-29)

Trong `backend`, chạy `npm run ensure-indexes`, sau đó `npm run seed:access` để upsert bốn role, catalog quyền S01/S02 và mapping cố định. EN-02 bổ sung 12 quyền S02 vào 9 quyền S01. Lệnh seed chỉ cần cấu hình MongoDB; chạy lại giữ ID permission/mapping và không sửa account. Mapping dư bị báo lỗi để người vận hành rà soát, không tự xóa. API không seed hoặc sửa mapping; seed Admin vẫn dùng `npm run seed:admin` riêng.

| Endpoint dành cho Admin ACTIVE | Hợp đồng |
| --- | --- |
| `GET /api/access/roles` | `{items:[{code,name,permissions:[{code,name}]}]}`, thứ tự ADMIN/STAFF/TRAINER/MEMBER, permission theo code |
| `PATCH /api/users/:id/role` | `{roleCode,version,reason}`, reason trim 10–500; trả `{user,changed,reauthenticationRequired}` |

`GET /api/users/roles` giữ hợp đồng code/name cho tạo account. `access.policy.ts` là nguồn duy nhất cho decorator phân quyền và seed catalog S01: accounts.read/create/update/changeStatus/changeRole dành cho Admin; profile.readOwn/updateOwn dành cho Member/PT; auth.me/logout dành cho bốn role. RolesGuard dùng principal đọc từ account/session/role hiện hành trong DB, không cấp quyền tùy ý từ role_permissions hoặc claims client. Logout giữ policy US-02: public ở HTTP, kiểm phiên/ownership bằng access hoặc refresh và idempotent sau khi hết hạn. Register/login/refresh và health giữ policy riêng; các quyền module ở sprint khác không nằm trong catalog S01.

Catalog thiếu role/permission/mapping/index unique hoặc mapping lệch trả `503 PERMISSION_CATALOG_NOT_READY`, không tự sửa và không dùng catalog hỏng để suy ra quyền cho phép. RolesGuard thực thi ma trận cố định trong code. Collections mới theo báo cáo: `permissions` có `_id=id`, code unique ≤80, name ≤120; `role_permissions` tham chiếu roles.id/permissions.id với unique `(role_id,permission_id)`.

Đổi vai trò dùng đúng AccountSecurityService/security_state/transaction US-07. Sau khi ghi revision và kiểm lại actor/session, backend kiểm version, role đích và members/trainers.account_id trong cùng session; có liên kết thì `409 ROLE_IN_USE` với mọi thay đổi thật. Version cũ luôn `409 VERSION_CONFLICT`; no-op version đúng không tăng version/auth_version hay audit. Role đích hợp lệ nhưng thiếu seed trả `409 ROLE_NOT_CONFIGURED`. Không hạ Admin ACTIVE cuối cùng (`409 LAST_ACTIVE_ADMIN`); account LOCKED giữ LOCKED. Đổi thật tăng hai version, updated_at và audit CHANGE_ROLE cùng commit; mọi access/refresh cũ bị từ chối. Không sinh hồ sơ hoặc membership.

Tại `/admin/users`, chọn **Phân quyền**, xem vai trò/version và ma trận, chọn một vai trò, nhập lý do và xác nhận thu hồi phiên. Tự hạ quyền thành công xóa auth trong memory và về login. 409 giữ lựa chọn/lý do nhưng khóa submit đến khi tải lại và xác nhận mới; mất response/503 yêu cầu tra lại account hoặc đăng nhập lại, không tự refresh/replay PATCH hoặc báo thành công. `ROLE_IN_USE` không có nút ép đổi/xóa hồ sơ.

US-09/US-23 khi thêm luồng tạo/link hồ sơ phải ghi cùng khóa `account-administration`, kiểm role/status và dùng transaction cùng session. Kiểm profile trước transaction hoặc ghi profile trực tiếp sẽ phá bảo vệ cạnh tranh của US-08. Chức năng cần hồ sơ/membership phải kiểm nghiệp vụ riêng; role MEMBER/TRAINER không chứng minh đã có hồ sơ hoặc gói tập hiệu lực.

Kiểm thử US-08: `npm run build` rồi `npm test -- --runTestsByPath test/access-roles.integration-spec.ts test/account-security.integration-spec.ts` ở backend; `npm test -- --pool=threads --maxWorkers=1 src/features/users/account-role.test.tsx` ở frontend. Integration dùng replica set/standalone mongod thật, Guard/session/JWT thật và hai Nest app/connection; kiểm matrix/catalog, hai request cùng version, hai Admin hạ quyền lẫn nhau, khóa/role, actor mất quyền khi request đang chờ, rollback, transient retry và unknown commit deadline. Frontend dùng HTTP giả lập/jsdom; bố cục, focus trap và cookie trên trình duyệt/hosting thật cần kiểm tra thủ công trước nghiệm thu đầy đủ.

| Requirement | Kiểm tra tương ứng |
| --- | --- |
| TC01–03 | Unit env và subprocess startup: thiếu URI, sai PORT/origin, URI không kết nối, exit khác 0 và không lộ secret |
| TC04 | Dừng mongod, live 200/ready 503, khởi động lại và ready trở về 200 |
| TC05–07 | Chuẩn hóa; ghi phone đồng thời; optional email; email chuẩn hóa trùng; BSON Int32 và id=_id |
| TC08 | Salt khác nhau, verify đúng/sai, mật khẩu Unicode/khoảng trắng, hash không ra JSON |
| TC09–11 | Seed lặp giữ dữ liệu; Member/LOCKED xung đột; seed song song; gián đoạn sau role rồi retry; CLI thật |
| TC12–13 | DTO field thừa/sai kiểu, JSON lỗi, requestId/log an toàn, HTTP status và OpenAPI |
| TC14 | Build/typecheck hai phía và hướng dẫn chạy; kiểm tra UI/browser bằng tay riêng |

Kiểm tra thủ công: cấu hình JWT secret và MongoDB, chạy ensure-indexes/seed:admin, khởi động hai app; mở `/login` và nhập phone/password Admin đã seed, kết quả `/admin`. Fixture ba role khác được tạo trong integration test; US-02 không mở CRUD để tạo tài khoản ngoài phạm vi. Khi có dữ liệu ACTIVE STAFF/TRAINER/MEMBER, thử lần lượt trong profile browser riêng để đến đúng shell. Reload trang phải restore không chớp nội dung bảo vệ; Member mở `/admin` phải báo thiếu quyền. Kiểm cookie trong DevTools: HttpOnly/Lax/path, không có token ở Local/Session Storage; thử password sai và tắt backend để xem lỗi/thử lại. Mở `/health`: live/ready vẫn dùng được khi anonymous. Kiểm tra HTTPS/cookie Secure cùng site trên hosting production vẫn cần môi trường triển khai thật.

## Quy ước và tham khảo

Frontend giữ `api`, `components`, `features`, `hooks`, `layouts`, `pages`, `routes`, `types`, `utils`, xác thực nằm trong features/auth. Backend giữ các module nghiệp vụ; controller xử lý HTTP, service/repository quản lý nghiệp vụ/dữ liệu, common chứa tiện ích dùng chung. Transaction nhiều document thuộc EN-02; US-02 dùng CAS một document, không yêu cầu replica set.

- [NestJS MongoDB](https://docs.nestjs.com/techniques/mongodb)
- [NestJS Passport/JWT](https://docs.nestjs.com/recipes/passport)
- [React Router BrowserRouter](https://reactrouter.com/api/declarative-routers/BrowserRouter)
- [NestJS Validation](https://docs.nestjs.com/techniques/validation)
- [NestJS OpenAPI](https://docs.nestjs.com/openapi/introduction)
- [Mongoose Schema](https://mongoosejs.com/docs/api/schema.html)
- [MongoDB NODE-7832](https://jira.mongodb.org/browse/NODE-7832): cấu hình Node OS runtime adapter tường minh để driver hoạt động trong Jest VM.

## EN-02 — Hợp đồng nhất quán dữ liệu S02

Đã có hạ tầng transaction/idempotency, khóa ghi chung, index/migration, tiền VND và ngày Việt Nam. **Chưa đánh dấu Done EN-02:** source hiện chưa triển khai US-09/12/14/22 (members/link, plans, sale/membership, thu/chứng từ); EN-02 không tự đặt chính sách gia hạn, nâng gói, hủy hoặc đánh số chứng từ. Test hạ tầng dựng các đơn vị công việc tối thiểu để kiểm chứng constraint, không thay cho nghiệm thu các luồng này. Ca làm việc US-24/25 đang tái sử dụng IdempotencyService; NotificationsService/outbox hiện có hỗ trợ session và phát sau commit.

### Môi trường và migration (EN-02-F01, TC01–02)

MongoDB dev/test phải là replica set hoặc mongos hỗ trợ transaction. Ví dụ dev riêng: chạy `mongod --replSet rs0 --dbpath <dev-directory> --bind_ip 127.0.0.1`, khởi tạo `rs.initiate()` qua mongosh và cấu hình `MONGODB_URI=mongodb://127.0.0.1:27017/?replicaSet=rs0`. Dùng DB/test-directory và cổng riêng cho test như phần EN-04. Standalone không được fallback thành các lệnh ghi rời; health/ready giữ hợp đồng ping EN-01.

Trong cửa sổ bảo trì, sau backup và tạm dừng writer trên DB đích:

```sh
cd backend
npm ci --no-audit --no-fund
npm run ensure-indexes
npm run seed:access
npm run check-environment
```

`ensure-indexes` kiểm dữ liệu trùng theo mọi unique index EN-02 trước khi tạo index; trùng hoặc revision đã có sai kiểu/âm thì dừng, không xóa dữ liệu. Lệnh backfill **chỉ field còn thiếu** thành BSON Int64 `0`: plans.guard_revision, members.service_revision, transactions.guard_revision. Không đổi timestamp/version nghiệp vụ hoặc reset revision đã có. Tạo đủ index request_key, sale.transaction_id, membership.service_sale_id, invoice.transaction_id/invoice_no, payment.reference và payment.transaction_id partial `{status:"SUCCEEDED"}`, operation_requests bộ ba và notification.event_key. Không tự xóa index sai hoặc TTL; người vận hành phải rà soát chúng. Migration không thể bảo vệ khỏi writer cũ chưa tuân thủ khóa, nên phải dừng writer khi nâng cấp.

`check-environment` kiểm topology và toàn bộ index (unique, collation simple, không sparse, partial đúng, operation_requests không TTL), rồi ghi thử và cố ý rollback trong session thật. Không commit record probe hoặc tự sửa môi trường. Thành công in `ENVIRONMENT_READY`; lỗi exit khác 0 và thông báo an toàn. Lệnh này cần quyền ghi/transaction, không chỉ quyền đọc.

Migration cũng chuẩn hóa `operation_requests.client_key` cũ về chữ thường, giữ request_hash và kết quả; nếu phát hiện hai record cùng actor/operation và UUID chỉ khác hoa thường thì dừng để đối chiếu, không tự gộp/xóa kết quả.

### Tích hợp repository/service (F02–04, D01–03, TC03–16)

- Import `TransactionModule`; `TransactionRunner.run()` dùng snapshot/majority/primary, timeout driver 10 giây và luôn đóng session. Mọi repository dùng cùng connection/session; không mở transaction lồng, không `Promise.all` trong session và không socket/email/HTTP ngoài trong callback có thể chạy lại. Lỗi commit chưa rõ trả `503 OPERATION_OUTCOME_UNKNOWN`.
- Trong mỗi callback, gọi `DataGuardsService.acquire(session, targets)` **một lần với đủ các đích**, trước khi đọc kiểm tra nghiệp vụ. Thứ tự: security_state/account-administration → plans → members → transactions; ID trong mỗi collection tăng dần. Mỗi khóa tăng revision Int64 thật; thiếu document/revision hoặc tràn Int64 thì từ chối. Link account phải dùng đúng khóa US-07/08, kiểm lại role/status cùng session; không tạo mutex khác. Lock không tự tăng business version.
- `@IdempotencyKey()` bắt buộc UUID v4 và chuẩn hóa chữ thường; client giữ nguyên key cho cùng ý định. Service nhận actor từ principal đã qua Guard; `payload` phải là DTO đã chuẩn hóa, targetId là ID đã chuẩn hóa. Hash sắp xếp key object lồng nhau. `transactionRequestKey()` sinh SHA-256 hex64 của `actorId|operation|clientKey`, không lưu raw header vào transactions.request_key.
- `IdempotencyService.execute()` ghi dữ liệu và operation_requests trong cùng commit. Work trả public response DTO theo allowlist của module sở hữu; chỉ JSON được lưu, credential field bị từ chối và result_ids chỉ dùng field `...Id`. Cùng key/hash trả status/body gốc; khác payload/target trả `409 IDEMPOTENCY_CONFLICT`. Duplicate bộ ba retry tối đa ba lần; không retry duplicate index nghiệp vụ khác. Không lưu IN_PROGRESS hoặc TTL tài chính.
- `GET /api/operations/:operation/:key`: Bearer token, actor sở hữu và role hiện hành theo catalog; không nhận actorId từ query. Trả `200 {status:"COMMITTED",responseStatus,responseBody}` hoặc `404 OPERATION_UNKNOWN`. **404 có thể nghĩa là request gốc đang chạy**; client chỉ gửi lại cùng key, không tạo key mới để thử thu lại. 401/403 vẫn áp dụng khi replay/lookup.
- `normalizeVnd`/`toVndDecimal`/`fromVndDecimal`/`addVnd`/`subtractVnd` dùng decimal.js 10.6.0 và Decimal128. API nhận chuỗi chữ số nguyên không âm ≤999999999999, không float/exponent/phần lẻ; kết quả canonical bỏ số 0 đầu. `assertPaymentAmount` bắt buộc >0 và đúng amountDue. Luồng miễn phí phải có căn cứ nghiệp vụ và không tạo payment giả.
- `ServerClock` có thể override trong test, `today()` dùng Asia/Ho_Chi_Minh. `assertBusinessDate` và `addCalendarDays` kiểm lịch/cộng ngày, `membershipEndDate` trả startDate+durationDays−1. Timestamp vẫn UTC Date/ISO; không tin ngày hiện tại do client gửi.
- `RECEIVING_ACCOUNTS` là JSON array mã công khai, ví dụ `["MAIN_VND"]`; trống/`[]` không cho TRANSFER, CASH độc lập. Service thu tiền tương lai phải gọi `ReceivingAccountPolicy.assertTransferAllowed(code)` trước ghi TRANSFER. Không điền credential ngân hàng. Config sai làm startup fail chỉ nêu tên biến.

Catalog và `FixedPermission` dùng chung `access.policy.ts`: STAFF/ADMIN có members.read/create/update/link, serviceSales.read/create/cancel, transactions.read/confirmPayment, invoices.read; plans.manage và planPolicies.manage chỉ ADMIN. Endpoint nghiệp vụ tương lai phải dùng decorator tương ứng; việc seed catalog không tự tạo API hoặc cấp quyền qua client.

Kiểm thử tập trung: `npm run build` rồi `npm test -- --runTestsByPath test/financial-values.spec.ts test/financial-integrity.integration-spec.ts test/environment-check.integration-spec.ts test/idempotency.integration-spec.ts test/transaction-runner.integration-spec.ts`. Dùng mongod 8.0.17 thật, gồm hai connection cùng DB và standalone riêng. TC05/09–12 ở financial-integrity là probe hạ tầng, còn phải chạy lại bằng API nghiệp vụ khi các US sẵn sàng. Xem [class](docs/transaction-class.mmd) và [sequence](docs/transaction-sequence.mmd); báo cáo mục 4.2 bổ sung revision, định dạng tiền/key và operation_requests.

## EN-04 — Quality gate và bằng chứng nghiệm thu

EN-04 cung cấp công cụ kiểm tra; không tạo API, không thay thế AC của từng US và không tự cập nhật trạng thái Excel. Dùng nhánh `feature/EN-04-<description>` hoặc `feature/US-xx-<description>`; commit/PR ghi mã requirement, kết quả và cách kiểm tra. PR theo `.github/pull_request_template.md`, liệt kê từng file, tác động schema/API/env và lỗi còn mở. Không commit `.env`, credentials, token, dữ liệu MongoDB, node_modules, build hoặc artifacts; không tự sửa Git history, push hay deploy.

### Chạy từ source sạch

Dùng Node/npm ở mục chuẩn bị. Trong backend, chỉ tạo `.env.test` nếu chưa có:

```powershell
Copy-Item .env.test.example .env.test
```

Linux/macOS dùng `cp .env.test.example .env.test`. Không sao chép `.env` dev sang cấu hình test. Không điền JWT/SMTP/seed production: runner tự sinh secret ngẫu nhiên cho từng run và tắt gửi thư thật.

Từ gốc repository:

```sh
node scripts/quality-gate.cjs
```

Gate lần lượt chạy `npm ci --no-audit --no-fund` ở backend/frontend, typecheck source và test backend, typecheck frontend, build hai ứng dụng, unit backend, test frontend, toàn bộ integration đã có và E2E S01. Khi repo thêm script lint, gate tự chạy lint; hiện chưa có. Bất kỳ lệnh lỗi, thiếu báo cáo, thiếu file test S01 bắt buộc trong kết quả thực thi, test fail hoặc test skip đều làm gate exit khác 0. Không dùng watch, skip suite bắt buộc hoặc forceExit. Giới hạn mỗi lệnh 20 phút; CI giới hạn toàn job 30 phút. Không chạy hai gate chung một checkout vì npm ci và artifacts cùng thư mục; dùng hai checkout riêng cho hai gate.

Trên Windows, đóng dev server/test watcher trong checkout trước khi chạy gate, hoặc dùng bản sao source sạch riêng. `npm ci` xóa node_modules cũ; thư viện native đang được tiến trình giữ mở có thể khiến lệnh thất bại giữa chừng. Không dừng tiến trình không rõ chủ sở hữu hoặc chạy lại cài sạch trên thư mục đang sử dụng.

Có thể chạy từng nhóm sau `npm ci`:

| Thư mục | Lệnh | Điều kiện |
| --- | --- | --- |
| backend | `npm run typecheck` / `npm run typecheck:test` / `npm run build` | Source và test đều phải kiểm kiểu |
| backend | `npm run test:unit` | Unit thuần; không cần MongoDB hoặc secret |
| backend | `npm run test:integration` | Build trước; các suite cũ tự tạo mongod riêng |
| backend | `npm run test:e2e` | NODE_ENV=test; `.env.test` hoặc biến môi trường riêng |
| frontend | `npm run typecheck` / `npm run build` | TypeScript và Vite |
| frontend | `npm test -- --pool=threads --maxWorkers=1` | Vitest/jsdom, không thay nghiệm thu browser |

### MongoDB, fixture và an toàn cleanup

`test:e2e` chỉ đọc `.env.test` ở runner. Thiếu NODE_ENV=test thì fail. Khi để trống MONGODB_TEST_URI, mongodb-memory-server khởi tạo **mongod thật 8.0.17 dạng replica set**, cổng/thư mục dữ liệu tạm và tự dừng sau test; không cần Docker hoặc MongoDB dev. Cần tải binary lần đầu; dùng MONGOMS_DOWNLOAD_DIR để chọn cache writable hoặc MONGOMS_SYSTEM_BINARY trỏ mongod 8.0.17 có sẵn. Khi offline và chưa có binary, setup thất bại, không đánh pass.

Nếu dùng dịch vụ test riêng, cấu hình ví dụ:

```dotenv
NODE_ENV=test
MONGODB_TEST_URI=mongodb://127.0.0.1:27018/gym_test_s01?replicaSet=rsTest
```

Để tái tạo local: tạo thư mục dữ liệu **test riêng**, chạy `mongod --replSet rsTest --port 27018 --dbpath <test-directory> --bind_ip 127.0.0.1`, rồi `mongosh --port 27018 --eval 'rs.initiate()'`. Không dùng chung dữ liệu/cổng với dev. Tài khoản test cần tạo collection/index và đọc/ghi/drop các DB tạm trên dịch vụ test chuyên dụng; không dùng quyền/secret production.

Runner kiểm URI explicit có DB bắt đầu `gym_test_` (chỉ a-z, số, dấu gạch dưới; tối đa 24 ký tự phần base), không trùng MONGODB_DB hoặc DB trong MONGODB_URI nếu được cung cấp, không fallback URI dev. Kiểm `hello` bắt buộc replica set và session trước fixture; standalone fail `TEST_REPLICA_SET_REQUIRED` ngay cả khi chỉ chọn một test US-07/08.

Mỗi run có ID ngẫu nhiên, tên DB dạng `<base>_<run>_<worker>_<suite>` dưới 64 ký tự. Lease chỉ dọn đúng DB nó tạo, kiểm NODE_ENV, tên và marker chủ sở hữu trước mọi reset/drop; DB có sẵn hoặc marker khác bị từ chối. Reset xóa document nhưng giữ index/marker. Hai run E2E có thể dùng chung replica set vì tên/fixture độc lập. Các suite integration cũ vẫn dùng tiến trình/cổng/thư mục mongod riêng, không nhận URI dịch vụ ngoài từ EN-04.

Fixture E2E dùng Nest TestingModule và configureHttp chung với main (ValidationPipe, prefix, error filter, cookie/CORS). Tạo index, seed catalog quyền và security_state, hash mật khẩu fixture, tạo bốn account; lấy mọi token qua POST /api/auth/login. Mỗi test reset DB và cửa sổ LoginLimiter bằng một instance mới của implementation thật; không override Guard, JWT/session hoặc dựng principal. Hai Nest app/connection chung DB kiểm cạnh tranh. App/connection đóng trước khi lease dọn DB, rồi runner dừng replica set; timeout hữu hạn.

### Truy vết hồi quy S01

| Nhóm | Bằng chứng tự động |
| --- | --- |
| EN-01 / US-01 | foundation.spec/integration và registration.integration: env/index/hash/seed, đăng ký không nâng quyền/auto-link; S01 E2E kiểm luồng register/login |
| US-02 / US-03 | auth/logout.integration: bốn role, JWT/cookie/session, refresh CAS, revoke, DB lỗi; S01 E2E race refresh và logout |
| US-04 / US-06 | profile/users.integration và unit mapper/DTO: ownership, định danh unique, version CAS, identity thu hồi phiên; S01 E2E qua hai connection |
| US-07 / US-08 | account-security/access-roles.integration: khóa/role/Admin cuối cùng, rollback/retry, hai instance; S01 E2E kiểm HTTP cạnh tranh status/role, audit rollback |
| Ma trận endpoint × role | s01.e2e-spec.ts: 11 endpoint, anonymous 401 và ADMIN/STAFF/TRAINER/MEMBER với expected role độc lập ACCESS_POLICY; logout public theo policy US-03 kiểm riêng |
| An toàn test | test-database.spec.ts không cần DB; database-safety.e2e-spec.ts kiểm lease song song, marker sai và cleanup không ảnh hưởng DB khác |

TC03/08/11 là kiểm tra phá lỗi có chủ đích: trong checkout thử riêng, thêm lỗi TS vào source FE/BE rồi chạy typecheck tương ứng; đổi RolesGuard thành allow-all rồi chạy ma trận E2E; thêm một unit assertion sai rồi chạy unit/gate. Mỗi trường hợp phải exit khác 0, sau đó khôi phục chính thay đổi thử. Không sửa hoặc bỏ assertion để che lỗi. TC05 thử URI dev/sai prefix; TC07 dùng standalone test riêng. TC06/12 chạy E2E hai lần hoặc hai tiến trình với cùng replica set, bảo đảm không treo hay đụng fixture. Không làm probe trên source đang review hoặc DB dev.

### Báo cáo và CI

`artifacts/quality-gate.json` lưu commit, dirty flag (source local chưa commit không được coi là bằng chứng commit sạch), Node/npm/OS, thời gian UTC từng bước, lệnh, exit code và số pass/fail/skip. `unit.json`, `frontend.json`, `integration.json`, `e2e.json` giữ tên test/trạng thái đã lược lỗi thô; `e2e-environment.json` ghi phiên bản MongoDB thực tế và replica set. Báo cáo không ghi URI, biến môi trường, HTTP body hoặc token. Artifacts bị ignore, không phải file báo cáo nghiệp vụ tạo sau mỗi prompt. Khi không chạy gate, không tuyên bố đã có báo cáo gate đầy đủ.

Workflow `.github/workflows/ci.yml` chạy trên pull_request và push main/develop/nhánh tích hợp hiện tại feature/jikang/sprint1. Chỉ cấp contents:read, không truyền secret production hoặc deploy; replica set tạm được tạo trong job. Artifact JSON được upload kể cả khi fail. Khi đổi nhánh tích hợp phải cập nhật trigger. Chỉ ghi CI đã chạy khi có run GitHub thực tế; YAML hoặc gate local không chứng minh CI từ xa đã pass. Branch protection/required check phải do người có quyền repo cấu hình và kiểm chứng, chưa tự bật bằng source này.

Checklist UI trước nghiệm thu: đăng nhập lần lượt bốn vai trò; kiểm redirect/returnTo và thiếu quyền; reload có pending trước khi restore; cookie HttpOnly/Lax/Secure đúng môi trường; không lưu token vào local/session storage. Kiểm form pending/empty/error, mất mạng và 409 không replay ghi; logout/khóa/đổi role xóa cache, token cũ bị từ chối. Các test jsdom dùng HTTP giả lập, cần người kiểm trên browser/hosting thật. Gắn commit/link artifact/kết quả thật vào Tasks/NhatKy trong Excel hiện có khi được cung cấp; không tự ghi Done toàn sprint từ EN-04.
