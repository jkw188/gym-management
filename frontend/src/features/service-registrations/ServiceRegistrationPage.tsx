// Tầng giao diện – trang (US-18 bước 3): /member/service-registrations – Member chọn gói, ngày bắt đầu, cách trả dự kiến,
// xem trước giá do server tính, tạo yêu cầu mua, xem hướng dẫn chờ thu, lịch sử mua và tự hủy yêu cầu đúng quyền.
// Giá, ngày kết thúc, canCancel, version lấy nguyên từ server; trang không tự tính và không bao giờ gọi confirm-payment (US-18-F03).
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { useAccountId } from '../notifications/inbox-signals';
import { formatVnd } from '../plans/plans.api';
import type { PublicPlan } from '../services/services.api';
import {
  isValidCancelReason, serviceRegistrationsApi, type CancelInput, type MySale, type PaymentInstructions, type PaymentMethod,
  type RegistrationInput, type RegistrationQuote, type RegistrationResult, type SaleStatus,
} from './service-registrations.api';

// "2026-12-04" → "04/12/2026" (ngày đã là ngày Việt Nam do server tính).
const formatDay = (day: string) => day.split('-').reverse().join('/');
// Hôm nay theo giờ Việt Nam, dạng YYYY-MM-DD, làm giá trị mặc định cho ô ngày bắt đầu.
const todayVn = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());

const STATUS_LABELS: Record<SaleStatus, string> = {
  PENDING: 'Chờ xác nhận thu',
  SETTLED: 'Đã thanh toán',
  CANCELLED: 'Đã hủy',
};

// US-18-TC03: lý do server báo chưa đăng ký được (preview canProceed=false).
const BLOCKING_LABELS: Record<string, string> = {
  CURRENT_SERVICE_EXISTS: 'Bạn đã có gói cùng loại đang hiệu lực hoặc sắp hiệu lực nên chưa thể đăng ký thêm.',
  PENDING_SALE_EXISTS: 'Bạn đang có yêu cầu mua gói cùng loại chờ nhân viên xác nhận thu. Hãy thanh toán hoặc hủy yêu cầu đó trước.',
};

const NOT_LINKED = 'Tài khoản của bạn chưa được liên kết hồ sơ hội viên. Vui lòng liên hệ quầy lễ tân để được liên kết trước khi đăng ký gói.';
const TRANSFER_UNAVAILABLE = 'Chuyển khoản hiện không khả dụng. Vui lòng chọn Tiền mặt.';
const PLAN_CHANGED = 'Gói đã thay đổi hoặc ngừng bán. Danh mục đã được tải lại, hãy chọn lại gói và xem trước.';

const codeOf = (error: unknown) => (error instanceof ApiError ? error.code : undefined);

// 400 hiện message trong error.details (US-18-TC03); lỗi khác hiện message của server.
function describeError(error: unknown, fallback: string) {
  if (error instanceof ApiError) {
    if (error.status === 400 && error.details?.length) return error.details.map(detail => detail.message).join(' ');
    if (error.message) return error.message;
  }
  return fallback;
}

// US-18-TC09: mất phản hồi hoặc 503 hạ tầng → chưa biết server đã tạo hay chưa, phải gửi lại CÙNG key.
// 503 thiếu cấu hình chuyển khoản là lỗi chắc chắn (chưa tạo gì) nên không tính.
function isUnknownOutcome(error: unknown) {
  if (!(error instanceof ApiError)) return true;
  if (error.status === undefined) return true;
  return error.status >= 500 && error.code !== 'RECEIVING_ACCOUNTS_NOT_CONFIGURED';
}

export function ServiceRegistrationPage() {
  const accountId = useAccountId();

  // Dữ liệu từ server.
  const [plans, setPlans] = useState<PublicPlan[] | null>(null);
  const [plansError, setPlansError] = useState('');
  const [memberLinked, setMemberLinked] = useState<boolean | null>(null);
  const [history, setHistory] = useState<MySale[] | null>(null);
  const [historyError, setHistoryError] = useState('');

  // Form chọn gói/ngày/cách trả.
  const [planId, setPlanId] = useState('');
  const [startDate, setStartDate] = useState(todayVn);
  const [method, setMethod] = useState<PaymentMethod>('CASH');

  // Xem trước và tạo yêu cầu.
  const [quote, setQuote] = useState<RegistrationQuote | null>(null);
  const [quotedInput, setQuotedInput] = useState<RegistrationInput | null>(null);
  const [formError, setFormError] = useState('');
  const [canRetry, setCanRetry] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<RegistrationResult | null>(null);

  // Hướng dẫn thanh toán.
  const [guide, setGuide] = useState<PaymentInstructions | null>(null);
  const [guideError, setGuideError] = useState('');

  // Tự hủy yêu cầu.
  const [cancelTarget, setCancelTarget] = useState<MySale | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState('');
  const [cancelNotice, setCancelNotice] = useState('');

  // US-18-TC12: ref chặn bấm kép ngay lập tức (state chỉ cập nhật ở lần render sau).
  const submittingNow = useRef(false);
  const cancellingNow = useRef(false);
  // US-18-TC09: key gắn với nội dung yêu cầu; cùng nội dung (Thử lại) → cùng key, đổi nội dung → key mới.
  const pendingKey = useRef<{ payload: string; key: string } | null>(null);
  const pendingCancelKey = useRef<{ payload: string; key: string } | null>(null);
  // Số thứ tự lần tải, bỏ kết quả về muộn của lần tải cũ (hoặc của account cũ).
  const plansLoad = useRef(0);
  const historyLoad = useRef(0);
  const guideLoad = useRef(0);

  const loadPlans = useCallback(async () => {
    const loadNumber = ++plansLoad.current;
    setPlansError('');
    if (!accountId) return;
    try {
      const page = await serviceRegistrationsApi.listPlans();
      if (loadNumber === plansLoad.current) setPlans(page.items);
    } catch (error) {
      if (loadNumber === plansLoad.current) setPlansError(describeError(error, 'Không tải được danh mục gói.'));
    }
  }, [accountId]);

  const loadHistory = useCallback(async () => {
    const loadNumber = ++historyLoad.current;
    setHistoryError('');
    if (!accountId) return;
    try {
      const page = await serviceRegistrationsApi.listMySales();
      if (loadNumber !== historyLoad.current) return;
      // US-18-TC02: chưa liên kết hồ sơ → hướng dẫn liên hệ quầy, không cho đăng ký.
      setMemberLinked(page.memberLinked);
      setHistory(page.items);
    } catch (error) {
      if (loadNumber === historyLoad.current) setHistoryError(describeError(error, 'Không tải được lịch sử mua gói.'));
    }
  }, [accountId]);

  async function loadGuide(transactionId: string) {
    const loadNumber = ++guideLoad.current;
    setGuide(null);
    setGuideError('');
    try {
      const instructions = await serviceRegistrationsApi.paymentInstructions(transactionId);
      if (loadNumber === guideLoad.current) setGuide(instructions);
    } catch (error) {
      // US-18-TC07: 404 → báo không tìm thấy giao dịch, không hiện hướng dẫn cũ.
      if (loadNumber === guideLoad.current) setGuideError(describeError(error, 'Không tải được hướng dẫn thanh toán.'));
    }
  }

  // US-18-TC02: đổi account thì xóa ngay mọi dữ liệu của account trước (chạy trước các effect tải bên dưới).
  useEffect(() => {
    setPlans(null);
    setMemberLinked(null);
    setHistory(null);
    setPlanId('');
    setQuote(null);
    setQuotedInput(null);
    setFormError('');
    setCanRetry(false);
    setResult(null);
    setGuide(null);
    setGuideError('');
    setCancelTarget(null);
    setCancelError('');
    setCancelNotice('');
    pendingKey.current = null;
    pendingCancelKey.current = null;
    guideLoad.current += 1;
  }, [accountId]);

  useEffect(() => { void loadPlans(); }, [loadPlans]);
  useEffect(() => { void loadHistory(); }, [loadHistory]);

  // Đổi gói/ngày/cách trả thì bản xem trước cũ không còn đúng → phải xem trước lại.
  function clearQuote() {
    setQuote(null);
    setQuotedInput(null);
    setFormError('');
    setCanRetry(false);
  }

  // Lỗi chắc chắn (server đã từ chối) của xem trước hoặc tạo.
  function showRejection(error: unknown) {
    const code = codeOf(error);
    if (code === 'MEMBER_PROFILE_REQUIRED') { setMemberLinked(false); return; }
    // US-18-TC08: chuyển khoản chưa cấu hình → gợi ý chọn Tiền mặt trước khi tạo.
    if (code === 'RECEIVING_ACCOUNTS_NOT_CONFIGURED') { setFormError(TRANSFER_UNAVAILABLE); return; }
    // US-18-TC03: gói đổi version hoặc ngừng bán → tải lại danh mục để lấy version mới.
    if (code === 'PLAN_CHANGED' || code === 'PLAN_NOT_AVAILABLE') { setFormError(PLAN_CHANGED); void loadPlans(); return; }
    setFormError(describeError(error, 'Không gửi được yêu cầu.'));
  }

  // US-18-TC01: Xem trước gửi ĐÚNG 4 field; planVersion lấy từ danh mục để server phát hiện gói đã đổi.
  async function handlePreview() {
    clearQuote();
    const plan = plans?.find(item => item.id === planId);
    if (!plan) { setFormError('Hãy chọn gói tập.'); return; }
    if (!startDate) { setFormError('Hãy chọn ngày bắt đầu.'); return; }
    const input: RegistrationInput = { planId: plan.id, planVersion: plan.version, startDate, preferredPaymentMethod: method };
    try {
      const preview = await serviceRegistrationsApi.preview(input);
      setQuote(preview);
      setQuotedInput(input);
    } catch (error) {
      showRejection(error);
    }
  }

  // US-18-TC01, TC05, TC06, TC09, TC12: gửi yêu cầu đúng nội dung vừa xem trước.
  async function handleConfirm() {
    if (!quotedInput || submittingNow.current) return;
    submittingNow.current = true;
    setSubmitting(true);
    setFormError('');
    setCanRetry(false);
    const payload = JSON.stringify(quotedInput);
    if (pendingKey.current?.payload !== payload) pendingKey.current = { payload, key: crypto.randomUUID() };

    try {
      const created = await serviceRegistrationsApi.create(quotedInput, pendingKey.current.key);
      // Xong một ý định: bỏ key, bỏ bản xem trước, hiện kết quả của server.
      pendingKey.current = null;
      setQuote(null);
      setQuotedInput(null);
      setResult(created);
      setGuide(null);
      setGuideError('');
      // US-18-TC06: gói 0đ đã hoàn tất, không cần hướng dẫn thanh toán.
      if (created.transactionStatus === 'PENDING' && created.amountDue !== '0') void loadGuide(created.transactionId);
      void loadHistory();
    } catch (error) {
      if (isUnknownOutcome(error)) {
        // US-18-TC09: giữ bản xem trước và key; "Thử lại" gửi lại CÙNG key nên server không tạo hai yêu cầu.
        setFormError(`${describeError(error, 'Không gửi được yêu cầu.')} Chưa rõ yêu cầu đã được ghi nhận chưa, bấm "Thử lại".`);
        setCanRetry(true);
      } else {
        pendingKey.current = null;
        setQuote(null);
        setQuotedInput(null);
        showRejection(error);
        void loadHistory();
      }
    } finally {
      submittingNow.current = false;
      setSubmitting(false);
    }
  }

  // US-18-TC11: nút "Hủy yêu cầu" chỉ mở ô nhập lý do, chưa gửi gì.
  function openCancel(sale: MySale) {
    setCancelTarget(sale);
    setCancelReason('');
    setCancelError('');
    setCancelNotice('');
  }

  // US-18-TC11, TC12: gửi hủy với version của server và Idempotency-Key.
  async function handleCancel() {
    if (!cancelTarget || cancellingNow.current || !isValidCancelReason(cancelReason)) return;
    cancellingNow.current = true;
    setCancelling(true);
    setCancelError('');
    const input: CancelInput = { version: cancelTarget.transactionVersion ?? 0, reason: cancelReason.trim() };
    const payload = JSON.stringify({ id: cancelTarget.id, ...input });
    if (pendingCancelKey.current?.payload !== payload) pendingCancelKey.current = { payload, key: crypto.randomUUID() };

    try {
      await serviceRegistrationsApi.cancel(cancelTarget.id, input, pendingCancelKey.current.key);
      pendingCancelKey.current = null;
      setCancelNotice(`Yêu cầu "${cancelTarget.planName}" đã được hủy.`);
      setCancelTarget(null);
      await loadHistory();
    } catch (error) {
      setCancelError(describeError(error, 'Không gửi được yêu cầu hủy.'));
      if (!isUnknownOutcome(error)) {
        // Server từ chối (vd nhân viên vừa thu tiền – 409): đóng ô hủy, tải lại lịch sử để thấy trạng thái mới.
        pendingCancelKey.current = null;
        setCancelTarget(null);
        await loadHistory();
      }
    } finally {
      cancellingNow.current = false;
      setCancelling(false);
    }
  }

  return <section className="auth-card service-registrations">
    <h2>Đăng ký gói tập</h2>

    {memberLinked === false ? <p className="hint">{NOT_LINKED}</p> : <>
      <section aria-labelledby="registration-form">
        <h3 id="registration-form">Chọn gói</h3>
        {plansError && <p role="alert">{plansError}</p>}
        <label>Gói tập
          <select value={planId} onChange={event => { setPlanId(event.target.value); clearQuote(); }}>
            <option value="">-- Chọn gói --</option>
            {(plans ?? []).map(plan => <option key={plan.id} value={plan.id}>
              {plan.name} ({plan.kind}) – {formatVnd(plan.price)}
            </option>)}
          </select>
        </label>
        <label>Ngày bắt đầu
          <input type="date" value={startDate} min={todayVn()}
            onChange={event => { setStartDate(event.target.value); clearQuote(); }} />
        </label>
        <fieldset>
          <legend>Cách trả dự kiến</legend>
          <label><input type="radio" name="preferred-method" checked={method === 'CASH'}
            onChange={() => { setMethod('CASH'); clearQuote(); }} /> Tiền mặt tại quầy</label>
          <label><input type="radio" name="preferred-method" checked={method === 'TRANSFER'}
            onChange={() => { setMethod('TRANSFER'); clearQuote(); }} /> Chuyển khoản</label>
        </fieldset>
        <button type="button" onClick={() => void handlePreview()}>Xem trước</button>
        {formError && <p role="alert">{formError}</p>}
        {canRetry && <button type="button" disabled={submitting} onClick={() => void handleConfirm()}>Thử lại</button>}
      </section>

      {quote && <section aria-labelledby="registration-preview">
        <h3 id="registration-preview">Xem trước</h3>
        <p>Số tiền phải trả: {formatVnd(quote.amountDue)}</p>
        <p>Thời gian dự kiến: {formatDay(quote.requestedStartDate)} – {formatDay(quote.expectedEndDate)}</p>
        <p className="hint">Số tiền và ngày do hệ thống tính. Gói chỉ có hiệu lực sau khi nhân viên xác nhận đã thu đủ tiền.</p>
        {quote.canProceed
          ? <button type="button" disabled={submitting} onClick={() => void handleConfirm()}>Xác nhận đăng ký</button>
          : <p>{(quote.blockingCode && BLOCKING_LABELS[quote.blockingCode]) || 'Hiện chưa thể đăng ký gói này.'}</p>}
      </section>}

      {result && <section aria-labelledby="registration-result">
        <h3 id="registration-result">Kết quả đăng ký</h3>
        <p>Mã giao dịch: {result.transactionCode}</p>
        <p>Số tiền: {formatVnd(result.amountDue)}</p>
        <p>Thời gian: {formatDay(result.startDate)} – {formatDay(result.endDate)}</p>
        {result.transactionStatus === 'SETTLED'
          ? <p>Đăng ký hoàn tất: gói miễn phí đã có hiệu lực, không cần thanh toán.</p>
          : <p>Chờ nhân viên xác nhận thu. Gói chỉ có hiệu lực sau khi nhân viên xác nhận đã thu đủ tiền.</p>}
      </section>}

      {(guide || guideError) && <PaymentGuide guide={guide} error={guideError} />}

      <section aria-labelledby="registration-history">
        <h3 id="registration-history">Yêu cầu mua gói của tôi</h3>
        {historyError && <p role="alert">{historyError}</p>}
        {cancelError && <p role="alert">{cancelError}</p>}
        {history === null && !historyError && <p>Đang tải…</p>}
        {history?.length === 0 && <p>Bạn chưa có yêu cầu mua gói nào.</p>}
        {history?.map(sale => <SaleCard key={sale.id} sale={sale}
          onShowGuide={() => void loadGuide(sale.transactionId)} onOpenCancel={() => openCancel(sale)}
          cancelOpen={cancelTarget?.id === sale.id} cancelReason={cancelReason} cancelling={cancelling}
          onReasonChange={setCancelReason} onConfirmCancel={() => void handleCancel()} onCloseCancel={() => setCancelTarget(null)} />)}
      </section>
      {cancelNotice && <p role="status">{cancelNotice}</p>}
    </>}
  </section>;
}

// US-18-TC07, TC08: hướng dẫn thanh toán; mỗi tài khoản nhận là một thẻ. Không có transferOptions thì không hiện tài khoản nào.
function PaymentGuide({ guide, error }: { guide: PaymentInstructions | null; error: string }) {
  return <section aria-labelledby="payment-guide">
    <h3 id="payment-guide">Hướng dẫn thanh toán</h3>
    {error && <p role="alert">{error}</p>}
    {guide && <>
      <p>Mã giao dịch: {guide.transactionCode}</p>
      <p>Số tiền cần trả: {formatVnd(guide.amountDue)}</p>
      <p>{guide.cashInstruction}</p>
      {(guide.transferOptions ?? []).map(option => <article key={option.receivingAccountCode} aria-label={option.bankName}>
        <h4>{option.bankName}</h4>
        <p>Số tài khoản: {option.accountNumber}</p>
        <p>Chủ tài khoản: {option.accountName}</p>
        <p>Nội dung chuyển khoản: {option.transferContent}</p>
      </article>)}
      <p className="hint">Sau khi chuyển khoản, nhân viên sẽ đối chiếu và xác nhận thu; trang này không tự xác nhận đã nhận tiền.</p>
    </>}
  </section>;
}

interface SaleCardProps {
  sale: MySale;
  cancelOpen: boolean;
  cancelReason: string;
  cancelling: boolean;
  onShowGuide: () => void;
  onOpenCancel: () => void;
  onReasonChange: (reason: string) => void;
  onConfirmCancel: () => void;
  onCloseCancel: () => void;
}

// Một lần mua trong lịch sử. Nút "Hủy yêu cầu" chỉ khi server báo canCancel (US-18-TC11).
function SaleCard(props: SaleCardProps) {
  const { sale } = props;
  return <article aria-label={sale.planName}>
    <h4>{sale.planName}</h4>
    <p>{sale.status ? STATUS_LABELS[sale.status] : 'Chưa rõ trạng thái'}</p>
    {sale.amountDue !== undefined && <p>Số tiền: {formatVnd(sale.amountDue)}</p>}
    <p>Thời gian: {formatDay(sale.startDate)} – {formatDay(sale.endDate)}</p>
    <p>{sale.channel === 'SELF_SERVICE' ? 'Tự đăng ký' : 'Mua tại quầy'}</p>
    {sale.status === 'PENDING' && <button type="button" onClick={props.onShowGuide}>Xem hướng dẫn thanh toán</button>}
    {sale.canCancel && !props.cancelOpen && <button type="button" onClick={props.onOpenCancel}>Hủy yêu cầu</button>}
    {props.cancelOpen && <div>
      <label>Lý do hủy
        <textarea value={props.cancelReason} maxLength={500} onChange={event => props.onReasonChange(event.target.value)} />
      </label>
      <p className="hint">Lý do dài 10–500 ký tự.</p>
      <button type="button" disabled={props.cancelling || !isValidCancelReason(props.cancelReason)}
        onClick={props.onConfirmCancel}>Xác nhận hủy</button>
      <button type="button" disabled={props.cancelling} onClick={props.onCloseCancel}>Đóng</button>
    </div>}
  </article>;
}
