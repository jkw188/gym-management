# Gym Management

Bộ khung dự án: React + TypeScript (Vite), NestJS + TypeScript.

## Yêu cầu

- Node.js 24.x và npm.
- Hai terminal mở tại thư mục `gym-management`.
- Hai ứng dụng có package.json và package-lock.json riêng; không chạy npm install ở thư mục gốc.

## Chạy backend — Terminal 1

```sh
cd backend
npm ci
```

Sao chép `.env.example` thành `.env` (PowerShell: `Copy-Item .env.example .env`; macOS/Linux: `cp .env.example .env`).

```sh
npm run start:dev
```

Backend chạy tại http://localhost:3000, tiền tố API là `/api`.
Chưa tạo controller nên truy cập `/` hoặc `/api` sẽ trả 404; đây là hành vi dự kiến.

## Chạy frontend — Terminal 2

```sh
cd frontend
npm ci
```

Sao chép `.env.example` thành `.env`, sau đó:

```sh
npm run dev
```

Mở http://localhost:5173. `VITE_API_BASE_URL` được chuẩn bị cho API client ở bước sau; trang khởi tạo chưa gọi backend. Không đặt bí mật trong biến VITE_* vì chúng được công khai trong frontend.

## Build

Chạy `npm run build` riêng trong `frontend` và `backend`.
Chạy `npm run typecheck` trong từng ứng dụng để kiểm tra TypeScript.
Backend sau build: `npm run start:prod`. Frontend xem thử build: `npm run preview` (không phải server production).

## Phạm vi bộ khung

- Giữ đầy đủ các thư mục theo cấu trúc đã thống nhất; `.gitkeep` giúp Git giữ thư mục trống.
- 13 NestJS module được khai báo và import trong AppModule.
- Chưa có nghiệp vụ, controller, service, DTO, schema, xác thực, phân quyền hoặc dữ liệu mẫu.
- MongoDB sẽ được tích hợp ở bước thiết kế persistence; hiện chưa có kết nối database hay yêu cầu chạy MongoDB.
- `backend/test` để dành cho kiểm thử; chưa thiết lập test runner và chưa có bài test.
- Không bao gồm `node_modules`, `dist` hoặc file `.env` thực tế.

## Quy ước thư mục

Frontend: `api` chứa API client; `components` chứa UI dùng chung; `features` nhóm theo nghiệp vụ; `hooks` chứa custom hook; `layouts` chứa bố cục; `pages` chứa trang; `routes` chứa định tuyến; `types` chứa kiểu dùng chung; `utils` chứa hàm tiện ích.

Backend: `config` chứa cấu hình; `common` chứa decorators, guards, filters, pipes dùng chung; `modules` chứa auth, users, members, memberships, trainers, bookings, workouts, products, orders, inventory, payments, notifications, reports.

`docs` chứa báo cáo, yêu cầu, UML và thiết kế MongoDB khi bổ sung ở các bước tiếp theo.

## Tài liệu chính thức

- https://react.dev/learn
- https://vite.dev/guide/
- https://docs.nestjs.com/v11/first-steps
- https://www.typescriptlang.org/docs/

Bộ khung chọn NestJS 11 và Vite 7; package-lock.json cố định dependency đã cài để có thể dùng npm ci.
