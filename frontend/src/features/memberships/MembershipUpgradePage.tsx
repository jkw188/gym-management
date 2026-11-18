// Tầng giao diện – trang (US-20 bước 3): trang /member/memberships/:id/upgrade – so sánh gói hiện tại với gói đích,
// xem báo giá, xác nhận điều khoản, gửi đề nghị và xem kết quả. Mọi con số lấy từ server, React không tự tính (US-20-F02).
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { useAccountId } from '../notifications/inbox-signals';
import type { PaymentInstructions, PaymentMethod } from '../service-registrations/service-registrations.api';
import { membershipsApi, type MyMembership } from './memberships.api';
import { upgradesApi, type UpgradeInput, type UpgradeOption, type UpgradeQuote, type UpgradeResult } from './upgrades.api';

// "2026-11-30" → "30/11/2026" (tách chuỗi, không qua Date nên không lệch múi giờ).
function formatDate(value: string): string {
  const [year, month, day] = value.split('-');
  return `${day}/${month}/${year}`;
}

// Thời điểm ISO → "00:00 17/11/2026" theo giờ Việt Nam (UTC+7, không có giờ mùa hè).
function formatVietnamTime(iso: string): string {
  const vietnam = new Date(Date.parse(iso) + 7 * 60 * 60 * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(vietnam.getUTCHours())}:${pad(vietnam.getUTCMinutes())} `
    + `${pad(vietnam.getUTCDate())}/${pad(vietnam.getUTCMonth() + 1)}/${vietnam.getUTCFullYear()}`;
}

// "600000" → "600.000 đ" (xử lý chuỗi, không đổi sang Number).
const formatVnd = (value: string) => `${value.replace(/\B(?=(\d{3})+(?!\d))/g, '.')} đ`;

const codeOf = (error: unknown) => (error instanceof ApiError ? error.code : undefined);

// US-20-TC04: nguồn/gói đích/chính sách đổi sau lúc đọc options → phải tải lại, không tự gửi đề nghị mới.
const STALE_CODES = ['SOURCE_CHANGED', 'SOURCE_NOT_CURRENT', 'PLAN_CHANGED', 'PLAN_NOT_AVAILABLE', 'POLICY_CHANGED', 'POLICY_NOT_ALLOWED'];

// Lý do không nâng cấp được, theo mã server trả (blockingCode của báo giá hoặc mã lỗi 409).
const REASON_LABELS: Record<string, string> = {
  // US-20-TC08: lịch/quota PT không phù hợp – chỉ báo, không tự hủy buổi.
  QUOTA_INSUFFICIENT: 'Gói đích không đủ buổi cho số buổi PT đã dùng và đang giữ chỗ. Hãy chọn gói khác hoặc liên hệ quầy.',
  BOOKING_CONFLICT: 'Bạn có lịch PT nằm ngoài kỳ gói mới hoặc đang diễn ra. Hãy xử lý lịch đó trước, hệ thống không tự hủy buổi.',
  PENDING_SALE_EXISTS: 'Bạn đang có một yêu cầu cùng loại chờ xác nhận thu. Hãy chờ quầy xác nhận hoặc hủy yêu cầu đó trước.',
  FUTURE_PERIOD_EXISTS: 'Bạn đã có kỳ gói tương lai cùng loại nên chưa nâng cấp được. Vui lòng liên hệ quầy.',
  MEMBER_PROFILE_REQUIRED: 'Tài khoản chưa được liên kết hồ sơ hội viên. Vui lòng liên hệ quầy lễ tân.',
  RECEIVING_ACCOUNTS_NOT_CONFIGURED: 'Phòng tập chưa nhận chuyển khoản. Hãy chọn "Tiền mặt tại quầy".',
};

// Lỗi mạng hoặc 5xx: chưa biết server đã ghi nhận chưa, nên giữ key để "Thử lại" (US-20-TC13).
function isUnknownOutcome(error: unknown) {
  if (!(error instanceof ApiError) || error.status === undefined) return true;
  return error.status >= 500 && error.code !== 'RECEIVING_ACCOUNTS_NOT_CONFIGURED';
}

function messageOf(error: unknown, fallback: string) {
  const code = codeOf(error);
  if (code && REASON_LABELS[code]) return REASON_LABELS[code];
  return error instanceof ApiError && error.message ? error.message : fallback;
}

// Loại thông báo lỗi đang hiện, để biết kèm nút nào.
type ErrorKind = 'plain' | 'stale' | 'expired' | 'retry';

export function MembershipUpgradePage() {
  const { id: membershipId = '' } = useParams();
  const accountId = useAccountId();

  // Dữ liệu tải từ server.
  const [current, setCurrent] = useState<MyMembership | null>(null);
  const [options, setOptions] = useState<UpgradeOption[] | null>(null);
  const [sourceVersion, setSourceVersion] = useState(0);
  const [loadError, setLoadError] = useState('');

  // Lựa chọn của Member.
  const [selected, setSelected] = useState<UpgradeOption | null>(null);
  const [method, setMethod] = useState<PaymentMethod>('CASH');
  const [agreed, setAgreed] = useState(false);

  // Báo giá, kết quả và lỗi.
  const [quote, setQuote] = useState<UpgradeQuote | null>(null);
  const [quotedInput, setQuotedInput] = useState<UpgradeInput | null>(null);
  const [error, setError] = useState('');
  const [errorKind, setErrorKind] = useState<ErrorKind>('plain');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<UpgradeResult | null>(null);
  const [guide, setGuide] = useState<PaymentInstructions | null>(null);

  // US-20-TC13: key gắn với đúng body đã gửi; body đổi thì tạo key mới.
  const pendingKey = useRef<{ payload: string; key: string } | null>(null);
  // Số thứ tự lần tải mới nhất: kết quả cũ về muộn thì bỏ qua.
  const latestLoad = useRef(0);
  // Account hiện tại: kết quả báo giá/tạo về sau khi đã đổi account thì bỏ qua.
  const currentAccount = useRef(accountId);
  currentAccount.current = accountId;

  function clearQuote() {
    setQuote(null);
    setQuotedInput(null);
    setAgreed(false);
    setError('');
    setErrorKind('plain');
  }

  function showError(message: string, kind: ErrorKind) {
    setError(message);
    setErrorKind(kind);
  }

  // Tải gói hiện tại (để hiện quyền lợi) và gói đích của đúng membership trên URL.
  const load = useCallback(async () => {
    if (!accountId || !membershipId) return;
    const loadNumber = ++latestLoad.current;
    setLoadError('');
    try {
      const [memberships, upgradeOptions] = await Promise.all([
        membershipsApi.listMemberships(), upgradesApi.options(membershipId)]);
      if (loadNumber !== latestLoad.current) return;
      setCurrent(memberships.items.find(item => item.id === membershipId) ?? null);
      setOptions(upgradeOptions.items);
      setSourceVersion(upgradeOptions.sourceVersion);
    } catch (rejection) {
      if (loadNumber !== latestLoad.current) return;
      // US-20-TC02: gói không phải của mình → server trả 404, chỉ báo không tìm thấy.
      setLoadError(codeOf(rejection) === 'NOT_FOUND' || (rejection instanceof ApiError && rejection.status === 404)
        ? 'Không tìm thấy gói tập này trong tài khoản của bạn.'
        : messageOf(rejection, 'Không tải được danh sách gói nâng cấp.'));
    }
  }, [accountId, membershipId]);

  // US-20-TC13: đổi account thì xóa ngay mọi dữ liệu, báo giá và kết quả của account cũ, rồi mới tải lại.
  useEffect(() => {
    setCurrent(null);
    setOptions(null);
    setLoadError('');
    setSelected(null);
    setResult(null);
    setGuide(null);
    setQuote(null);
    setQuotedInput(null);
    setAgreed(false);
    setError('');
    pendingKey.current = null;
  }, [accountId]);

  useEffect(() => { void load(); }, [load]);

  // Đổi gói đích hoặc cách trả thì báo giá cũ không còn đúng → phải xem lại.
  function choose(option: UpgradeOption) {
    setSelected(option);
    clearQuote();
  }
  function changeMethod(value: PaymentMethod) {
    setMethod(value);
    clearQuote();
  }

  // US-20-TC04: dữ liệu đã đổi → bỏ lựa chọn cũ và đọc lại options; không tự gửi đề nghị mới.
  function reload() {
    setSelected(null);
    clearQuote();
    void load();
  }

  // US-20-TC01: Xem báo giá gửi ĐÚNG 6 field, version lấy từ options; chưa tạo gì.
  async function handlePreview() {
    if (!selected) return;
    const account = accountId;
    clearQuote();
    const input: UpgradeInput = {
      sourceMembershipId: membershipId, sourceVersion, targetPlanId: selected.targetPlanId,
      targetPlanVersion: selected.targetPlanVersion, policyVersion: selected.policyVersion, preferredPaymentMethod: method,
    };
    try {
      const preview = await upgradesApi.preview(input);
      if (currentAccount.current !== account) return;
      setQuote(preview);
      setQuotedInput(input);
    } catch (rejection) {
      if (currentAccount.current !== account) return;
      // US-20-TC13: lỗi mạng khi xem báo giá chỉ báo lỗi, không hiện 0 đ hay "miễn phí".
      if (STALE_CODES.includes(codeOf(rejection) ?? '')) {
        showError('Thông tin gói đã thay đổi. Bấm "Tải lại" để xem dữ liệu mới.', 'stale');
      } else {
        showError(messageOf(rejection, 'Không xem được báo giá. Kiểm tra kết nối rồi thử lại.'), 'plain');
      }
    }
  }

  // US-20-TC09, TC13: chỉ gửi sau khi tích điều khoản; gửi đúng nội dung vừa báo giá kèm Idempotency-Key.
  async function handleSubmit() {
    if (!quotedInput || !agreed || submitting) return;
    const account = accountId;
    setSubmitting(true);
    setError('');
    const payload = JSON.stringify(quotedInput);
    if (pendingKey.current?.payload !== payload) pendingKey.current = { payload, key: crypto.randomUUID() };
    try {
      const created = await upgradesApi.create(quotedInput, pendingKey.current.key);
      if (currentAccount.current !== account) return;
      pendingKey.current = null;
      clearQuote();
      setResult(created);
      if (created.transactionStatus === 'PENDING') {
        // US-20-TC09: phải thu > 0 → chờ Staff/Admin xác nhận thu, hiện hướng dẫn thanh toán.
        void loadGuide(created.transactionId, account);
      } else {
        // US-20-TC06: phải thu 0 đã hoàn tất → tải lại danh sách gói để thấy gói mới.
        void load();
      }
    } catch (rejection) {
      if (currentAccount.current !== account) return;
      handleCreateError(rejection);
    } finally {
      if (currentAccount.current === account) setSubmitting(false);
    }
  }

  function handleCreateError(rejection: unknown) {
    // US-20-TC13: chưa rõ server đã ghi nhận chưa → giữ báo giá và key; "Thử lại" gửi lại CÙNG key.
    if (isUnknownOutcome(rejection)) {
      showError(`${messageOf(rejection, 'Không gửi được đề nghị nâng cấp.')} Chưa rõ đề nghị đã được ghi nhận chưa, bấm "Thử lại".`, 'retry');
      return;
    }
    // Server đã từ chối chắc chắn → bỏ key và báo giá cũ; lần sau là một đề nghị mới với key mới.
    pendingKey.current = null;
    setQuote(null);
    setQuotedInput(null);
    setAgreed(false);
    const code = codeOf(rejection) ?? '';
    if (code === 'QUOTE_EXPIRED') {
      // US-20-TC07: không sửa tiền ngầm, không tự gửi lại; Member phải xem báo giá mới và xác nhận lại.
      showError('Báo giá đã hết hạn. Bấm "Xem báo giá mới" để xem lại số tiền rồi xác nhận lại.', 'expired');
    } else if (STALE_CODES.includes(code)) {
      showError('Thông tin gói đã thay đổi. Bấm "Tải lại" để xem dữ liệu mới rồi xác nhận lại.', 'stale');
    } else {
      showError(messageOf(rejection, 'Không gửi được đề nghị nâng cấp.'), 'plain');
    }
  }

  async function loadGuide(transactionId: string, account: string | null) {
    try {
      const instructions = await upgradesApi.paymentInstructions(transactionId);
      if (currentAccount.current === account) setGuide(instructions);
    } catch {
      // Không tải được hướng dẫn thì vẫn còn mã giao dịch để đọc cho quầy.
    }
  }

  return <section className="auth-card membership-upgrade">
    <h2>Nâng cấp gói</h2>

    {loadError && <div role="alert">{loadError}</div>}

    {/* US-20 mục 2: quyền lợi gói hiện tại để so sánh với gói đích. */}
    {current && <section aria-label="Gói hiện tại">
      <h3>Gói hiện tại</h3>
      <p>{current.planName}</p>
      <p>{current.benefits}</p>
      <p>Hiệu lực đến hết ngày {formatDate(current.endDate)}</p>
    </section>}

    {options && options.length === 0 && <p>Chưa có gói nào để nâng cấp từ gói này.</p>}

    {!result && options && options.length > 0 && <>
      {/* US-20-TC01: chỉ hiện các gói đích server cho phép. */}
      <section aria-labelledby="upgrade-targets-title">
        <h3 id="upgrade-targets-title">Gói có thể nâng cấp</h3>
        {options.map(option => <article key={option.targetPlanId} aria-label={option.name}>
          <h4>{option.name}</h4>
          <p>Giá: {formatVnd(option.price)}</p>
          <p>Thời hạn: {option.durationDays} ngày</p>
          {option.sessionsQuota > 0 && <p>Số buổi PT: {option.sessionsQuota}</p>}
          <button type="button" aria-pressed={selected?.targetPlanId === option.targetPlanId} onClick={() => choose(option)}>
            Chọn gói này
          </button>
        </article>)}
      </section>

      <fieldset>
        <legend>Cách thanh toán dự kiến</legend>
        <label><input type="radio" name="upgrade-method" checked={method === 'CASH'} onChange={() => changeMethod('CASH')} />
          Tiền mặt tại quầy</label>
        <label><input type="radio" name="upgrade-method" checked={method === 'TRANSFER'} onChange={() => changeMethod('TRANSFER')} />
          Chuyển khoản</label>
      </fieldset>
      <button type="button" disabled={!selected} onClick={() => void handlePreview()}>Xem báo giá</button>
    </>}

    {/* US-20-TC06, TC13: hiện đúng số server trả; phần dư không hoàn, không thành ví. */}
    {quote && <section aria-label="Báo giá nâng cấp">
      <h3>Báo giá nâng cấp</h3>
      <p>Số ngày còn lại của gói hiện tại: {quote.remainingDays}/{quote.totalDays} ngày (tính cả hôm nay)</p>
      <p>Giá trị còn lại của gói hiện tại: {formatVnd(quote.rawCredit)}</p>
      <p>Được trừ vào gói mới: {formatVnd(quote.appliedCredit)}</p>
      <p>Phần dư không dùng được: {formatVnd(quote.excessCredit)}</p>
      <p>Phần dư không được hoàn tiền và không chuyển thành ví.</p>
      <p>Số tiền phải trả: {formatVnd(quote.amountDue)}</p>
      {/* US-20-TC13: gói PT mang sang số buổi đã dùng, không reset về 0. */}
      {quote.targetSessions > 0 && <ul>
        <li>Buổi PT đã dùng: {quote.quotaSummary.used} (mang sang gói mới)</li>
        <li>Buổi PT đang giữ chỗ: {quote.quotaSummary.reserved}</li>
      </ul>}
      <p>Ngày báo giá: {formatDate(quote.asOfDate)}. Báo giá có hiệu lực đến {formatVietnamTime(quote.quoteExpiresAt)} (giờ Việt Nam).</p>

      {quote.canProceed
        ? <>
          <label><input type="checkbox" checked={agreed} onChange={event => setAgreed(event.target.checked)} />
            Tôi đồng ý điều khoản nâng cấp</label>
          <button type="button" disabled={!agreed || submitting} onClick={() => void handleSubmit()}>Gửi đề nghị nâng cấp</button>
        </>
        // US-20-TC08: không đủ điều kiện thì nói lý do, không có nút gửi.
        : <p>{(quote.blockingCode && REASON_LABELS[quote.blockingCode]) || 'Hiện chưa thể nâng cấp sang gói này.'}</p>}
    </section>}

    {error && <div role="alert">
      {error}
      {errorKind === 'stale' && <button type="button" onClick={reload}>Tải lại</button>}
      {errorKind === 'expired' && <button type="button" onClick={() => void handlePreview()}>Xem báo giá mới</button>}
      {errorKind === 'retry' && <button type="button" disabled={submitting} onClick={() => void handleSubmit()}>Thử lại</button>}
    </div>}

    {/* US-20-TC13: PENDING chỉ là chờ thu – gói cũ vẫn hiệu lực, không hiện ngày hết hạn mới như quyền đã cấp. */}
    {result && <section aria-label="Kết quả nâng cấp">
      <h3>Kết quả nâng cấp</h3>
      <p>Mã giao dịch: {result.transactionCode}</p>
      {result.transactionStatus === 'PENDING'
        ? <>
          <p>Chờ xác nhận thu – {formatVnd(result.amountDue)}</p>
          <p>Gói hiện tại vẫn còn hiệu lực theo kỳ cũ. Gói mới chỉ được cấp sau khi quầy xác nhận đã thu đủ tiền.</p>
        </>
        : <p>Nâng cấp đã hoàn tất. Gói mới đã có trong danh sách gói của bạn.</p>}
      {guide && <div>
        <p>{guide.cashInstruction}</p>
        {guide.transferOptions?.map(option => <p key={option.receivingAccountCode}>
          {option.bankName} – {option.accountNumber} – {option.accountName}. Nội dung chuyển khoản: {option.transferContent}
        </p>)}
      </div>}
      <Link to="/member/memberships">Lịch sử giao dịch</Link>
    </section>}
  </section>;
}
