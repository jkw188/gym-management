# Tóm tắt cập nhật project: EN-01, US-02, US-06, US-07, US-08

## EN-01 — Nền tảng dùng chung

- Thiết lập frontend React + TypeScript (Vite), backend NestJS và kết nối MongoDB/Mongoose theo kiến trúc Modular Monolith.
- Bổ sung kiểm tra biến môi trường, CORS, validation DTO, định dạng lỗi thống nhất và request ID.
- Xây dựng schema tài khoản/vai trò, chuẩn hóa tên–điện thoại–email, index chống trùng và băm mật khẩu Argon2id.
- Thêm lệnh tạo index, seed bốn vai trò và tài khoản Admin; API health live/ready, giao diện kiểm tra kết nối và Swagger cho dev/test.

## US-02 — Đăng nhập và phân quyền

- Đăng nhập bằng số điện thoại/mật khẩu; hỗ trợ ADMIN, STAFF, TRAINER (PT), MEMBER và điều hướng theo vai trò.
- Bổ sung API `POST /api/auth/login`, `POST /api/auth/refresh`, `GET /api/auth/me`; xác thực JWT/Passport và phân quyền RBAC ở backend.
- Quản lý phiên bằng collection `auth_sessions`; access token tối đa 15 phút, refresh cookie HttpOnly và phiên có hạn tuyệt đối 7 ngày. Refresh token được xoay vòng bằng cập nhật nguyên tử.
- Thêm giới hạn lượt đăng nhập, kiểm tra trạng thái tài khoản/hiệu lực phiên; frontend khôi phục phiên khi tải lại, bảo vệ route và chỉ giữ access token trong bộ nhớ.

## US-06 — Quản lý tài khoản

- Bổ sung màn hình `/admin/users` và API `/api/users` chỉ dành cho Admin: danh sách, chi tiết, tạo và sửa tài khoản; API `/api/users/roles` cung cấp các vai trò đã seed.
- Hỗ trợ tìm theo tên/điện thoại/email, lọc vai trò/trạng thái và phân trang; form có kiểm tra dữ liệu, trạng thái tải và thông báo lỗi.
- Kiểm tra trùng điện thoại/email bằng unique index; cập nhật theo `version` để ngăn ghi đè khi sửa đồng thời.
- Chỉ cho sửa họ tên, điện thoại, email; thay đổi điện thoại/email tăng `auth_version` để vô hiệu hóa phiên cũ, chỉ sửa tên giữ phiên.

## US-07 — Khóa/mở khóa tài khoản

- API `PATCH /api/users/:id/status` chỉ cho Admin, nhận trạng thái đích, version và lý do; hộp thoại trên `/admin/users` yêu cầu xác nhận và cảnh báo khi tự khóa.
- `AccountSecurityService` ghi chung `security_state.revision` để tuần tự hóa thay đổi status/role qua nhiều instance; kiểm lại actor/session và bảo vệ Admin ACTIVE cuối cùng trong transaction snapshot/majority, deadline retry 10 giây.
- Account tăng version/auth_version và ghi `security_events` cùng commit; no-op không ghi account/audit, stale version luôn 409. Mở khóa không phục hồi token cũ; không sửa dữ liệu PT, membership, booking hoặc đơn hàng.
- `ensure-indexes` khởi tạo document khóa có thể chạy lại và tạo hai index audit. Replica set bắt buộc cho US-07/08; README mô tả môi trường EN-04 và hợp đồng service dùng chung US-08. API/giao diện đổi role được bổ sung tại US-08 bên dưới.
- Kiểm thử US-07 dùng mongod thật, hai Nest app/connection, Guard/session/index thật; có lock/lock, lock/role, role/role, rollback audit/trước commit, transient retry, unknown commit deadline, thiếu khóa và mất DB. Frontend kiểm tra self-lock, pending, 409, mất response và GET đối chiếu không tự refresh/replay.

## US-08 — Gán vai trò và thu hồi quyền (UC-29)

- Thêm `GET /api/access/roles` dành cho Admin và `PATCH /api/users/:id/role` với roleCode, version, reason. US-06 giữ endpoint role code/name và cấm đổi role trong PATCH thông tin chung.
- Danh mục quyền S01 và decorator cùng nguồn `access.policy.ts`; collection permissions/role_permissions có unique index theo báo cáo. Lệnh `seed:access` upsert bốn role và mapping, không sửa account, không seed trong API. Catalog thiếu/lệch trả 503; runtime giữ RolesGuard đọc role hiện hành, không cấp quyền tùy ý từ DB/JWT.
- AccountSecurityService tái sử dụng khóa/transaction US-07, kiểm liên kết members/trainers trong cùng session, chặn ROLE_IN_USE và Admin ACTIVE cuối cùng. Đổi thật tăng version/auth_version và audit CHANGE_ROLE cùng commit; giữ LOCKED, thu hồi token cũ, không tạo profile/membership. Role hợp lệ nhưng thiếu seed trả ROLE_NOT_CONFIGURED.
- `/admin/users` có hộp thoại Phân quyền: ma trận cố định, một role, lý do và xác nhận tác động thu hồi phiên. 409 giữ lựa chọn, chỉ cho gửi sau tải lại/xác nhận; mất response không tự replay; tự hạ quyền xóa auth về login.
- README, bảng UC-29 trong báo cáo và Mermaid sequence/class được đối chiếu. US-09/23 phải dùng cùng khóa/transaction khi tạo/link profile; role MEMBER/TRAINER không thay kiểm tra hồ sơ/membership.

## Kiểm thử và giới hạn

- Trong lần triển khai US-08 đã chạy 5 suite / 96 unit test backend và 6 suite / 111 integration test liên quan xác thực, logout, profile, US-06/07/08; toàn bộ 13 suite / 201 test frontend đạt. Typecheck source/test backend, typecheck frontend và build hai ứng dụng đạt. Đây là kiểm tra tự động local, không thay thế nghiệm thu trình duyệt/hosting thật; chưa chạy lại toàn bộ integration của các module ngoài phạm vi.
- Đã có README hướng dẫn cấu hình/chạy và sơ đồ Mermaid cho xác thực, quản lý tài khoản.
- US-08 đã bổ sung API đổi vai trò; không mở API xóa tài khoản hoặc tự tạo hồ sơ hội viên/PT.

Nguồn đối chiếu: [README](../README.md), source và test hiện có trong `backend/`, `frontend/`.
