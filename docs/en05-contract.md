# EN-05: hợp đồng kiểm thử đồng thời

Nguồn: `docs/PM/SPRINT4/[GM]Requirement_EN-05.docx` phiên bản 1.0.
Không bổ sung API/quyền/UI nghiệp vụ. Chưa đủ điều kiện đánh dấu Done.

## Cách chạy

Cài dependencies theo lockfile bằng `npm ci` tại cả `backend` và `frontend`,
sau đó chạy `npm run test:en05` tại `backend`.
Runner build source hiện tại, khởi tạo MongoDB 8.0.17 replica set tạm bằng
`mongodb-memory-server` (tiến trình mongod thật, WiredTiger), rồi chạy Jest.
Lần đầu cần tải binary mongod; có thể đặt `MONGOMS_DOWNLOAD_DIR` vào cache.

Nếu cung cấp `MONGODB_TEST_URI`, URI phải trỏ tới replica set test riêng với
DB gốc `gym_test_*` tối đa 24 ký tự, khác DB phát triển; `NODE_ENV` phải là
`test` hoặc chưa đặt. Không tự đọc `.env` cá nhân. DB suite có suffix runId,
worker, tên suite và ownership marker; cleanup kiểm tên và marker trước khi xóa.
Không truyền URI production hoặc dùng DB cá nhân làm DB test.

`jest.en05.config.cjs` chạy riêng, không thuộc CI nhanh. Job
`.github/workflows/en05.yml` chạy hai process/DB thật và giữ bằng chứng kể cả
khi fail. PR/push chạy `npm run test:en05:regression`: vẫn chạy đủ ma trận khả dụng,
10 vòng và toàn bộ oracle, chỉ chấp nhận đúng phạm vi chưa triển khai đã công bố
(TC07/08/10 BLOCKED, TC13 PARTIAL). Assertion lỗi, thiếu vòng, thiếu DB evidence,
TC khác bị BLOCKED/PARTIAL hoặc lỗi runner/client đều làm check fail.

Lệnh `npm run test:en05` giữ nguyên cổng nghiệm thu đầy đủ. Chạy thủ công workflow
với `full_acceptance=true` để dùng cổng này trên GitHub. Không dùng
`continue-on-error`, không đổi TODO thành PASSED, không có tùy chọn giảm số vòng.

## Harness và oracle

- Hai Node child process đều bootstrap AppModule, HTTP config, JWT/session/Guard
  thật; cổng loopback ngẫu nhiên, connection độc lập, cùng DB. Login/session
  riêng trên mỗi process. Không override Guard và không có mutex chia sẻ.
- Mỗi TC chạy được có 10 vòng, batch tranh slot/quota có 20 request chia đều
  hai app. Client barrier và IPC hook ngay trước DataGuardsService.acquire
  giúp tái hiện race; đảo thứ tự gửi qua từng vòng.
- ServerClock cố định `2035-11-14T17:00:00Z` (00:00 VN), toàn bộ kỳ/giờ fixture
  tương đối mốc này. Ngưỡng hủy và retry qua mốc không sleep theo giờ thật.
  Writer ca làm việc dùng ServerClock có sẵn thay vì gọi trực tiếp Date.now.
- Sau mọi request settled và resolve unknown outcome cùng key (tối đa ba
  lần lookup/replay), oracle đọc DB majority: kiểm overlap từng cặp PT/member,
  ca còn hiệu lực, lớp PUBLISHED và lớp-booking; quota snapshot/used/BOOKED;
  owner, period, liên kết ca/gói; unique key/event/audit, recipient/outbox mồ côi.
  BOOKED quá giờ vẫn reserved. Không dùng availability để xác định số thắng.
  Fixture và dữ liệu sau batch được hydrate/validate bằng chính Mongoose model
  của ứng dụng; duration snapshot khớp kỳ, mã hội viên theo schema hiện hành.
- Lỗi test-only được inject **sau** insert booking/audit/recipient/outbox/key
  bằng wrapper repository trong child test; so sánh DB và revision trước/sau.
  Retry dùng nhãn TransientTransactionError thật của Mongo driver. TC16 hủy
  socket HTTP tại response.end sau commit rồi lookup/replay cùng key.
- TC17 ngắt process sau khi socket client đã nhận emit và trước mark DONE;
  hết lease bằng fixture DB, worker còn lại replay cùng notification id;
  kiểm sync/inbox một event. Runner chạy thêm Vitest NotificationFeed hiện có
  để chứng minh client gộp socket/REST/reconnect, lưu kết quả `client.json`.
- Không bật worker định kỳ/email ra ngoài; chỉ chạy worker thật bằng IPC khi
  TC17 yêu cầu. Hook chỉ nằm trong `scripts/en05-app.cjs`, yêu cầu NODE_ENV=test,
  EN05_CHILD=1, DB test và IPC; production main không import hoặc mở HTTP hook.
- US64 đã có endpoint thật: TC20 dùng endpoint complete hiện tại thay adapter
  fixture S07, cạnh tranh với cancel hỗ trợ và settlement nâng cấp US16.

## Truy vết và giới hạn hiện tại

| TC | Phạm vi | Trạng thái phụ thuộc |
| --- | --- | --- |
| TC01–TC05 | Slot/quota/member, idempotency/replay/payload khác | Writer hiện có |
| TC06 | Create/update ca chồng, tự sửa, tiếp giáp, giữ bản cũ khi thất bại | Writer US24 |
| TC07 | Publish hai lớp/sửa PUBLISHED chồng | BLOCKED: US66 chưa có writer |
| TC08 | Publish lớp cạnh tranh booking | BLOCKED: US66 chưa có writer |
| TC09 | Cancel ca cạnh tranh booking | Writer US25/28 |
| TC10 | Deactivate PT cạnh tranh create ca/publish/book | BLOCKED: TrainersModule chưa có writer, US66 còn thiếu |
| TC11–TC12 | Hủy 20 lệnh/actor/key, hủy cạnh tranh đặt quota1 | Writer US29/28 |
| TC13 | US16 tạo nâng cấp/settlement cạnh tranh đặt/hủy, replay settlement | PARTIAL: US20 chưa có ownership adapter/API self-service |
| TC14 | 120 phút, 119 phút 59 giây, retry qua mốc | Server clock trong callback |
| TC15–TC16 | Rollback sau từng insert, mất response sau commit | Hook executable test-only |
| TC17 | Offline, worker crash sau emit, inbox/DB/client dedupe | Worker/socket thật + Vitest client |
| TC18 | Lớp phủ một phần, tiếp giáp, slot60, kỳ tương lai/ngày cuối VN | Lớp là fixture hợp lệ, không thay writer US66 |
| TC19 | Session/role thu hồi, foreign id, projection public/private | HTTP/JWT/session thật |
| TC20 | Completion/cancel/upgrade, used tăng tối đa một | Endpoint US64 thật |

TC07/08/10 được ghi BLOCKED, TC13 ghi PARTIAL; không dựng writer giả để đạt.
Khi bổ sung dependency cần thay các khai báo BLOCKED bằng race thật, bổ sung
nhánh self-service TC13 rồi chạy đủ ma trận. Không suy ra nghiệm thu toàn bộ
US64 từ EN05. Các AC01–04 chỉ đạt khi đủ TC liên quan, không có BLOCKED/PARTIAL.

## Bằng chứng và mã thoát

`artifacts/en05-<runId>/` có `environment.json`, `processes-indexes.json`,
`cases.json` (DB before/after/checkpoints, request status/outcome, số vòng,
thời gian, assertion), `client.json`, `summary.json` và `report.md`.
Metadata ghi commit, dirty flag, SHA256 source/harness, runId/seed, clock và phiên bản runtime/DB/app.
Log/report không có token, password, URI credential hoặc contact fixture.

Trong mode nghiệm thu mặc định, mã thoát 0 chỉ khi tất cả TC01–TC20 PASSED,
đủ 10 vòng và client test đạt.
Còn dependency thiếu hoặc assertion lỗi thì mã thoát 1, acceptance NOT_ACCEPTED,
kể cả khi các test Jest khả dụng đã xanh. Dùng report thật để liên kết runId/
commit vào Excel phân công; không đánh Done khi chưa đủ bằng chứng.

Trong mode regression, mã thoát phản ánh hồi quy của phạm vi đã triển khai;
`summary.json` vẫn tách `regression` và `acceptance`, ghi danh sách `incomplete`.
Kết quả NOT_ACCEPTED và các TC thiếu được đưa vào GitHub Step Summary ngay cả
khi check hồi quy xanh. Khi các dependency hoàn tất, bỏ ngoại lệ tương ứng trong
`scripts/test-report.cjs` và bổ sung race thật trước khi tuyên bố EN05 Done.

EN04 dùng cùng bộ đọc báo cáo: test fail/skip hoặc thiếu file S01 bắt buộc vẫn
làm gate fail; TODO của sprint sau được đếm riêng, TODO trong file S01 bắt buộc
không được chấp nhận. Test migration US15/16 gọi CLI bất đồng bộ để event loop
tiếp tục đọc pipe log của mongod; tránh timeout Linux do `spawnSync` chặn pipe.
