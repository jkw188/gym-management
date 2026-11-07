# Tóm tắt cập nhật project: EN-01, US-02, US-06

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

## Kiểm thử và giới hạn

- Đã có test backend cho nền tảng, xác thực và quản lý tài khoản (unit/integration với MongoDB thật), cùng test frontend cho đăng nhập và quản lý tài khoản. Lần cập nhật tài liệu này chưa chạy lại test.
- Đã có README hướng dẫn cấu hình/chạy và sơ đồ Mermaid cho xác thực, quản lý tài khoản.
- Chưa bao gồm đăng xuất, khóa/mở khóa, đổi vai trò, đổi/reset mật khẩu, xóa tài khoản hoặc tự tạo hồ sơ hội viên/PT.

Nguồn đối chiếu: [README](../README.md), source và test hiện có trong `backend/`, `frontend/`.
