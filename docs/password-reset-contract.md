# US-05 — Khôi phục mật khẩu bằng mã xác thực (UC-07)

Nguồn: `docs/PM/SPRINT3/[GM]Requirement_US-05.docx`, phiên bản 1.0 ngày 27/10/2026; Q04/Q12. Hợp đồng này mô tả UC-07 và các field bổ sung cho mục 4.2.6 của báo cáo. Giữ nguyên mã F01–F06, AC01–AC04 và TC01–TC16 của requirement.

## UC-07 và API công khai

Người quên mật khẩu ở cả bốn vai trò nhập phone hoặc email. Chỉ account ACTIVE có email đã lưu được nhận OTP qua SMTP. Account không tồn tại, không có email hoặc LOCKED nhận cùng phản hồi; **không thông báo công khai tài khoản không tồn tại**, không trả email che một phần, accountId hay trạng thái gửi. Không thay vai trò, không mở khóa và không tự đăng nhập.

| Endpoint | Input | Kết quả |
| --- | --- | --- |
| `POST /api/auth/password-reset/request` | `{identifier,challenge?}` | 202 `{message:"Nếu tài khoản đủ điều kiện, mã xác thực sẽ được gửi đến email đã lưu",challenge}` |
| `POST /api/auth/password-reset/confirm` | `{challenge,otp,newPassword}` | 200 `{message:"Đã cập nhật mật khẩu, vui lòng đăng nhập lại"}` |

Field thừa/sai kiểu (kể cả challenge null) trả 400 VALIDATION_ERROR. Mã sai, hết hạn, bị thay, đã dùng, cạn lượt hoặc snapshot không khớp cùng trả 400 RESET_INVALID. Giới hạn IP trả 429 có Retry-After; DB/cấu hình recovery không sẵn sàng trả 503 SERVICE_UNAVAILABLE. Cả hai route có Cache-Control: no-store. Confirm thành công xóa cookie gym_refresh bằng flags/path US-02, không cấp phiên mới.

## OTP, dữ liệu và cạnh tranh

- OTP chuỗi 6 chữ số bằng crypto, gồm cả số 0 đầu; hạn 10 phút theo expires_at, tối đa 5 lượt. Challenge 32 byte base64url chỉ ở bộ nhớ trình duyệt. Không đưa challenge/OTP vào URL, storage, DB thô, log, operation_requests hoặc notification_outbox.
- `password_resets`: `_id=id`, account_id, token_hash unique, challenge_hash unique, expires_at, used_at?, invalidated_at?, attempts, auth_version_snapshot, **recovery_revision_snapshot Int64**, email_snapshot, created_at. token_hash là HMAC-SHA256(RESET_OTP_PEPPER, challenge|otp), challenge_hash là SHA256. So sánh OTP constant-time. Index `(account_id,created_at)` và TTL expires_at dọn sau 1 ngày; TTL không quyết định hiệu lực mã.
- `accounts`: **recovery_revision Int64 mặc định 0**, recovery_requested_at?, password_changed_at?. Request được chấp nhận tăng revision trong transaction, không tăng auth_version/version. Cooldown ít nhất 60 giây theo account, kể cả đổi giữa phone và email. Flow mới vô hiệu revision trước; resend giữ challenge/record, thay mã/snapshots/hạn và reset attempts. Challenge resend không dùng được vẫn trả 202 echo chính challenge, không thay dữ liệu.
- `auth_rate_limits`: HMAC key theo loại giới hạn và định danh/IP chuẩn hóa, count, window_start, expires_at, unique key và TTL. Mỗi key giữ khung tính từ request đầu tiên; reset khung hết hạn và tăng counter bằng một atomic update, dùng chung giữa instance. Request tối đa 3/định danh/10 phút, 10/IP/10 phút; confirm 20/IP/10 phút. Vượt giới hạn định danh vẫn 202 và không tạo mã.
- Confirm kiểm sơ bộ OTP rồi hash mật khẩu ngoài callback. Transaction EN-02 (snapshot/majority/primary, deadline 10 giây) kiểm lại OTP, hạn, used/invalidated, attempts và account ACTIVE với revision/email/auth_version. Lượt sai và invalidated_at thứ 5 cùng một lệnh trong transaction; trả 400 **sau commit**. Lỗi ghi rollback cả lượt thử và invalidated_at. Resend cạnh tranh buộc đọc/kiểm lại revision sau write conflict.
- OTP đúng ghi used_at, attempts+1 và password_hash, auth_version+1, version+1, recovery_revision+1, password_changed_at/updated_at cùng commit. Access/refresh cũ bị từ chối qua auth_version. Hai confirm đúng chỉ một thành công. US-67 dùng cùng PasswordService/revision, không dùng OTP.
- SMTP chỉ bắt đầu sau commit và sự kiện HTTP finish của phản hồi 202. OTP/email chỉ nằm trong closure tạm; lỗi SMTP ghi mã lỗi an toàn, không retry OTP cũ. Process chết trước gửi có thể mất thư; người dùng chủ động yêu cầu lại sau cooldown.

## Cấu hình và migration

Giữ các biến hiện có trong `backend/.env.example`: RESET_OTP_PEPPER ngẫu nhiên ít nhất 32 byte, khác JWT_ACCESS_SECRET; SMTP_HOST/PORT/SECURE/USER/PASS/FROM. Bật recovery bằng pepper yêu cầu đủ SMTP hợp lệ. Không có pepper hoặc MongoDB standalone thì recovery trả 503 chung.

Sau backup, dừng writer cũ và chạy `cd backend; npm run ensure-indexes`. Migration có thể chạy lại: account thiếu revision nhận BSON Int64 0; revision/snapshot Int32 cũ chuyển sang Int64, giữ nguyên giá trị/timestamps. Field đã có mà sai kiểu hoặc âm làm migration dừng; không tự xóa/sửa giá trị nghiệp vụ. Không có dependency/env/API mới.

## Giao diện và kiểm thử

`/forgot-password` → `/reset-password` dùng React state giữ challenge; countdown 60 giây, resend gửi lại chính challenge và giữ mã đang nhập khi bị giới hạn. Người dùng phải xác nhận bắt đầu lại; có thể hủy và giữ flow. Chặn submit kép, không tự retry khi lỗi. Mất phản hồi confirm hướng dẫn thử đăng nhập bằng mật khẩu mới vì thao tác có thể đã commit. Thành công xóa access/cache và về login.

| AC/TC | Bằng chứng tự động |
| --- | --- |
| AC01, TC01–04, TC15 | `backend/test/password-reset.integration-spec.ts`, `password-reset-standalone.integration-spec.ts` |
| AC02/AC03, TC06–13/15 | `backend/test/password-reset-confirm.integration-spec.ts`, `password-reset-race.integration-spec.ts`; MongoDB replica set và hai app thật |
| AC04, TC01/02/05/14 | `backend/test/password-reset-email.integration-spec.ts`; thư thật qua SMTP sandbox, kiểm HTTP finish, log và lỗi SMTP |
| AC04, TC05/16 | `frontend/src/features/auth/password-reset.test.tsx`; jsdom/HTTP giả lập, không thay thế nghiệm thu trình duyệt thật |

Lệnh kiểm tra: backend `npm run test:integration -- --testPathPatterns=password-reset`, frontend `npm test -- --pool=threads --maxWorkers=1 src/features/auth/password-reset.test.tsx`. Tham chiếu sequence: [password-reset-sequence.mmd](password-reset-sequence.mmd). Kiểm tra bố cục/cookie HTTPS và SMTP triển khai thật riêng trước khi đánh dấu Done toàn bộ.
