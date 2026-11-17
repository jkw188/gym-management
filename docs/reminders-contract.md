# US-49 / UC-13, UC-37 — Tự nhắc gói và lịch PT

Nguồn: `PM/SPRINT7/[GM]Requirement_US-49.docx` v1.0 (06/11/2026), Q09/Q13. Phụ lục triển khai S07 cho EN-03-F02/F05/F06/F07 và US-47-F05; giữ mã truy vết và hợp đồng lịch sử của các sprint trước.

## Use case và Q13

Actor SYSTEM là worker DI nội bộ, không có HTTP endpoint kích hoạt/nhận actor hoặc clock. HTTP server chạy worker ngay sau listen, tick mặc định 60 giây, tối đa 50 candidate/lượt, đóng app thì tắt timer. CLI/application context không tự chạy timer.

| Nguồn/mốc | dueAt giờ Việt Nam | Cửa sổ hữu ích `[dueAt, until)` |
|---|---|---|
| Membership 3D | 00:00 endDate−3 | Trước 00:00 endDate−1 |
| Membership 1D | 00:00 endDate−1 | Trước 00:00 endDate+1 |
| Booking 24H | startAt−24 giờ | Trước startAt−2 giờ |
| Booking 2H | startAt−2 giờ | Trước startAt |

endDate bao gồm ngày sử dụng. Calendar date theo Asia/Ho_Chi_Minh, không theo host. Membership ACTIVE, transaction SETTLED GYM/PT, startDate≤ngày xử lý≤endDate; membership.created_at và transaction.settled_at phải có và ≤dueAt. Thiếu timestamp không suy đoán đã tồn tại tại mốc. Booking BOOKED và created_at≤dueAt; cửa sổ đảm bảo startAt>now. Chỉ ghi quyết định terminal khi đến dueAt. Quá cửa sổ ghi SKIPPED_STALE, không dồn hai nhắc cũ.

US-15/16/19/20: ngày/chủ gói ở service_sales, loại/settled_at/trạng thái thu ở transactions, trạng thái quyền/supersession ở memberships. Không nhân bản end_date/member_id vào membership. Có kỳ ACTIVE cùng member/kind, transaction SETTLED và bao phủ endDate+1 thì suppress kỳ cũ, kể cả kỳ nối chưa tới ngày dùng; PENDING không suppress. Kỳ nối có mốc riêng. SUPERSEDED/CANCELLED không nhắc.

## Transaction và gates

Candidate query đọc nguồn thật, anti-join occurrence trước limit; không quét riêng phút hiện tại và không tạo bản sao lịch nghiệp vụ. Mỗi candidate/milestone một TransactionRunner EN-02, snapshot/majority/primary, driver retry theo nhãn trong deadline 10 giây. Lỗi một nguồn không dừng nguồn khác; tick sau retry nguồn chưa commit (mặc định 60 giây), đọc lại clock/điều kiện ở mỗi callback.

- Membership: đọc để xác định owner → tăng members.service_revision thật → tái đọc membership/sale/transaction/continuation/link.
- Booking: tăng schedule_guard → tìm owner → tăng member gate → tái đọc booking/start/created/status/owner/PT/link. Cancel/complete/correct dùng schedule→member; upgrade chỉ cần member, không quay lại schedule. Link US-09 ghi cùng member gate. Giữ thứ tự S06-O01; notification counter sau các khóa nguồn.
- STORED: notification, recipients, outbox và occurrence chung session. Lỗi bất kỳ bước nào rollback tất cả. Không dispatch socket bên trong transaction. SKIPPED_STALE/INELIGIBLE là terminal có reason; chưa due thì không ghi terminal.
- Key `MEMBERSHIP_REMINDER:<membershipId>:<3D|1D>` hoặc `PT_REMINDER:<bookingId>:<24H|2H>`, ≤120 ký tự. Upgrade giữ booking ID nên không phát lại milestone đã commit.
- Account MEMBER đang liên kết là recipient; booking thêm account PT; EN-03 dedupe. Không linked thì vẫn lưu event rỗng hoặc chỉ PT, reason NO_LINKED_ACCOUNT; link về sau không thêm recipient lịch sử. LOCKED có thể có recipient nhưng auth hiện hành vẫn chặn sync/emit/ack.
- Cancel commit trước thì skip; reminder commit trước thì giữ lịch sử, thông báo hủy sau làm rõ. Không thu hồi nội dung đã đến thiết bị. Không tự thu tiền/gia hạn/cancel/complete hoặc thêm email/SMS.

## MongoDB và migration

`reminder_occurrences`: source_type MEMBERSHIP/PT_BOOKING, source_id, milestone, event_key, due_at, status STORED/SKIPPED_STALE/SKIPPED_INELIGIBLE, reason_code?, notification_id?, source_snapshot, created_at. Snapshot chỉ ID nội bộ, tên/ngày gói hoặc giờ/PT/địa điểm; không contact, ngân hàng, sức khỏe.

Unique `(source_type,source_id,milestone)` và `event_key`; giữ unique notification eventKey/recipient EN-03. Index nguồn `(end_date,member_id,_id)` trên service_sales vì ngày được chuẩn hóa ở sale; `(status,start_at,_id,created_at)` trên pt_bookings. Giữ membership.service_sale_id và các index trạng thái/chủ nguồn hiện có. Không TTL occurrence/notification để gửi lại.

`npm run ensure-indexes` thêm collection/index, chạy lặp được, không xóa lịch sử hoặc đoán timestamp. Production kiểm index lúc startup; dev/test tự tạo. Dừng writer cũ/sao lưu trước migration production theo EN-02; MongoDB phải là replica set.

## Bổ sung hợp đồng chung EN-03 / US-47 và OpenAPI

Notifications thêm field tùy chọn `source_type`, `source_id`, `due_at`. `persistBusinessEvent` nhận `sourceType?`, `sourceId?`, `dueAt?`; replay eventKey giữ body/recipient cũ. Notification lịch sử không cần chuyển dữ liệu.

`notification.created`, item của `GET /api/notifications/sync` và `GET /api/me/notifications/:id` thêm tùy chọn:

```json
{"source":{"type":"MEMBERSHIP","id":"0123456789abcdef01234567","dueAt":"2026-11-06T17:00:00.000Z"}}
```

Chỉ hai loại nguồn allowlist, mã ObjectId và timestamp, không URL. Swagger response nằm ở NotificationsController/NotificationInboxController. Inbox list/count/read và quyền endpoint giữ nguyên; không thêm endpoint SYSTEM.

React Member mở inbox/detail rồi mark-read như US-47; link dẫn tới trang gói hiện tại/lịch sử hoặc lịch PT hiện có. PT nhận toast/sync và link tới buổi dạy. Trang đích tiếp tục đọc API kiểm auth/owner, dùng bộ lọc/phân trang hiện hành; mã nguồn trong body dùng đối chiếu. Body/HTML/URL chỉ render text. Thông báo lịch sử không cấp quyền hoặc tự thực thi nghiệp vụ.

EN-03 tiếp tục sở hữu sequence, lease/retry/DEAD, delivered/read và recipient authorization. `npm run retry-notification -- <eventKey>` giữ cùng notification/occurrence. Realtime nhiều instance giữ giới hạn EN-03: không thêm Redis/adapter; durable REST sync và DB dedupe phục vụ các instance.

## Cấu hình, vận hành và truy vết test

`REMINDER_TICK_MS=60000` (số nguyên 1000–60000), `REMINDER_BATCH_SIZE=50` (1–50); timezone cố định Asia/Ho_Chi_Minh. Không dependency mới. Test override ServerClock qua DI, production không nhận override từ API.

Log sau commit gồm requestId, eventKey, sourceId, dueAt, outcome, reason, lagMs; log mỗi batch có stored/skipped/failed/existing và max lagMs. Không raw error/token/contact. Đây là counter mỗi batch, không ghi SENT trước khi notification tồn tại.

| AC/TC | Bằng chứng tự động |
|---|---|
| AC01 / TC01–05,16 | reminder-policy.spec.ts và reminders.integration-spec.ts: due/window, ngày VN, GYM/PT, created/settled, trạng thái, recipient thiếu link/PT/dedupe |
| AC02 / TC06–10,15 | Integration: catch-up/stale, nối kỳ SETTLED/PENDING, cancel thật/cạnh tranh gate, COMPLETED, upgrade giữ ID/snapshot, không hồi tố link |
| AC03 / TC11–14 | Hai instance 20 callback, rollback notification/outbox và nguồn khác tiếp tục, crash lease/DEAD retry, REST isolation, socket lock/logout trước emit/ack |
| UI và hồi quy | reminders.test.tsx: route allowlist; inbox/notifications/broadcasts; backend notifications-realtime/outbox/inbox-api, cancel-race/renewals/upgrades |

Sequence: [reminders-sequence.mmd](reminders-sequence.mmd). Kết quả lệnh thực tế được báo trong phản hồi triển khai; không coi build là bằng chứng mọi AC đã đạt.
