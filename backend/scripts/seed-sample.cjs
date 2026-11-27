// Script vận hành (chỉ dùng máy dev): thêm nhiều dữ liệu mẫu để demo, gọi đúng REST API như người dùng thật.
// Mọi luật nghiệp vụ vẫn do service kiểm; script không ghi thẳng vào MongoDB (chỉ đọc vài id cần dùng).
// Chạy: npm run seed:sample   (cần SAMPLE_PASSWORD trong .env; tài khoản Admin lấy từ SAMPLE_ADMIN_* hoặc SEED_ADMIN_*)
require('dotenv').config({ quiet: true });

const MARKER_ID = 'sample-data-v1';

// ---------- Dữ liệu mẫu (tên giả, số điện thoại giả dải 0912 000 xxx) ----------
const STAFF = [
  { fullName: 'Nguyễn Thị Lan', phone: '0912000101' },
  { fullName: 'Trần Quốc Bảo', phone: '0912000102' },
];
const TRAINERS = [
  { fullName: 'PT Lê Hoàng Nam', phone: '0912000201', specialty: 'Tăng cơ, giảm mỡ' },
  { fullName: 'PT Võ Thị Thanh Hương', phone: '0912000202', specialty: 'Yoga, Pilates' },
  { fullName: 'PT Đặng Minh Khoa', phone: '0912000203', specialty: 'Functional training' },
  { fullName: 'PT Bùi Ngọc Ánh', phone: '0912000204', specialty: 'Zumba, Aerobics' },
];
// gym: mã gói GYM; pt: mã gói PT (null = không mua); pending: để 1 giao dịch chờ thu tiền
const MEMBERS = [
  { fullName: 'Nguyễn Văn Tuấn', phone: '0912000301', birthDate: '1995-03-12', address: 'Q.1, TP.HCM', gym: 'GYM_3M', pt: 'PT_8' },
  { fullName: 'Trần Thị Mỹ Linh', phone: '0912000302', birthDate: '1998-07-25', address: 'Q.3, TP.HCM', gym: 'GYM_1M', pt: 'PT_16' },
  { fullName: 'Lê Quang Huy', phone: '0912000303', birthDate: '1990-11-02', address: 'Q.7, TP.HCM', gym: 'GYM_12M', pt: null },
  { fullName: 'Phạm Ngọc Trâm', phone: '0912000304', birthDate: '2000-01-19', address: 'Bình Thạnh, TP.HCM', gym: 'GYM_6M', pt: 'PT_24' },
  { fullName: 'Hoàng Đức Thắng', phone: '0912000305', birthDate: '1993-05-30', address: 'Gò Vấp, TP.HCM', gym: 'GYM_1M', pt: null, pending: 'PT_8' },
  { fullName: 'Vũ Thị Hồng Nhung', phone: '0912000306', birthDate: '1997-09-14', address: 'Thủ Đức, TP.HCM', gym: 'GYM_3M', pt: 'PT_8' },
  { fullName: 'Đỗ Minh Quân', phone: '0912000307', birthDate: '1988-12-08', address: 'Q.10, TP.HCM', gym: 'GYM_12M', pt: 'PT_16' },
  { fullName: 'Ngô Thanh Tâm', phone: '0912000308', birthDate: '2001-04-03', address: 'Tân Bình, TP.HCM', gym: 'GYM_1M', pt: null },
  { fullName: 'Bùi Thị Kim Ngân', phone: '0912000309', birthDate: '1996-08-21', address: 'Q.5, TP.HCM', gym: 'GYM_6M', pt: null },
  { fullName: 'Đặng Văn Phúc', phone: '0912000310', birthDate: '1992-02-17', address: 'Phú Nhuận, TP.HCM', gym: 'GYM_3M', pt: 'PT_8' },
  { fullName: 'Lý Gia Hân', phone: '0912000311', birthDate: '1999-06-11', address: 'Q.2, TP.HCM', gym: 'GYM_1M', pt: null, pending: 'PT_16' },
  { fullName: 'Mai Xuân Trường', phone: '0912000312', birthDate: '1994-10-27', address: 'Q.4, TP.HCM', gym: 'GYM_12M', pt: null },
  { fullName: 'Trịnh Bảo Ngọc', phone: '0912000313', birthDate: '2002-03-05', address: 'Q.8, TP.HCM', gym: null, pt: null, pending: 'GYM_1M' },
  { fullName: 'Cao Minh Đạt', phone: '0912000314', birthDate: '1991-07-09', address: 'Bình Tân, TP.HCM', gym: 'GYM_6M', pt: 'PT_24' },
  { fullName: 'Hồ Thị Thu Trang', phone: '0912000315', birthDate: '1997-12-24', address: 'Q.11, TP.HCM', gym: 'GYM_3M', pt: null },
  { fullName: 'Phan Anh Khoa', phone: '0912000316', birthDate: '1989-01-15', address: 'Q.6, TP.HCM', gym: 'GYM_1M', pt: null },
];
// Hội viên đến quầy, chưa có tài khoản web.
const WALK_IN_MEMBERS = [
  { fullName: 'Lâm Văn Hải', phone: '0912000401', gym: 'GYM_1M' },
  { fullName: 'Châu Thị Diễm', phone: '0912000402', gym: 'GYM_3M' },
  { fullName: 'Tạ Quang Vinh', phone: '0912000403', gym: 'GYM_1M' },
  { fullName: 'Kiều Ngọc Mai', phone: '0912000404', gym: null },
  { fullName: 'La Thành Công', phone: '0912000405', gym: 'GYM_6M' },
];
const NEW_PLANS = [
  { code: 'GYM_6M', name: 'Gói Gym 6 tháng', kind: 'GYM', durationDays: 180, sessionsQuota: 0, price: '2600000', benefits: 'Tập không giới hạn, tủ đồ riêng, 1 buổi đo InBody mỗi tháng' },
  { code: 'PT_24', name: 'Gói PT 24 buổi', kind: 'PT', durationDays: 120, sessionsQuota: 24, price: '6500000', benefits: '24 buổi 1 kèm 1, giáo án dinh dưỡng và theo dõi tiến độ hằng tuần' },
  { code: 'STUDENT_1M', name: 'Gói Sinh viên 1 tháng', kind: 'GYM', durationDays: 30, sessionsQuota: 0, price: '350000', benefits: 'Ưu đãi cho sinh viên có thẻ, tập từ 6h đến 16h' },
];
const NEW_CATEGORY = 'Trang phục thể thao';
const IMG = id => `https://images.unsplash.com/photo-${id}?w=600&h=600&fit=crop&q=80`;
const NEW_PRODUCTS = [
  { category: 'Thực phẩm bổ sung', sku: 'MEAL_SHAKE', name: 'Sữa lắc thay bữa 1kg', price: '690000', imageUrl: IMG('1579722821273-0f6c7d44362f'), description: 'Bổ sung đạm và chất xơ, vị dâu.' },
  { category: 'Thực phẩm bổ sung', sku: 'CREATINE_300', name: 'Creatine Monohydrate 300g', price: '520000', imageUrl: IMG('1693996045838-980674653385'), description: 'Hỗ trợ sức mạnh cho bài tập nặng.' },
  { category: 'Thực phẩm bổ sung', sku: 'MASS_3KG', name: 'Mass Gainer 3kg', price: '1150000', imageUrl: IMG('1704650311190-7eeb9c4f6e11'), description: 'Tăng cân, tăng cơ cho người gầy.' },
  { category: 'Nước uống', sku: 'COCONUT_330', name: 'Nước dừa 330ml', price: '18000', imageUrl: IMG('1580984969071-a8da5656c2fb') },
  { category: 'Nước uống', sku: 'COLDBREW', name: 'Cà phê ủ lạnh không đường', price: '30000', imageUrl: IMG('1461023058943-07fcbe16d735') },
  { category: 'Phụ kiện tập luyện', sku: 'BAND_SET', name: 'Bộ dây kháng lực 5 mức', price: '220000', imageUrl: IMG('1584735935682-2f2b69dff9d2'), description: 'Dùng khởi động và tập tại nhà.' },
  { category: 'Phụ kiện tập luyện', sku: 'DUMBBELL_5KG', name: 'Tạ tay bọc cao su 5kg', price: '280000', imageUrl: IMG('1576678927484-cc907957088c') },
  { category: 'Phụ kiện tập luyện', sku: 'YOGA_MAT', name: 'Thảm tập yoga 6mm', price: '190000', imageUrl: IMG('1601925260368-ae2f83cf8b7f') },
  { category: 'Phụ kiện tập luyện', sku: 'JUMP_ROPE', name: 'Dây nhảy có đếm số', price: '75000', imageUrl: IMG('1434596922112-19c563067271') },
  { category: NEW_CATEGORY, sku: 'TEE_BLACK', name: 'Áo thun tập gym màu đen', price: '180000', imageUrl: IMG('1622519407650-3df9883f76a5'), description: 'Vải thun lạnh, thấm hút mồ hôi.' },
  { category: NEW_CATEGORY, sku: 'SHORTS', name: 'Quần short thể thao', price: '160000', imageUrl: IMG('1607962837359-5e7e89f86776') },
];
// Lớp miễn phí buổi tối (không trùng giờ ca PT buổi sáng/chiều).
const CLASS_TEMPLATES = [
  { title: 'Yoga thư giãn buổi tối', subjectCode: 'YOGA', trainer: 1, location: 'Phòng Yoga tầng 2' },
  { title: 'Zumba đốt mỡ', subjectCode: 'ZUMBA', trainer: 3, location: 'Phòng Group X' },
  { title: 'Tập chức năng toàn thân', subjectCode: 'FUNCTIONAL', trainer: 2, location: 'Khu Functional' },
  { title: 'Aerobics cơ bản', subjectCode: 'AEROBICS', trainer: 3, location: 'Phòng Group X' },
  { title: 'Core & giãn cơ', subjectCode: 'OTHER', trainer: 0, location: 'Phòng Yoga tầng 2' },
];

async function main() {
  const env = process.env;
  if (env.NODE_ENV === 'production') throw new Error('SAMPLE_SEED_DEV_ONLY');
  const samplePassword = env.SAMPLE_PASSWORD;
  if (!samplePassword || samplePassword.length < 12) throw new Error('Cần đặt SAMPLE_PASSWORD (ít nhất 12 ký tự) trong backend/.env');
  const adminPhone = env.SAMPLE_ADMIN_PHONE || env.SEED_ADMIN_PHONE, adminPassword = env.SAMPLE_ADMIN_PASSWORD || env.SEED_ADMIN_PASSWORD;
  if (!adminPhone || !adminPassword) throw new Error('Cần SAMPLE_ADMIN_PHONE / SAMPLE_ADMIN_PASSWORD (tài khoản Admin đang dùng)');

  require('reflect-metadata');
  const { NestFactory } = require('@nestjs/core');
  const { getConnectionToken } = require('@nestjs/mongoose');
  const { ObjectId } = require('mongodb');
  const { randomUUID } = require('node:crypto');
  const { AppModule } = require('../dist/app.module');
  const { configureHttp } = require('../dist/common/http/configure-http');

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
    const result = await call(who, '/auth/login', { phone, password });
    tokens[who] = result.accessToken;
  }
  // Mỗi việc nhỏ chạy riêng: hỏng một việc thì ghi lại và làm tiếp việc khác.
  async function step(label, fn) {
    try { return await fn(); } catch (error) { failures.push(`${label}: ${error.message}`); return undefined; }
  }
  const vnDate = (offsetDays = 0) => new Date(Date.now() + 7 * 3600000 + offsetDays * 86400000).toISOString().slice(0, 10);
  const at = (date, hhmm) => `${date}T${hhmm}:00+07:00`;
  const toE164 = phone => '+84' + phone.slice(1);

  try {
    const marker = await db.collection('_seed_markers').findOne({ _id: MARKER_ID });
    if (marker?.status === 'COMPLETED') { console.info('Dữ liệu mẫu đã được thêm trước đó, không làm lại.'); return; }
    await db.collection('_seed_markers').updateOne({ _id: MARKER_ID }, { $set: { status: 'RUNNING', startedAt: new Date() } }, { upsert: true });

    await login('ADMIN', adminPhone, adminPassword);
    const today = vnDate(0);

    // 1. Gói dịch vụ mới
    for (const plan of NEW_PLANS) {
      if (await db.collection('plans').findOne({ code: plan.code })) continue;
      await step(`plan ${plan.code}`, async () => { await call('ADMIN', '/admin/plans', plan); count('plans'); });
    }
    const plans = {};
    for (const row of await db.collection('plans').find({ status: 'ACTIVE' }).toArray()) plans[row.code] = row;

    // 2. Tài khoản Nhân viên, PT, Hội viên
    const accountIds = {};
    async function ensureAccount(person, roleCode) {
      const existing = await db.collection('accounts').findOne({ phone: toE164(person.phone) });
      if (existing) { accountIds[person.phone] = String(existing._id); return; }
      const user = await call('ADMIN', '/users', { fullName: person.fullName, phone: person.phone, password: samplePassword, roleCode });
      accountIds[person.phone] = user.id; count(`accounts ${roleCode}`);
    }
    for (const person of STAFF) await step(`staff ${person.phone}`, () => ensureAccount(person, 'STAFF'));
    for (const person of TRAINERS) await step(`trainer ${person.phone}`, () => ensureAccount(person, 'TRAINER'));
    for (const person of MEMBERS) await step(`member account ${person.phone}`, () => ensureAccount(person, 'MEMBER'));

    // 3. Hồ sơ PT
    const trainerIds = [];
    for (const person of TRAINERS) {
      await step(`trainer profile ${person.phone}`, async () => {
        if (!accountIds[person.phone]) return;
        const existing = await db.collection('trainers').findOne({ account_id: new ObjectId(accountIds[person.phone]) });
        if (existing) { trainerIds.push(String(existing._id)); return; }
        const trainer = await call('ADMIN', '/trainers', { accountId: accountIds[person.phone], specialty: person.specialty, status: 'ACTIVE' });
        trainerIds.push(trainer.id); count('trainers');
      });
    }

    // 4. Hồ sơ hội viên (+ liên kết tài khoản) và bán gói, thu tiền mặt
    const memberIds = {};
    async function ensureMember(person, linkAccount) {
      let member = await db.collection('members').findOne({ phone: toE164(person.phone) });
      if (!member) {
        const created = await call('ADMIN', '/members', { fullName: person.fullName, phone: person.phone,
          ...(person.birthDate ? { birthDate: person.birthDate } : {}), ...(person.address ? { address: person.address } : {}) });
        count('members');
        member = await db.collection('members').findOne({ _id: new ObjectId(created.id) });
      }
      memberIds[person.phone] = String(member._id);
      if (linkAccount && accountIds[person.phone] && !member.account_id) {
        await call('ADMIN', `/members/${member._id}/link`, { accountId: accountIds[person.phone], version: member.version,
          verificationMethod: 'IN_PERSON_ACCOUNT', verificationNote: 'Dữ liệu mẫu demo: đối chiếu tài khoản tại quầy' });
        count('member links');
      }
    }
    async function sell(phone, planCode, pay) {
      const plan = plans[planCode];
      if (!plan || !memberIds[phone]) return;
      const sale = await call('ADMIN', '/service-sales', { memberId: memberIds[phone], planId: String(plan._id), planVersion: plan.version, startDate: today });
      count(pay ? 'paid sales' : 'pending sales');
      if (!pay) return;
      const transaction = await db.collection('transactions').findOne({ _id: new ObjectId(sale.transactionId) });
      await call('ADMIN', `/transactions/${sale.transactionId}/confirm-payment`, { method: 'CASH',
        amount: transaction.amount_due.toString(), evidenceNote: 'Dữ liệu mẫu demo: thu tiền mặt tại quầy' });
    }
    for (const person of MEMBERS) {
      await step(`member ${person.phone}`, () => ensureMember(person, true));
      if (person.gym) await step(`sale ${person.phone} ${person.gym}`, () => sell(person.phone, person.gym, true));
      if (person.pt) await step(`sale ${person.phone} ${person.pt}`, () => sell(person.phone, person.pt, true));
      if (person.pending) await step(`pending ${person.phone} ${person.pending}`, () => sell(person.phone, person.pending, false));
    }
    for (const person of WALK_IN_MEMBERS) {
      await step(`walk-in ${person.phone}`, () => ensureMember(person, false));
      if (person.gym) await step(`sale ${person.phone} ${person.gym}`, () => sell(person.phone, person.gym, true));
    }

    // 5. Ca làm của PT mới trong 7 ngày tới (sáng 07–11h, chiều 14–17h), công bố luôn để hội viên đặt
    const shiftsByTrainer = {};
    for (let index = 0; index < TRAINERS.length; index++) {
      const person = TRAINERS[index];
      const ok = await step(`login trainer ${person.phone}`, async () => { await login(`T${index}`, person.phone, samplePassword); return true; });
      if (!ok) continue;
      shiftsByTrainer[index] = [];
      for (let day = 1; day <= 7; day++) {
        const date = vnDate(day);
        const windows = (day + index) % 3 === 0 ? [['14:00', '17:00']] : [['07:00', '11:00'], ['14:00', '17:00']];
        for (const [from, to] of windows) {
          await step(`shift T${index} ${date} ${from}`, async () => {
            const shift = await call(`T${index}`, '/me/work-shifts', { startAt: at(date, from), endAt: at(date, to), location: index === 1 ? 'Phòng Yoga tầng 2' : 'Khu PT tầng 1' });
            await call(`T${index}`, `/me/work-shifts/${shift.id}/confirm`, { version: shift.version ?? 0 });
            shiftsByTrainer[index].push({ id: shift.id, date, from }); count('shifts');
          });
        }
      }
    }

    // 6. Hội viên có gói PT đặt 2 buổi với PT mới
    let ptIndex = 0;
    for (const person of MEMBERS.filter(row => row.pt)) {
      const who = `M${person.phone}`;
      const ok = await step(`login member ${person.phone}`, async () => { await login(who, person.phone, samplePassword); return true; });
      if (!ok) continue;
      const plan = plans[person.pt];
      const sale = plan && await db.collection('service_sales').findOne({ member_id: new ObjectId(memberIds[person.phone]), plan_id: plan._id }, { sort: { _id: -1 } });
      const membership = sale && await db.collection('memberships').findOne({ service_sale_id: sale._id });
      if (!membership) { failures.push(`booking ${person.phone}: không tìm thấy gói PT`); continue; }
      const trainerIndex = ptIndex % TRAINERS.length, shifts = shiftsByTrainer[trainerIndex] || [];
      // Mỗi hội viên lấy một giờ khác nhau trong ca, 2 ngày khác nhau.
      const hour = String(7 + Math.floor(ptIndex / TRAINERS.length) % 4).padStart(2, '0');
      const picks = shifts.filter(shift => shift.from === '07:00').slice(ptIndex % 2, ptIndex % 2 + 3).filter((_, i) => i !== 1);
      for (const shift of picks) {
        await step(`booking ${person.phone} ${shift.date}`, async () => {
          await call(who, '/me/pt-bookings', { membershipId: String(membership._id), trainerId: trainerIds[trainerIndex], shiftId: shift.id, startAt: at(shift.date, `${hour}:00`) });
          count('pt bookings');
        });
      }
      ptIndex++;
    }

    // 7. Lớp miễn phí buổi tối 10 ngày tới, công bố luôn
    for (let day = 1; day <= 10; day++) {
      const date = vnDate(day);
      const picks = [CLASS_TEMPLATES[day % CLASS_TEMPLATES.length], CLASS_TEMPLATES[(day + 2) % CLASS_TEMPLATES.length]];
      for (const [slot, template] of picks.entries()) {
        const trainerId = trainerIds[template.trainer];
        if (!trainerId) continue;
        const [from, to] = slot === 0 ? ['18:00', '19:00'] : ['19:15', '20:15'];
        await step(`class ${date} ${template.subjectCode}`, async () => {
          const session = await call('ADMIN', '/admin/public-sessions', { title: template.title, trainerId, subjectCode: template.subjectCode,
            location: template.location, startAt: at(date, from), endAt: at(date, to) });
          await call('ADMIN', `/admin/public-sessions/${session.id}/publish`, { version: session.version ?? 0 });
          count('public sessions');
        });
      }
    }

    // 8. Danh mục, sản phẩm mới và phiếu nhập kho cho mọi sản phẩm đang bán
    await step('category', async () => {
      if (await db.collection('categories').findOne({ name: NEW_CATEGORY })) return;
      await call('ADMIN', '/admin/categories', { name: NEW_CATEGORY, status: 'ACTIVE' }); count('categories');
    });
    for (const product of NEW_PRODUCTS) {
      await step(`product ${product.sku}`, async () => {
        if (await db.collection('products').findOne({ sku: product.sku })) return;
        const category = await db.collection('categories').findOne({ name: product.category });
        if (!category) throw new Error(`thiếu danh mục ${product.category}`);
        const { category: _ignored, ...body } = product;
        await call('ADMIN', '/admin/products', { ...body, categoryId: String(category._id), status: 'ACTIVE' }); count('products');
      });
    }
    const products = await db.collection('products').find({ status: 'ACTIVE' }).toArray();
    await step('stock receipt', async () => {
      const items = products.map(row => ({ productId: String(row._id), quantity: 60 + (row.sku.length * 7) % 60,
        unitCost: String(Math.round(Number(row.price.toString()) * 0.6 / 1000) * 1000 || 1000) }));
      const receipt = await call('ADMIN', '/stock-receipts', { reason: 'Nhập hàng đầu tháng (dữ liệu mẫu demo)', sourceReference: 'PN-DEMO-01', items });
      await call('ADMIN', `/stock-receipts/${receipt.id}/post`, { version: receipt.version ?? 0 }); count('stock receipts');
    });

    // 9. Đơn bán tại quầy: thu tiền và bàn giao
    const productBySku = Object.fromEntries(products.map(row => [row.sku, String(row._id)]));
    const POS_ORDERS = [
      { member: '0912000301', items: [['WHEY_1KG', 1], ['SHAKER', 1]] },
      { buyer: 'Khách lẻ', items: [['WATER_500', 3]] },
      { member: '0912000303', items: [['ISO_DRINK', 2], ['PROTEIN_BAR', 2]] },
      { member: '0912000306', items: [['YOGA_MAT', 1], ['TOWEL', 1]] },
      { buyer: 'Khách lẻ', items: [['COCONUT_330', 2], ['PROTEIN_BAR', 1]] },
      { member: '0912000307', items: [['CREATINE_300', 1], ['BCAA_300', 1]] },
      { member: '0912000401', items: [['GLOVES', 1], ['WATER_500', 2]] },
      { buyer: 'Khách lẻ', items: [['COLDBREW', 2]] },
      { member: '0912000310', items: [['TEE_BLACK', 2], ['SHORTS', 1]] },
      { member: '0912000314', items: [['MASS_3KG', 1]] },
      { member: '0912000312', items: [['BAND_SET', 1], ['JUMP_ROPE', 1]] },
      { buyer: 'Khách lẻ', items: [['ISO_DRINK', 1], ['TOWEL', 1]] },
    ];
    for (const [index, spec] of POS_ORDERS.entries()) {
      await step(`pos order ${index + 1}`, async () => {
        const items = spec.items.filter(([sku]) => productBySku[sku]).map(([sku, quantity]) => ({ productId: productBySku[sku], quantity }));
        if (!items.length) return;
        const intent = { ...(spec.member && memberIds[spec.member] ? { memberId: memberIds[spec.member] } : { buyerName: spec.buyer || 'Khách lẻ' }),
          preferredPaymentMethod: 'CASH', items };
        const quote = await call('ADMIN', '/pos/orders/preview', intent);
        const order = await call('ADMIN', '/pos/orders', { ...intent, quoteToken: quote.quoteToken });
        const transaction = await db.collection('transactions').findOne({ _id: new ObjectId(order.transactionId) });
        await call('ADMIN', `/transactions/${order.transactionId}/confirm-payment`, { method: 'CASH',
          amount: transaction.amount_due.toString(), evidenceNote: 'Dữ liệu mẫu demo: thu tiền tại quầy' });
        // Hai đơn cuối để ở trạng thái đã thu tiền, chờ bàn giao.
        if (index < POS_ORDERS.length - 2) {
          const detail = await call('ADMIN', `/orders/${order.id}`, undefined, 'GET');
          await call('ADMIN', `/pos/orders/${order.id}/fulfill`, { version: detail.version });
        }
        count('pos orders');
      });
    }

    // 10. Đơn website do hội viên tự đặt (chờ thanh toán khi nhận hàng)
    const WEB_ORDERS = [
      ['0912000302', [['WHEY_1KG', 1], ['SHAKER', 1]]],
      ['0912000304', [['MEAL_SHAKE', 1]]],
      ['0912000308', [['GLOVES', 1], ['TOWEL', 2]]],
      ['0912000311', [['DUMBBELL_5KG', 2]]],
    ];
    for (const [phone, lines] of WEB_ORDERS) {
      const person = MEMBERS.find(row => row.phone === phone);
      const who = `M${phone}`;
      await step(`web order ${phone}`, async () => {
        if (!tokens[who]) await login(who, phone, samplePassword);
        let cart = await call(who, '/me/cart', undefined, 'GET');
        for (const [sku, quantity] of lines) {
          if (!productBySku[sku]) continue;
          cart = await call(who, '/me/cart/items', { version: cart.version, productId: productBySku[sku], quantity });
        }
        const quote = await call(who, '/me/orders/preview', { cartVersion: cart.version });
        await call(who, '/me/orders', { cartVersion: cart.version, quoteToken: quote.quoteToken, recipientName: person.fullName,
          recipientPhone: phone, preferredPaymentMethod: 'CASH' });
        count('website orders');
      });
    }

    // 11. Thông báo chung gửi tất cả tài khoản
    const BROADCASTS = [
      { title: 'Lịch lớp miễn phí tuần này đã có', body: 'Phòng tập mở thêm các lớp Yoga, Zumba và Tập chức năng buổi tối. Xem lịch và đăng ký tại mục Lịch lớp.' },
      { title: 'Ưu đãi gói Sinh viên', body: 'Từ tháng này phòng tập có gói Sinh viên 1 tháng giá 350.000đ, tập từ 6h đến 16h. Mang thẻ sinh viên khi đăng ký tại quầy.' },
    ];
    for (const broadcast of BROADCASTS) {
      await step(`broadcast ${broadcast.title}`, async () => {
        const preview = await call('ADMIN', '/admin/notification-broadcasts/preview', { audience: 'ALL_ACTIVE', ...broadcast });
        await call('ADMIN', `/admin/notification-broadcasts/${preview.previewId}/send`, { version: preview.version });
        count('broadcasts');
      });
    }

    await db.collection('_seed_markers').updateOne({ _id: MARKER_ID }, { $set: { status: 'COMPLETED', completedAt: new Date(), stats, failures } });
    console.info('Đã thêm dữ liệu mẫu:');
    for (const [name, value] of Object.entries(stats)) console.info(`  ${name}: ${value}`);
    if (failures.length) { console.info(`Có ${failures.length} việc không làm được (bỏ qua, các việc khác vẫn chạy):`); for (const row of failures) console.info('  - ' + row); }
  } finally {
    for (const who of Object.keys(tokens)) await call(who, '/auth/logout', {}).catch(() => undefined);
    await app.close();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
