# US-23 / UC-31 — Quản lý hồ sơ và trạng thái huấn luyện viên

Nguồn: `PM/SPRINT4/[GM]Requirement_US-23.docx`, phiên bản 1.0. Không sửa các DOCX đã phát hành.
Hợp đồng khóa lịch vẫn do US-28-G01/G02 (S04-G01) sở hữu; US-23 dùng đúng guard hiện có.

## Quyền, danh tính và dữ liệu

Chỉ ADMIN có `trainers.manage`. JWT guard hiện hành kiểm account, session, auth_version và role cho mỗi request,
kể cả replay/lookup. `trainers.account_id` là liên kết bất biến tới một account ACTIVE/TRAINER khi tạo;
không tạo account, đổi role, liên kết bằng phone hoặc chuyển lịch sử. US-08 tiếp tục trả `ROLE_IN_USE`
khi đổi role của account đã liên kết. Khóa account US-07 không đổi status trainer và không hủy lịch.

`trainers`: `_id/id`, `account_id` ObjectId, `specialty` trim 1–255 ký tự, `status` ACTIVE/INACTIVE,
`version` BSON Int32 ≥ 0, `created_at/updated_at` UTC, `created_by/updated_by` ObjectId.
Index thật: unique `account_id`, `(status,_id)`. Không nhân bản tên/phone/email; đọc qua projection account.

`trainer_events`: `trainer_id`, `actor_id`, action CREATED/UPDATED/DEACTIVATED/REACTIVATED,
before/after chỉ specialty/status/version, `occurred_at`, unique `request_key`.
Request key audit là SHA-256 của actor + operation + client key; index lịch sử `(trainer_id,occurred_at,_id)`.
Hồ sơ, audit và operation result luôn cùng transaction. Không có API DELETE.

## API

| Endpoint | Đầu vào / kết quả |
| --- | --- |
| GET `/api/trainers` | `q?`, `status?`, `page=1`, `limit=20` (≤100); `{items,page,limit,total,totalPages}` |
| GET `/api/trainers/:id` | Chi tiết hồ sơ và contact cho Admin; allowlist, không credentials/session/auth_version |
| POST `/api/trainers` | `{accountId,specialty,status}`; operation TRAINER_CREATE; 201, version 0 |
| PATCH `/api/trainers/:id` | `{version,specialty?,status?}`; operation TRAINER_UPDATE; ít nhất một giá trị thay đổi; 200, version +1 |
| GET `/api/trainers/:id/deactivation-blockers` | `kind?` BOOKING/SHIFT/PUBLIC_SESSION, page/limit; `{items,counts,asOf,page,limit,total,totalPages}` |
| GET `/api/operations/:operation/:key` | Tra cứu kết quả theo actor hiện hành; TRAINER_CREATE/TRAINER_UPDATE chỉ ADMIN |

Item list: `{id,accountId,fullName,specialty,status,version}`. Chi tiết bổ sung
`phone,email?,accountStatus,roleCode,createdAt,updatedAt`. Tên/contact lấy từ account hiện hành.
List sắp tên theo collation tiếng Việt rồi id ASC. `q` tối đa 120 ký tự, tìm literal theo tên/phone/chuyên môn;
phone nội địa và prefix được đổi về `+84` theo convention danh sách account. Rỗng có totalPages=0.
Projection account chỉ đọc `_id,full_name,phone,email,status,role_id`; không đọc password_hash hoặc auth_version.

Blocker item chỉ `{id,kind,startAt,endAt,status,managementUrl?}`, không tên/id hội viên.
Sắp kind ASC, startAt ASC, id ASC. Counts luôn gồm cả ba kind; total và trang theo kind được chọn.
`asOf` là giờ server dùng làm ngưỡng lọc; GET chỉ để lập kế hoạch, không giữ khóa/snapshot xuyên các truy vấn.
Lịch BOOKED, lớp PUBLISHED, ca SCHEDULED/CONFIRMED chặn khi `end_at > now`, gồm lịch đang diễn ra.
Booking đã qua giờ vẫn BOOKED không bị thay trạng thái hoặc trả quota; nó không chặn ngừng PT khi endAt ≤ now.

Lỗi theo EN01-D03. Các mã nghiệp vụ: ACCOUNT_NOT_FOUND (404), ACCOUNT_NOT_ELIGIBLE,
ACCOUNT_ALREADY_LINKED, VERSION_CONFLICT, TRAINER_HAS_ACTIVE_SCHEDULE (409).
ID sai/field ngoài allowlist/null không hợp lệ trả 400; ID hợp lệ không tồn tại trả 404.
Conflict lịch giữ cấu trúc details `{field,message}` chung của dự án:
`counts.BOOKING`, `counts.SHIFT`, `counts.PUBLIC_SESSION` có message là số lượng dạng chuỗi;
`blockersUrl` trỏ API được bảo vệ, `managementUrl` trỏ `/admin/pt-bookings`.
Không gửi danh sách hội viên trong response lỗi.

## Transaction và tích hợp lịch

Create: EN-02 transaction → security_state account-administration → schedule_guards global
→ kiểm account và unique link → trainer → audit → operation_requests → commit.
Update: transaction → schedule_guards global → đọc/version → tái đếm blocker nếu ACTIVE→INACTIVE
→ CAS profile → audit → operation_requests → commit. Version chạm giới hạn Int32 được từ chối với VERSION_CONFLICT.
Request chỉ gửi field giống giá trị hiện tại bị 400 vì không có thay đổi.

Mọi write yêu cầu Idempotency-Key UUID v4 theo EN-02; payload hash gồm targetId/version và các field đã chuẩn hóa.
Cùng actor/operation/key/payload trả HTTP/body gốc; khác payload trả IDEMPOTENCY_CONFLICT.
Mất phản hồi hoặc 503 không phát sinh khóa mới. UI giữ payload/key, khóa form và cho lookup/gửi lại đúng lệnh.
Đây là trạng thái trong bộ nhớ của form; giữ form mở để giải quyết kết quả chưa xác định.

US-24/25 đã dùng global guard; bổ sung đọc lại account ACTIVE/TRAINER trong transaction trước write ca.
US-27 đã lọc trainer ACTIVE + account ACTIVE/TRAINER; US-28 đã kiểm lại cùng điều kiện trong transaction.
Read lịch sử không lọc bỏ trainer INACTIVE; hủy hỗ trợ US-29 tiếp tục hoạt động theo quyền Staff/Admin.
Không thay đổi chính sách ca/hủy/quota hiện hành.

```mermaid
sequenceDiagram
  actor Admin
  participant UI as /admin/trainers
  participant API as TrainersController + Guards
  participant Service as TrainersService
  participant UOW as IdempotencyService + TransactionRunner
  participant DB as MongoDB replica set
  Admin->>UI: Chọn account PT / sửa chuyên môn, trạng thái
  UI->>API: POST/PATCH + UUID + version khi sửa
  API->>Service: Principal ADMIN + DTO hợp lệ
  Service->>UOW: execute(actor, operation, key, normalized payload)
  UOW->>DB: Tìm kết quả theo actor/operation/key
  alt Đã commit
    UOW-->>UI: Replay HTTP/body gốc (hoặc conflict payload)
  else Lệnh mới
    Service->>DB: Create: ghi security_state, rồi ghi schedule_guards
    Note over Service,DB: Update chỉ ghi schedule_guards; cùng session, không nested transaction
    Service->>DB: Kiểm account/link khi tạo hoặc version/blockers khi sửa
    alt Không hợp lệ / còn lịch chặn
      Service-->>UOW: ApplicationError
      UOW->>DB: Abort toàn bộ
      UOW-->>UI: 400/404/409, giữ input
    else Hợp lệ
      Service->>DB: Ghi profile + trainer_events
      UOW->>DB: Ghi operation_requests, commit
      UOW-->>UI: 201/200 hồ sơ đã commit
    end
  end
```

## Vận hành và kiểm thử

Trước khi mở writer production, dừng writer lịch và chạy `npm run ensure-indexes`, sau đó `npm run seed:access`
trong backend (cấu hình MongoDB/JWT hiện có). Không thêm env/dependency. MongoDB phải hỗ trợ transaction.
Migration preflight account link trùng/mồ côi, specialty/status/version/id và metadata.
Chỉ backfill id=_id, version thiếu=0 và chuẩn hóa số nguyên version hợp lệ về BSON Int32.
Giữ nguyên timestamp/actor/status/specialty đã có; metadata thiếu không được đoán:
`TRAINER_DATA_INVALID: profile/<id>` yêu cầu đối chiếu nguồn lịch sử, bổ sung đúng rồi chạy lại.
Không tự xóa dữ liệu/index hoặc gán một Admin hiện tại làm người tạo hồ sơ cũ.
Production startup kiểm các index trainer/audit tồn tại trước phục vụ API.

UI `/admin/trainers`: list/tìm/lọc/phân trang, chọn account ACTIVE/TRAINER có phân trang từ API users,
form không sửa contact/account link, giữ input khi lỗi, tải lại rõ ràng khi VERSION_CONFLICT,
cảnh báo ngừng nhận lịch, xem/tải lại/lọc/phân trang trở ngại. Account đã liên kết bị server từ chối khi tạo.
Không báo ngừng PT trước commit và không tự hủy lịch. Link hủy hỗ trợ mở trang Admin hiện có.

Truy vết nghiệm thu:

| US-23 TC | Bằng chứng kiểm thử |
| --- | --- |
| TC01–05 | `test/trainers.integration-spec.ts`: HTTP/auth thật, unique index thật, DTO, projection |
| TC06 | API stale version; EN-05 TC10 hai process ghi cùng version |
| TC07/08/12 | API ba nguồn blocker, đang diễn ra và endAt=now; deactivate/reactivate, giữ BOOKED cũ; Vitest form/list/blocker |
| TC04/09 | EN-05 TC10: 20 create cùng account, version race, deactivate vs create/confirm shift/book qua API thật, 10 vòng |
| TC10 | API inject lỗi audit sau insert để kiểm rollback; inject mất response sau commit để lookup/replay đúng key |
| TC11 | Account role/status API US-07/08; regression US-27/28/29 cho locked/inactive, giữ lịch và hủy hỗ trợ |

`npm run test:integration -- --runTestsByPath test/trainers.integration-spec.ts`;
`npm test -- src/features/trainers/trainers.test.tsx` tại frontend.
`npm run test:en05:regression` tại backend lưu commit/dirty flag/source hash, fixture, DB before/after và checkpoints.
Không ghi US-23 hoặc EN-05 Done chỉ từ build/test xanh: nhánh cạnh tranh publish lớp chưa chạy được vì US-66
chưa có writer trong repository. Dữ liệu lớp PUBLISHED được kiểm blocker thật; không tạo writer giả để thay US-66.

US-66 khi triển khai phải kiểm trainer/account trong cùng transaction sau global guard, theo US-23-F04 và US-28-G02,
rồi bổ sung race publish-class/deactivate vào EN-05 TC10 trước nghiệm thu đầy đủ.
