import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../App';
import { ApiError, apiClient } from '../../api/client';
import { resolveReturnTo } from '../auth/auth.routes';
import { inventoryApi } from '../inventory/inventory.api';
import { StockAdjustmentEditor } from './StockAdjustmentEditor';
import { StockAdjustmentsPage } from './StockAdjustmentsPage';
import { stockAdjustmentsApi as api, type Adjustment } from './stock-adjustments.api';
import type { PostedReceipt, ProductOption, StockPage } from './stock-receipts.api';

const productId = 'b'.repeat(24), id = 'a'.repeat(24), at = '2026-11-17T00:00:00Z';
const option: ProductOption = { id: productId, sku: 'WATER', name: 'Nước', status: 'INACTIVE', effectiveActive: false, inventoryState: 'VALID' };
const row: Adjustment = { id, code: `ADJ-${id}`, status: 'DRAFT', version: 0, reason: 'Kiểm kê theo biên bản', sourceReference: 'COUNT_39', totalCost: '10000',
  createdBy: 'c'.repeat(24), updatedBy: 'c'.repeat(24), postedBy: null, postedAt: null, createdAt: at, updatedAt: at, stale: false,
  items: [{ id: 'd'.repeat(24), productId, countedQuantity: 8, baseOnHand: 10, baseInventoryVersion: 1, countedAt: at, quantityDelta: -2,
    currentOnHand: 10, currentReserved: 3, currentInventoryVersion: 1, inventoryState: 'VALID', stale: false, unitCost: '5000', lineTotalCost: '10000', skuSnapshot: 'WATER', nameSnapshot: 'Nước', inactiveWarning: true }], movements: [], movementIds: [],
  audit: [{ id: 'f'.repeat(24), action: 'CREATED', actorId: 'c'.repeat(24), occurredAt: at, before: null, after: { version: 0, reason: 'Kiểm kê theo biên bản' } }] };
const posted: PostedReceipt = { id, code: row.code, status: 'POSTED', version: 1, postedBy: row.createdBy, postedAt: at, totalCost: '10000', movementIds: ['e'.repeat(24)] };
const page = <T,>(items: T[]): StockPage<T> => ({ items, page: 1, limit: 20, total: items.length, totalPages: items.length ? 1 : 0 });
const editor = (initial?: Adjustment) => render(<MemoryRouter><StockAdjustmentEditor initial={initial} onClose={vi.fn()} onChanged={vi.fn()} /></MemoryRouter>);
beforeEach(() => {
  vi.spyOn(api, 'options').mockResolvedValue(page([option])); vi.spyOn(api, 'detail').mockResolvedValue(row); vi.spyOn(api, 'list').mockResolvedValue(page([row]));
  vi.spyOn(inventoryApi, 'detail').mockResolvedValue({ productId, categoryId: 'f'.repeat(24), sku: option.sku, name: option.name, productStatus: 'INACTIVE', effectiveActive: false, inventoryState: 'VALID', onHand: 10, reserved: 3, available: 7, version: 1, asOf: at });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); window.history.pushState({}, '', '/'); });

describe('US-39 F01–05 / TC12: count UI and operation recovery', () => {
  it('adds inactive SKU once, requires explicit count, shows delta and sends the GET version without mutating inventory', async () => {
    const save = vi.spyOn(api, 'save').mockResolvedValue(row), post = vi.spyOn(api, 'post'); editor();
    fireEvent.change(screen.getByLabelText('Lý do kiểm kê'), { target: { value: 'Kiểm kê theo biên bản' } });
    fireEvent.change(screen.getByLabelText('Chứng từ nguồn'), { target: { value: 'COUNT_39' } });
    await screen.findByRole('option', { name: /WATER · Nước · Ngừng bán/ });
    fireEvent.change(screen.getByLabelText('Chọn SKU'), { target: { value: productId } });
    await userEvent.click(screen.getByRole('button', { name: 'Thêm dòng' }));
    const count = await screen.findByLabelText('Số đếm WATER'); expect(count).toHaveProperty('value', '');
    expect(screen.getByRole('option', { name: /WATER · Nước/ })).toHaveProperty('disabled', true);
    fireEvent.change(count, { target: { value: '8' } });
    fireEvent.change(screen.getByLabelText('Đơn giá ghi nhận VND WATER'), { target: { value: '5000' } });
    expect(screen.getByText('Chênh lệch dự kiến: -2')).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Lưu nháp' }));
    expect(save).toHaveBeenCalledWith({ reason: row.reason, sourceReference: row.sourceReference, items: [{ productId, countedQuantity: 8, expectedInventoryVersion: 1, unitCost: '5000' }] }, expect.any(String), undefined);
    await screen.findByText('Đã lưu nháp. Tồn kho chưa thay đổi.'); expect(post).not.toHaveBeenCalled();
  });

  it('stale count cannot be saved or posted; recount clears every old number and sends only a newly entered count', async () => {
    const stale = { ...row, stale: true, items: [{ ...row.items[0], stale: true, currentInventoryVersion: 2, currentReserved: 4 }] };
    vi.mocked(api.detail).mockResolvedValue(stale); vi.mocked(inventoryApi.detail).mockResolvedValue({ ...(await inventoryApi.detail(productId)), version: 2, reserved: 4 });
    const save = vi.spyOn(api, 'save').mockResolvedValue({ ...row, version: 1 }); editor(stale);
    expect(screen.getByRole('button', { name: 'Ghi sổ' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Lưu nháp' })).toHaveProperty('disabled', true);
    expect(screen.getByText(/Mốc kiểm kê đã cũ/)).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Kiểm đếm lại và nhập số mới' }));
    await waitFor(() => expect(screen.getByLabelText('Số đếm WATER')).toHaveProperty('value', ''));
    expect(save).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Số đếm WATER'), { target: { value: '9' } });
    await userEvent.click(screen.getByRole('button', { name: 'Lưu nháp' }));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ version: 0, items: [{ productId, countedQuantity: 9, expectedInventoryVersion: 2, unitCost: '5000' }] }), expect.any(String), id);
  });

  it('requires whole-document confirmation and blocks double submit; POSTED is immutable and zero movement is explained', async () => {
    let resolve!: (result: PostedReceipt) => void;
    const post = vi.spyOn(api, 'post').mockReturnValue(new Promise(done => { resolve = done; }));
    vi.mocked(api.detail).mockResolvedValue({ ...row, ...posted, totalCost: '0', movementIds: [], items: [{ ...row.items[0], countedQuantity: 10, quantityDelta: 0 }] });
    editor(row); await userEvent.click(screen.getByRole('button', { name: 'Ghi sổ' }));
    expect(await screen.findByRole('dialog', { name: 'Xác nhận ghi sổ' })).toBeDefined(); expect(post).not.toHaveBeenCalled();
    await userEvent.dblClick(screen.getByRole('button', { name: 'Xác nhận ghi sổ' })); expect(post).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Đóng form' })).toHaveProperty('disabled', true);
    resolve(posted); await screen.findByText('Đã ghi sổ kiểm kê.');
    expect(screen.queryByRole('button', { name: 'Lưu nháp' })).toBeNull(); expect(screen.getByLabelText('Lý do kiểm kê').matches(':disabled')).toBe(true);
    expect(screen.getByText(/Chênh lệch bằng 0: ghi nhận kiểm kê/)).toBeDefined();
  });

  it('unknown outcome freezes key/payload through lookup 404; same request replay resolves without a new count', async () => {
    const post = vi.spyOn(api, 'post').mockRejectedValueOnce(new ApiError('Mất phản hồi', 503, undefined, undefined, undefined, 'OPERATION_OUTCOME_UNKNOWN')).mockResolvedValueOnce(posted);
    vi.spyOn(api, 'lookup').mockRejectedValueOnce(new ApiError('Chưa thấy kết quả', 404, undefined, undefined, undefined, 'OPERATION_UNKNOWN'));
    vi.mocked(api.detail).mockResolvedValue({ ...row, ...posted });
    editor(row); await userEvent.click(screen.getByRole('button', { name: 'Ghi sổ' })); await userEvent.click(screen.getByRole('button', { name: 'Xác nhận ghi sổ' }));
    await screen.findByText('Mất phản hồi');
    expect(screen.getByRole('button', { name: 'Kiểm đếm lại và nhập số mới' })).toHaveProperty('disabled', true);
    await userEvent.click(screen.getByRole('button', { name: 'Tra cứu kết quả' })); await screen.findByText('Chưa thấy kết quả');
    expect(screen.getByRole('button', { name: 'Đóng form' })).toHaveProperty('disabled', true);
    await userEvent.click(screen.getByRole('button', { name: 'Gửi lại cùng yêu cầu' })); await screen.findByText('Đã ghi sổ kiểm kê.');
    expect(post.mock.calls[1]).toEqual(post.mock.calls[0]); expect(api.lookup).toHaveBeenCalledWith('STOCK_ADJUST_POST', post.mock.calls[0][2]);
  });

  it('post conflict keeps old count visible and prevents automatic rebase', async () => {
    vi.spyOn(api, 'post').mockRejectedValue(new ApiError('Kho đã biến động', 409, undefined, undefined, undefined, 'COUNT_SNAPSHOT_STALE'));
    vi.mocked(inventoryApi.detail).mockResolvedValue({ ...(await inventoryApi.detail(productId)), version: 2, reserved: 4 });
    vi.mocked(inventoryApi.detail).mockClear();
    editor(row); await userEvent.click(screen.getByRole('button', { name: 'Ghi sổ' })); await userEvent.click(screen.getByRole('button', { name: 'Xác nhận ghi sổ' }));
    await screen.findByText('Kho đã biến động'); expect(screen.getByLabelText('Số đếm WATER')).toHaveProperty('value', '8');
    expect(screen.getByRole('button', { name: 'Ghi sổ' })).toHaveProperty('disabled', true);
    await screen.findByText(/Đang giữ hiện tại: 4 · Phiên bản hiện tại: 2/);
    expect(screen.getByText(/Tồn sổ tại mốc: 10 · Phiên bản kho 1/)).toBeDefined();
  });

  it('list filters/empty/error/retry and source deep link work', async () => {
    render(<MemoryRouter><StockAdjustmentsPage /></MemoryRouter>);
    await screen.findByRole('button', { name: `Mở ${row.code}` });
    vi.mocked(api.list).mockResolvedValueOnce(page([]));
    fireEvent.change(screen.getByLabelText('Tìm mã phiếu / chứng từ'), { target: { value: 'COUNT.*' } });
    await userEvent.click(screen.getByRole('button', { name: 'Lọc phiếu' })); await screen.findByText('Không có phiếu kiểm kê phù hợp.');
    expect(api.list).toHaveBeenCalledWith(expect.objectContaining({ q: 'COUNT.*', page: 1 }), expect.any(AbortSignal));
    vi.mocked(api.list).mockRejectedValueOnce(new ApiError('Không tải được'));
    await userEvent.click(screen.getByRole('button', { name: 'Tải lại danh sách' })); await screen.findByText('Không tải được');
    cleanup(); render(<MemoryRouter initialEntries={[`/admin/stock-adjustments?documentId=${id}`]}><StockAdjustmentsPage /></MemoryRouter>);
    await screen.findByRole('heading', { name: row.code }); expect(api.detail).toHaveBeenCalledWith(id, expect.any(AbortSignal));
  });

  it.each(['STAFF', 'MEMBER', 'TRAINER'] as const)('rejects %s at Admin route before fetching counts', async roleCode => {
    vi.spyOn(apiClient, 'getSnapshot').mockReturnValue({ status: 'authenticated', user: { id: 'c'.repeat(24), fullName: 'Test', phone: '0901234567', roleCode } });
    vi.spyOn(apiClient, 'subscribe').mockImplementation(() => () => {}); vi.spyOn(apiClient, 'restore').mockResolvedValue();
    window.history.pushState({}, '', '/admin/stock-adjustments'); render(<App />);
    await screen.findByText(/Không có quyền/); expect(api.list).not.toHaveBeenCalled();
    expect(resolveReturnTo('/admin/stock-adjustments', roleCode)).toBe(`/${roleCode.toLowerCase()}`);
  });
  it('preserves approved Admin returnTo', () => { expect(resolveReturnTo(`/admin/stock-adjustments?documentId=${id}`, 'ADMIN')).toBe(`/admin/stock-adjustments?documentId=${id}`); });
});
