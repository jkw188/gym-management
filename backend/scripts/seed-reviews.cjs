// Script vận hành (chỉ dùng máy dev): thêm đánh giá PT mẫu để demo (US-65), gọi đúng REST API như người dùng thật.
// Cần chạy `npm run seed:sample` trước (dùng hội viên/PT mẫu). Chạy: npm run seed:reviews
require('dotenv').config({ quiet: true });

const MARKER_ID = 'sample-reviews-v2';
// Lùi đồng hồ nghiệp vụ 28 ngày để đặt được buổi "đã qua"; ca và buổi tập rơi vào 21–27 ngày trước hôm nay.
const DAYS_BACK = 28;

// 4 PT mẫu của seed:sample.
const TRAINER_PHONES = ['0912000201', '0912000202', '0912000203', '0912000204'];
// Mỗi hội viên chỉ có 1 gói PT cùng lúc (luật bán gói), nên chỉ dùng hội viên CHƯA có gói PT:
// 6 hội viên mẫu của seed:sample không mua PT + 8 hội viên mới tạo riêng cho đánh giá.
// Mỗi người tập 2 buổi với 1 PT rồi đánh giá cả 2 buổi.
const NEW_REVIEWERS = [
  { fullName: 'Trương Minh Khôi', phone: '0912000501' }, { fullName: 'Lâm Ngọc Bích', phone: '0912000502' },
  { fullName: 'Huỳnh Tấn Phát', phone: '0912000503' }, { fullName: 'Dương Thị Yến', phone: '0912000504' },
  { fullName: 'Quách Gia Bảo', phone: '0912000505' }, { fullName: 'Tôn Nữ Minh Thư', phone: '0912000506' },
  { fullName: 'Lục Văn Toàn', phone: '0912000507' }, { fullName: 'Ninh Hải Yến', phone: '0912000508' },
];
const REVIEWERS = ['0912000303', '0912000308', '0912000309', '0912000312', '0912000315', '0912000316',
  ...NEW_REVIEWERS.map(person => person.phone)];
// Điểm và nhận xét mẫu (đa số 4–5 sao, có vài đánh giá thấp để demo bộ lọc theo sao).
const REVIEWS = [
  [5, 'PT hướng dẫn rất kỹ từng động tác, sửa tư thế cẩn thận. Buổi tập hiệu quả!'],
  [5, 'Nhiệt tình, đúng giờ, giáo án rõ ràng. Sẽ tiếp tục tập với PT.'],
  [4, 'Bài tập hợp lý, hơi nặng với người mới nhưng PT có điều chỉnh.'],
  [5, 'Tư vấn dinh dưỡng rất có ích, cảm thấy tiến bộ rõ sau vài buổi.'],
  [3, 'Buổi tập ổn nhưng PT hơi vội ở phần giãn cơ cuối buổi.'],
  [4, 'Khởi động kỹ, giải thích dễ hiểu. Mong có thêm bài cardio.'],
  [5, 'Rất chuyên nghiệp, luôn động viên và theo dõi tiến độ từng tuần.'],
  [2, 'Bắt đầu trễ khoảng 10 phút, phần hướng dẫn chưa kỹ lắm.'],
  [4, 'PT thân thiện, bài tập đa dạng, không bị nhàm chán.'],
  [5, 'Lần đầu tập yoga mà thấy rất thoải mái, PT kiên nhẫn.'],
  [4, 'Tốt, chỉ mong phòng tập bớt đông giờ này.'],
  [5, ''],
];

async function main() {
  const env = process.env;
  if (env.NODE_ENV === 'production') throw new Error('SAMPLE_SEED_DEV_ONLY');
  const samplePassword = env.SAMPLE_PASSWORD;
  const adminPhone = env.SAMPLE_ADMIN_PHONE || env.SEED_ADMIN_PHONE, adminPassword = env.SAMPLE_ADMIN_PASSWORD || env.SEED_ADMIN_PASSWORD;
  if (!samplePassword || !adminPhone || !adminPassword) throw new Error('Cần SAMPLE_PASSWORD và SAMPLE_ADMIN_PHONE / SAMPLE_ADMIN_PASSWORD trong backend/.env');

  require('reflect-metadata');
  const { NestFactory } = require('@nestjs/core');
  const { getConnectionToken } = require('@nestjs/mongoose');
  const { ObjectId } = require('mongodb');
  const { randomUUID } = require('node:crypto');
  const { AppModule } = require('../dist/app.module');
  const { configureHttp } = require('../dist/common/http/configure-http');
  // Đồng hồ nghiệp vụ dùng chung: sửa ở prototype thì mọi instance ServerClock trong các module đều theo.
  // Đăng nhập/phiên dùng giờ thật nên không bị ảnh hưởng.
  const { ServerClock } = require('../dist/common/utils/business-date');
  const realNow = ServerClock.prototype.now;
  const shiftClock = days => { ServerClock.prototype.now = () => new Date(Date.now() - days * 86400000); };
  const restoreClock = () => { ServerClock.prototype.now = realNow; };

  const app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
  configureHttp(app);
  await app.listen(0, '127.0.0.1');
  const db = app.get(getConnectionToken()).db;
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}/api`;
  const tokens = {};
  const stats = {}, failures = [];
  const count = name => { stats[name] = (stats[name] || 0) + 1; };

  // Gọi API với token của "who"; lỗi thì ném Error có mã lỗi của backend.
  async function call(who, route, body, method = 'POST') {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(`${base}${route}`, { method, signal: AbortSignal.timeout(20000),
        headers: { Origin: env.FRONTEND_ORIGIN, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(),
          ...(tokens[who] ? { Authorization: `Bearer ${tokens[who]}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const payload = await response.json().catch(() => null);
      // Giới hạn đăng nhập 20 lần/phút/IP: chờ rồi thử lại.
      if (response.status === 429 && attempt < 3) { await new Promise(r => setTimeout(r, 61000)); continue; }
      if (!response.ok) throw new Error(`${method} ${route} → ${response.status} ${payload?.error?.code || ''} ${payload?.error?.message || ''}`.trim());
      return payload;
    }
  }
  async function login(who, phone, password) {
    if (tokens[who]) return;
    tokens[who] = (await call(who, '/auth/login', { phone, password })).accessToken;
  }
  async function step(label, fn) {
    try { return await fn(); } catch (error) { failures.push(`${label}: ${error.message}`); return undefined; }
  }
  // Ngày VN theo đồng hồ đang dùng (có thể đã lùi).
  const vnDate = (offsetDays = 0) => new Date(new ServerClock().now().getTime() + 7 * 3600000 + offsetDays * 86400000).toISOString().slice(0, 10);
  const at = (date, hhmm) => `${date}T${hhmm}:00+07:00`;
  const toE164 = phone => '+84' + phone.slice(1);

  try {
    const marker = await db.collection('_seed_markers').findOne({ _id: MARKER_ID });
    if (marker?.status === 'COMPLETED') { console.info('Đánh giá mẫu đã được thêm trước đó, không làm lại.'); return; }
    await db.collection('_seed_markers').updateOne({ _id: MARKER_ID }, { $set: { status: 'RUNNING', startedAt: new Date() } }, { upsert: true });

    const plan = await db.collection('plans').findOne({ code: 'PT_8', status: 'ACTIVE' });
    if (!plan) throw new Error('Không có gói PT_8 đang bán');
    const trainerIds = [];
    for (const phone of TRAINER_PHONES) {
      const account = await db.collection('accounts').findOne({ phone: toE164(phone) });
      const trainer = account && await db.collection('trainers').findOne({ account_id: account._id });
      if (!trainer) throw new Error(`Thiếu PT mẫu ${phone} – hãy chạy npm run seed:sample trước`);
      trainerIds.push(String(trainer._id));
    }

    await login('ADMIN', adminPhone, adminPassword);

    // 0. Tạo tài khoản + hồ sơ hội viên mới và liên kết (bỏ qua nếu đã có).
    for (const person of NEW_REVIEWERS) {
      await step(`new member ${person.phone}`, async () => {
        let account = await db.collection('accounts').findOne({ phone: toE164(person.phone) });
        if (!account) {
          const user = await call('ADMIN', '/users', { fullName: person.fullName, phone: person.phone, password: samplePassword, roleCode: 'MEMBER' });
          account = { _id: new ObjectId(user.id) }; count('accounts');
        }
        let member = await db.collection('members').findOne({ phone: toE164(person.phone) });
        if (!member) {
          const created = await call('ADMIN', '/members', { fullName: person.fullName, phone: person.phone });
          member = await db.collection('members').findOne({ _id: new ObjectId(created.id) }); count('members');
        }
        if (!member.account_id) {
          await call('ADMIN', `/members/${member._id}/link`, { accountId: String(account._id), version: member.version,
            verificationMethod: 'IN_PERSON_ACCOUNT', verificationNote: 'Dữ liệu mẫu demo: đối chiếu tài khoản tại quầy' });
          count('member links');
        }
      });
    }

    // ===== Giai đoạn 1: lùi đồng hồ, bán gói PT, PT mở ca, hội viên đặt lịch =====
    shiftClock(DAYS_BACK);
    const today = vnDate(0);

    // 1. Mỗi hội viên mua thêm 1 gói PT 8 buổi bắt đầu từ "hôm nay" (đã lùi), thu tiền mặt.
    const membershipOf = {};
    for (const phone of REVIEWERS) {
      await step(`sale ${phone}`, async () => {
        const member = await db.collection('members').findOne({ phone: toE164(phone) });
        if (!member) throw new Error('chưa có hồ sơ hội viên');
        const sale = await call('ADMIN', '/service-sales', { memberId: String(member._id), planId: String(plan._id), planVersion: plan.version, startDate: today });
        const transaction = await db.collection('transactions').findOne({ _id: new ObjectId(sale.transactionId) });
        await call('ADMIN', `/transactions/${sale.transactionId}/confirm-payment`, { method: 'CASH',
          amount: transaction.amount_due.toString(), evidenceNote: 'Dữ liệu mẫu demo: thu tiền mặt tại quầy' });
        const membership = await db.collection('memberships').findOne({ service_sale_id: new ObjectId(sale.id ?? sale.saleId) })
          || await db.collection('memberships').findOne({ member_id: member._id, plan_id: plan._id }, { sort: { _id: -1 } });
        membershipOf[phone] = String(membership._id); count('pt sales');
      });
    }

    // 2. PT mở và công bố ca sáng 07–11h ngày 1–7 (tính từ "hôm nay" đã lùi).
    const shiftOf = {};
    for (const [index, phone] of TRAINER_PHONES.entries()) {
      const ok = await step(`login trainer ${phone}`, async () => { await login(`T${index}`, phone, samplePassword); return true; });
      if (!ok) continue;
      for (let day = 1; day <= 7; day++) {
        const date = vnDate(day);
        await step(`shift T${index} ${date}`, async () => {
          const shift = await call(`T${index}`, '/me/work-shifts', { startAt: at(date, '07:00'), endAt: at(date, '11:00'),
            location: index === 1 ? 'Phòng Yoga tầng 2' : 'Khu PT tầng 1' });
          await call(`T${index}`, `/me/work-shifts/${shift.id}/confirm`, { version: shift.version ?? 0 });
          shiftOf[`${index}:${day}`] = { id: shift.id, date }; count('shifts');
        });
      }
    }

    // 3. Hội viên thứ i tập với PT i%4, nhóm k = i/4 tập ngày 1+k và 4+k lúc (7+k) giờ, nên PT và hội viên không trùng lịch.
    const bookings = [];
    for (const [i, phone] of REVIEWERS.entries()) {
      if (!membershipOf[phone]) continue;
      const trainerIndex = i % TRAINER_PHONES.length, k = Math.floor(i / TRAINER_PHONES.length);
      const ok = await step(`login member ${phone}`, async () => { await login(`M${phone}`, phone, samplePassword); return true; });
      if (!ok) continue;
      for (const day of [1 + k, 4 + k]) {
        const shift = shiftOf[`${trainerIndex}:${day}`];
        if (!shift) continue;
        await step(`booking ${phone} ${shift.date}`, async () => {
          const created = await call(`M${phone}`, '/me/pt-bookings', { membershipId: membershipOf[phone], trainerId: trainerIds[trainerIndex],
            shiftId: shift.id, startAt: at(shift.date, `${String(7 + k).padStart(2, '0')}:00`) });
          bookings.push({ id: created.id, phone, trainerIndex }); count('bookings');
        });
      }
    }

    // ===== Giai đoạn 2: trả đồng hồ về giờ thật – các buổi trên đã kết thúc =====
    restoreClock();

    // 4. PT xác nhận hoàn tất từng buổi (version 0 vì buổi vừa tạo), rồi hội viên đánh giá.
    for (const [n, booking] of bookings.entries()) {
      const done = await step(`complete ${booking.id}`, async () => {
        await call(`T${booking.trainerIndex}`, `/me/pt-bookings/${booking.id}/complete`, { version: 0 }); count('completed'); return true;
      });
      if (!done) continue;
      const [rating, comment] = REVIEWS[n % REVIEWS.length];
      await step(`review ${booking.id}`, async () => {
        await call(`M${booking.phone}`, `/me/pt-bookings/${booking.id}/review`, { rating, ...(comment ? { comment } : {}) });
        count('reviews');
      });
    }

    await db.collection('_seed_markers').updateOne({ _id: MARKER_ID }, { $set: { status: 'COMPLETED', completedAt: new Date(), stats, failures } });
    console.info('Đã thêm đánh giá mẫu:');
    for (const [name, value] of Object.entries(stats)) console.info(`  ${name}: ${value}`);
    if (failures.length) { console.info(`Có ${failures.length} việc không làm được:`); for (const row of failures) console.info('  - ' + row); }
  } finally {
    restoreClock();
    for (const who of Object.keys(tokens)) await call(who, '/auth/logout', {}).catch(() => undefined);
    await app.close();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
