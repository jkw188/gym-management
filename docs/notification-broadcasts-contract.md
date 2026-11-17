# US-48 / UC-37 — Gửi thông tin vận hành đến nhóm tài khoản

Nguồn: `PM/SPRINT7/[GM]Requirement_US-48.docx` v1.0; phụ thuộc US-02, EN-02, EN-03 và US-47.
Tài liệu này bổ sung hợp đồng S07 cho EN-03-F02/F06/F07, không đổi đối tượng nhận của các sự kiện bán gói/booking ở sprint trước.

## Use case UC-37

Actor: ADMIN có quyền cố định `notifications.broadcast`, tài khoản ACTIVE và phiên hợp lệ.

1. Mở `/admin/notifications/new`, chọn ALL_ACTIVE hoặc tập vai trò ROLES, nhập title/body.
2. Preview lưu một nháp DB, trả nội dung nguyên văn, nhóm, số tài khoản, snapshotAt, expiresAt và version.
3. Admin kiểm tra rồi bấm **Xác nhận Gửi**. Backend đọc lại toàn tập ACTIVE trong snapshot của transaction.
4. Nếu digest/phiên bản/hạn hợp lệ và nhóm không rỗng, lưu event, recipients, outbox, trạng thái SENT và operation cùng session.
5. Sau commit UI chuyển sang `/admin/notifications/:id`, hiển thị “Đã lưu cho N tài khoản”. `/admin/notifications` lọc lịch sử và phân trang.

Nhánh lỗi: PREVIEW_STALE yêu cầu preview mới; AUDIENCE_EMPTY chặn gửi; foreign preview trả 404 khi send; SENT với key mới trả BROADCAST_ALREADY_SENT.
Admin có quyền được xem lịch sử/chi tiết của các broadcast; chỉ người tạo được send preview. Không có API nhận accountId, email hay room tùy ý.

## API / OpenAPI

DTO và Swagger nằm trong `backend/src/modules/notifications/notification-broadcast.dto.ts` và controller cùng module.

| Endpoint | Input | Kết quả |
|---|---|---|
| POST `/api/admin/notification-broadcasts/preview` | `{audience,roles?,title,body}` | 201 `{previewId,version,expiresAt,snapshotAt,recipientCount,audienceSummary,title,body}` |
| POST `/api/admin/notification-broadcasts/:id/send` | `{version}`, UUID v4 Idempotency-Key | 200 `{broadcastId,notificationId,status:"SENT",recipientCount,dispatchStatus:"READY"}` |
| GET `/api/admin/notification-broadcasts` | status?, fromDate?, toDate?, page=1, limit=20 (tối đa 100) | `{items,page,limit,total,totalPages,asOf}` |
| GET `/api/admin/notification-broadcasts/:id` | ObjectId | Nội dung, snapshot, counts, dispatchStatus, asOf; không có account/contact |

Khoảng ngày Việt Nam mặc định 30 ngày đến hôm nay, tối đa 366 ngày, bao gồm hai đầu; truy vấn MongoDB dùng `[đầu ngày đầu, đầu ngày sau ngày cuối)` theo UTC+07:00. Sắp createdAt DESC, id DESC; trang rỗng totalPages=0. Các số liệu trong một response được đọc cùng snapshot transaction.

title/body trim, giới hạn 190/2000 và từ chối ký tự điều khiển kể cả newline/tab. HTML-like input là văn bản nguyên trạng, React render text; không template, attachment hoặc URL đích. ALL_ACTIVE không kèm roles; ROLES bắt buộc tập không rỗng trong ADMIN/STAFF/TRAINER/MEMBER, loại trùng và sắp xếp.

## MongoDB / tính nguyên tử

`notification_broadcasts`: `_id,created_by,audience,roles,title,body,recipient_digest,recipient_count,preview_expires_at,version,status,notification_id?,created_at,sent_at?`.

- PREVIEW version=0, hết hạn sau đúng 5 phút; chưa tạo notification/recipient/outbox.
- SHA-256 chốt audience/roles/title/body và toàn tập `[account._id,role_id,role.code]` đã sắp ID. Drift trong cùng nhóm vẫn bị phát hiện nếu account đổi vai trò.
- Send tái đọc đồng hồ và điều kiện mỗi callback EN-02, dùng snapshot/majority/primary và deadline 10 giây.
- Event `BROADCAST:<broadcastId>`; persistBusinessEvent EN-03 cấp sequence Int64 và tạo outbox READY.
- Cập nhật PREVIEW/version=0 → SENT/version=1 có điều kiện. Cùng transaction ghi operation `NOTIFICATION_BROADCAST_SEND`, hash targetId/version. Replay trước kiểm version hiện tại; quyền luôn kiểm trước replay.
- Không fan-out từng phần. Lỗi một bước hoặc vượt giới hạn transaction rollback tất cả; không báo thành công một phần. Không thêm queue/transaction lồng nhau.
- Index `(created_by,created_at DESC)`, `(created_at DESC,_id DESC)`, unique partial notification_id kiểu ObjectId; giữ các unique event_key, sequence, recipient và operation EN-02/03.

Trước khởi động production chạy `npm run ensure-indexes` tại backend. Không chuyển dữ liệu cũ; collection mới được tạo cùng indexes. Không TTL xóa nháp/lịch sử. Không thêm env/dependency.

## Bổ sung hợp đồng chung EN-03 trong S07

- Mọi vai trò hiện hành được dùng `/api/notifications/sync` và socket `/notifications` nếu có recipient; chỉ account ACTIVE/phiên hợp lệ. Việc mở transport này không cấp quyền inbox US-47: `/api/me/notifications*` vẫn chỉ MEMBER.
- Socket lưu account/vai trò từ handshake, kiểm lại trước emit/ack; đổi vai trò khiến socket cũ bị ngắt. Quy trình US-02 đổi role cũng thu hồi phiên theo auth_version. Recipient lịch sử không thay sau gửi; không thêm account mới sau commit.
- Worker EN-03/lease/retry vận hành giữ nguyên eventKey. SENT = dữ liệu đã lưu; DONE = hoàn tất lượt dispatch; delivered = recipient có delivered_at sau ack; read = recipient có read_at do US-47.
- UI dùng feed chung với dedupe/cache theo account; Staff/PT/Admin nhận toast, Member dùng inbox. Không tự mark-read khi nhận toast.
- Khi mất response/503, UI giữ `{actorId,id,version,key}` trong sessionStorage (không nội dung/token), khóa soạn lệnh mới và cho lookup hoặc retry đúng key kể cả sau tải lại trang. Logout/đổi account xóa khóa của account cũ. Trình duyệt chặn sessionStorage thì chỉ giữ khóa trong bộ nhớ màn hình.
- Không thêm source_type/source_id hoặc đường dẫn đích: không có điều hướng theo nguồn trong US-48. Truy vết dùng event_key hiện có.

## Truy vết kiểm thử

| Yêu cầu | Bằng chứng tự động |
|---|---|
| AC01 / TC01–04 | `backend/test/notification-broadcast.integration-spec.ts`: DTO, nhóm ACTIVE, dedupe, foreign/role/session, expiry/status/role/new-account/content/version drift |
| AC02 / TC05–08 | Cùng suite: 20 request trên hai instance, replay/conflict/lookup, lỗi sau ghi recipients/counter/outbox rollback toàn bộ |
| AC03 / TC09–12 | Cùng suite: offline DONE/sync, ack/read counts, giữ lịch sử, sync Admin/Staff/inbox 403; hồi quy `notifications-realtime`, `notifications-outbox*`, `notification-inbox*` |
| UI / TC12 | `frontend/src/features/notifications/broadcasts.test.tsx`: text HTML, sửa cần preview lại, stale/empty/expired, unknown/lookup/retry cùng key, đổi account |

Sequence: `notification-broadcasts-sequence.mmd`. Không suy kết quả pass từ bảng truy vết; dùng output thực tế của lệnh test. Không tự commit/merge/deploy để đóng DoD.
