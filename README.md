# Gym Management — EN-01, US-02 và US-06

React + TypeScript (Vite), NestJS 11 với Express và MongoDB/Mongoose, kiến trúc Modular Monolith.
EN-01 bổ sung nền tảng dùng chung; US-02 triển khai đăng nhập theo bốn vai trò, JWT/Passport, refresh và khôi phục phiên. US-06 bổ sung danh sách, chi tiết, tạo và sửa thông tin tài khoản dành cho Admin. Các module nghiệp vụ khác giữ nguyên.

## Chuẩn bị môi trường sạch

- Node.js 24.x, npm và MongoDB đang chạy (local hoặc dịch vụ riêng). Không bắt buộc Docker hoặc replica set ở EN-01.
- Cài riêng từng ứng dụng bằng `npm ci` trong `backend` và `frontend`; không cài ở thư mục gốc.
- Sao chép `.env.example` thành `.env` trong từng ứng dụng **nếu chưa có file**. PowerShell: `Copy-Item .env.example .env`; macOS/Linux: `cp .env.example .env`. Với `.env` đã có, bổ sung các biến còn thiếu, không ghi đè cấu hình cá nhân.
- `.env`, credentials, `node_modules`, build và cache không được đưa vào Git. Không đặt secret vào `VITE_*`.

| Biến backend | Quy tắc |
| --- | --- |
| `NODE_ENV` | `development`, `test` hoặc `production`; mặc định development |
| `PORT` | Số nguyên 1–65535; mặc định 3000 cho dev/test; production phải khai báo |
| `FRONTEND_ORIGIN` | Chính xác một HTTP(S) origin, không path/query/credentials/dấu `/` cuối; mặc định dev/test `http://localhost:5173`; production phải khai báo |
| `MONGODB_URI` | Bắt buộc; `.env.example` dùng local `mongodb://127.0.0.1:27017`; URI có credentials chỉ lưu trong `.env` |
| `MONGODB_DB` | Bắt buộc; dev minh họa `gym_management`; test bắt buộc `gym_management_test` hoặc tiền tố `gym_management_test_` để tránh dùng nhầm database thật |
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

Sơ đồ [sequence](docs/users-sequence.mmd) và [class](docs/users-class.mmd) cùng phần UC-28/mục accounts trong báo cáo DOCX mô tả triển khai này. UC-28 mới có create/update; khóa/mở khóa US-07 chưa triển khai.

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

`npm test` chạy cả unit và integration; hai script test:unit/test:integration bao gồm EN-01, US-02 và US-06. Cần `npm run build` trước vì integration kiểm tra subprocess từ `dist/main.js` và CLI thật. Integration dùng **tiến trình mongod thật** do mongodb-memory-server quản lý, MongoDB 8.0.17, port động và database `gym_management_test_en01`/`gym_management_test_us02`/`gym_management_test_us06`; không dùng DB dev/.env, không mô phỏng MongoDB. Binary được tải/cache lần đầu, có thể cần vài phút và quyền mạng/chạy mongod. Đặt `MONGOMS_DOWNLOAD_DIR` vào thư mục writable như `.cache/mongodb-binaries` nếu môi trường giới hạn user cache, hoặc `MONGOMS_SYSTEM_BINARY` khi đã cài mongod phù hợp. Khi hoàn tất, test đóng app và dọn database tạm.

Trong `frontend`: `npm run typecheck`, `npm run build`, `npm test` (Vitest + jsdom/Testing Library). Test US-02 kiểm tra bốn role, checking/restore, returnTo, form/pending/lỗi mạng, single-flight và retry giới hạn; mock HTTP ở frontend, không thay cho kiểm thử cookie trên browser/hosting thật. Hai ứng dụng chưa có script lint; không báo đã chạy lint. Thư viện US-02 thêm JWT/Passport/cookie-parser và type declarations ở backend, React Router ở frontend; Vitest/jsdom/Testing Library chỉ dành cho test. Override js-yaml hiện có dưới Swagger được giữ nguyên.

US-06 có `backend/test/users.spec.ts`, `backend/test/users.integration-spec.ts` và `frontend/src/features/users/users.test.tsx`: validation/mapper, 401/403 qua login/Guard/session thật, list/search/paging, role thiếu, hash/không sinh profile/phiên, trùng phone/email và version đồng thời, no-op/$unset, hiệu lực access/refresh, MongoDB ngắt thực tế, OpenAPI, UI pending/lỗi/version conflict và response POST mất. Test frontend giả lập HTTP, không xác nhận bố cục/cookie trên trình duyệt thật. Nếu worker mặc định của Vitest bị timeout trong môi trường hạn chế, chạy `npm test -- --pool=threads --maxWorkers=1`.

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
