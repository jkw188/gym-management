# US-16 / UC-22 — Nâng cấp gói tại quầy

Nguồn: `docs/PM/SPRINT3/[GM]Requirement_US-16.docx`, v1.0 ngày 27/10/2026; Q05/Q08/Q09. Giữ nguyên F01–F07, D01–D04, AC01–AC04, TC01–TC17. Không sửa chính sách US-12, REGISTER_V1 hoặc RENEW_V1.

## UC-22 và hợp đồng API

Staff/Admin chọn kỳ CURRENT của hội viên từ lịch sử, chọn đích theo cạnh policy ACTIVE, xem báo giá rồi xác nhận. Có phí tạo PENDING và thu qua US-21/22; phải thu0 hoàn tất ngay với chứng từ0, không payment0. Chỉ lúc commit hoàn tất mới thay gói và chuyển BOOKED; kỳ nguồn và lịch sử không bị ghi đè.

| Endpoint | Hợp đồng |
| --- | --- |
| `GET /api/service-upgrades/targets?memberId=&sourceMembershipId=` | STAFF/ADMIN; nguồn hiện hành với version và snapshot quyền lợi; danh sách đích/policy ACTIVE cùng kind, phiên bản và điều khoản. Reader bổ sung để Staff chọn policy mà không cấp quyền API quản trị US-12 |
| `POST /api/service-upgrades/preview` | `{memberId,sourceMembershipId,sourceVersion,targetPlanId,targetPlanVersion,policyVersion}` → quote + quotaSummary, canProceed/blockingCode?; chỉ đọc snapshot, không giữ giá |
| `POST /api/service-upgrades` | Cùng input, UUIDv4 Idempotency-Key, SALE_UPGRADE →201 SaleResult operation UPGRADE, sourceMembershipId, previousSaleId, quote, carriedSessionsUsed và các ID đã có |
| Đọc/thu/hủy | Dùng GET service-sales/:id; POST transaction payment-preview/confirm-payment; POST service-sales/:id/cancel với SALE_CANCEL, version/lý do US-14 |

Quầy luôn channel COUNTER, actor lấy từ phiên đăng nhập. Không nhận giá/credit, ngày báo giá/start/end, status/channel hoặc audit từ client. US-20 phải thêm adapter ownership rồi gọi cùng UpgradeService với SELF_SERVICE; chưa mở endpoint Member trong US-16. SALE_UPGRADE hash gồm actor, channel và input chuẩn hóa; lookup/replay cùng actor/key/payload không thực thi chuyển gói lần hai. Lookup404 giữ nguyên key vì request có thể chưa hoàn tất.

Lỗi theo EN01-D03: input/key400; phiên401; vai trò403; nguồn không tồn tại/khác member404; nghiệp vụ409; DB503. Nguồn/version/policy/plan sai trả SOURCE_NOT_CURRENT, SOURCE_CHANGED, FUTURE_PERIOD_EXISTS, POLICY_NOT_ALLOWED/POLICY_CHANGED, PLAN_CHANGED/PLAN_NOT_AVAILABLE. Pending/quota/lịch/hạn đề nghị dùng PENDING_SALE_EXISTS, QUOTA_INSUFFICIENT, BOOKING_CONFLICT, QUOTE_EXPIRED. Preview có thể trả canProceed=false cho pending/quota/booking; tạo/settle từ chối409, không ghi khoản thu.

## Nguồn và giá trị khấu trừ

Nguồn phải membership ACTIVE của đúng member, transaction SETTLED, sale cùng loại GYM/PT và start≤hôm nay VN≤end. Có kỳ SETTLED/ACTIVE tương lai cùng kind thì chặn, không tự hủy chuỗi. SourceVersion phát hiện form cũ khi tạo. Tại settlement dùng trạng thái/usage mới nhất dưới member gate, không áp sourceVersion cũ để bỏ qua usage vừa phát sinh.

Đích khác nguồn, cùng kind, đang ACTIVE, có cạnh policy ACTIVE với rule `PRORATED_REMAINING_DAYS_V1`. Kiểm targetPlanVersion/policyVersion lúc tạo. Không suy “cao hơn” từ tên hoặc chỉ giá. Policy writer US-12 và tạo upgrade cùng ghi guard hai đầu plan; source plan ngừng bán không tự tước quyền của gói đã mua.

- totalDays=endNguồn−startNguồn+1; remainingDays=max(0,endNguồn−asOfDate+1), theo ngày lịch VN. **Ngày nâng cấp nằm trong credit** vì quyền nguồn được thay ngay lúc hoàn tất.
- baseValue=transaction.amount_due nguồn SETTLED + sale.credit_amount nguồn; không đọc giá plan live. Decimal precision40, HALF_UP tới1VND, không dùng Number cho tiền.
- rawCredit=roundHalfUp(baseValue×remainingDays/totalDays); appliedCredit=min(rawCredit,targetListPrice); amountDue=targetListPrice−appliedCredit; excess=raw−applied. Chỉ applied được lưu vào credit_amount. Không ví/hoàn tự động hoặc dùng excess lần sau.
- Ví dụ 900000/30 ngày còn15 →450000 credit; đích1500000 →1050000 phải thu. Raw600000/đích500000 →applied500000/due0/excess100000 bị loại. Lần chuyển tiếp base là tiền thực thu+applied, không cộng excess.

Quote có asOfDate và quoteExpiresAt=00:00 VN ngày kế tiếp; **đúng thời điểm hết hạn cũng không dùng được**. Tạo tính quote theo giờ server lúc tạo, không giữ giá từ preview. UI chặn xác nhận preview đã hết hạn và yêu cầu preview mới. Sau khi tạo, settlement chỉ trong cùng ngày và trước expiry, không tính lại credit/amountDue ngầm. Qua hạn giữ PENDING và gói cũ; nhân viên hủy có lý do rồi báo giá mới. receivedAt chuyển khoản không kéo dài hạn đề nghị.

## Transaction, quota và booking

Tạo: khóa source plan + target plan theo ID tăng dần, rồi member.service_revision; đọc lại policy/plan/source và pending, ghi snapshots cùng transaction. REGISTER/RENEW/UPGRADE cùng gate và một PENDING/member/kind. Không sửa nghĩa vụ PENDING; muốn đổi đích phải hủy rồi tạo ý định mới.

Thu: SaleActivation lấy **member→transaction** một lần, dispatch UpgradeService.activateWithinSession trong session hiện có; chỉ đọc snapshots, không đọc/khóa plan/policy live sau member. Cùng session gồm payment nếu>0, invoice, nguồn SUPERSEDED/version+1/supersession metadata, ngày actual sale đích, membership mới, chuyển BOOKED, event/recipient/outbox và operation result. Lỗi bất cứ bước nào rollback toàn bộ. Giá0 dùng ZeroSettlement với callback cùng handler, invoice total0 không có nghĩa listPrice quyền lợi mới bằng0.

PT: used=source.sessions_used, reserved=BOOKED tham chiếu nguồn; target sessions≥used+reserved. Mỗi BOOKED phải start>now, member đúng và toàn bộ khoảng giờ nằm trong kỳ mới (00:00 ngày đầu đến trước00:00 ngày sau ngày cuối). Buổi đang diễn ra/đã bắt đầu hoặc ngoài kỳ chặn BOOKING_CONFLICT, không tự hủy/đổi giờ. Chỉ BOOKED đổi membership_id, version+1/updated_at; trainer/shift/start/end/member/request_key giữ nguyên. COMPLETED/CANCELLED và audit giữ gói cũ.

Membership mới mang used thực tế lúc settlement; carried_sessions_used_snapshot ghi actual used mang sang (có thể khác usage tại quote). GYM used0. start mới=ngày hoàn tất VN, end=start+durationSnapshot−1. Source sale giữ mọi ngày/tiền/snapshot; source membership giữ sessions_used, chỉ đổi status/metadata/version. Báo cáo hoạt động dựa booking, không cộng used lịch sử với used mang sang như hai lần sử dụng.

S04/S07 hiện có khóa schedule→member cho create/cancel/complete/correct; upgrade chỉ lấy member gate, không quay lại schedule lock sau member. Write conflict buộc đọc lại quota/link. Existing CorrectBookingService chặn REOPEN nguồn SUPERSEDED bằng COMPLETION_RECONCILIATION_REQUIRED để không hoàn used đã mang sang. Các writer lịch mới phải tiếp tục dùng member gate.

## Schema, migration và đọc lịch sử

service_sales operation UPGRADE bắt buộc previous_sale_id, source_membership_id, source_version_snapshot, conversion_policy_id/version_snapshot, valuation_date, quote_expires_at, raw_credit_snapshot, excess_credit_snapshot và carried_sessions_used_snapshot. Decimal128 cho credit, ngày VN string và expiry Date. policy_snapshot JSON≤2000 có UPGRADE_V1/dayInclusive/HALF_UP/căn cứ policy/quote. Thêm index `(source_membership_id,created_at DESC)`; operation_requests enum thêm SALE_UPGRADE.

memberships bổ sung superseded_at và superseded_by_membership_id. Field mới không bắt buộc với REGISTER/RENEW hoặc lịch sử trước US-16. Reader sale vẫn fallback channel COUNTER cho record cũ; invoice hiển thị listPrice, applied credit và amountDue thực thu. US-11/17 tiếp tục đọc từng kỳ với status SUPERSEDED của nguồn và ACTIVE của đích, không gộp quota.

Sau backup/dừng writer cũ, chạy `cd backend; npm run ensure-indexes`: dùng schema/index mới và migration channel đã có. Không backfill quote, credit hoặc metadata supersession bằng dữ liệu đoán; không sửa tài chính lịch sử. Test CLI chạy hai lần trên DB test riêng. Không thêm env/dependency.

## UI và bằng chứng

Chi tiết hội viên → Lịch sử gói → Nâng cấp kỳ CURRENT. UI so sánh quyền lợi nguồn/đích, hiển thị base/ngày còn/tổng, raw/applied/excess, phải thu, quota và hạn VN; credit chỉ do backend tính. Sau tạo có phí ghi rõ chưa chuyển nguồn/BOOKED; xác nhận thu dùng US-22. Kết quả SETTLED hiển thị nguồn SUPERSEDED, kỳ mới và used thực mang sang.

409 nguồn/policy/quote không tự đổi đích hoặc số tiền: tải lại, preview và xác nhận mới. Mất response/503/401/403/key conflict giữ input/key trong memory/sessionStorage theo actor/member; tra cứu SALE_UPGRADE hoặc retry đúng key. Chặn gửi kép. Browser không lưu được storage thì yêu cầu giữ trang mở. Không có form thu0/hoàn dư.

| AC/TC | Bằng chứng tự động |
| --- | --- |
| AC01 / TC01–04 | service-upgrades.integration: API/JWT/Guard thật, nguồn/ownership/current/future, policy/versions/kind, targets reader |
| AC02 / TC05–09 | upgrade-valuation.spec và integration: HALF_UP ở .5/max VND, chain/cap/excess, invoice0, đúng00:00VN, snapshot bị ngừng sau tạo |
| AC03 / TC10–14 | Replica set/hai app; PT fixtures, quota/BOOKED conflict, actual booking create/cancel/complete race, rollback sau ghi invoice/booking/outbox, REOPEN sau carry |
| AC04 / TC15–17 | Upgrade/renew/counter/self-service port race, hai confirm, lost commit reply/replay; upgrades.test.tsx cho credit/excess/expiry/stale/submit kép/lookup/remount |

Backend: `npm run test:integration -- --runTestsByPath test/service-upgrades.integration-spec.ts`; frontend: `npm test -- --pool=threads --maxWorkers=1 src/features/sales/upgrades.test.tsx`. Frontend dùng mock API/jsdom; không thay nghiệm thu trình duyệt/HTTPS triển khai thật. Sequence: [upgrades-sequence.mmd](upgrades-sequence.mmd).
