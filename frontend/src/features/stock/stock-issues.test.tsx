import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../App';
import { ApiError, apiClient } from '../../api/client';
import { resolveReturnTo } from '../auth/auth.routes';
import { StockDocumentEditor } from './StockDocumentEditor';
import { StockIssuesPage } from './StockIssuesPage';
import { stockIssuesApi } from './stock-issues.api';
import { inventoryApi } from '../inventory/inventory.api';
import type { Receipt, ProductOption, StockPage, PostedReceipt } from './stock-receipts.api';

const option: ProductOption = { id: 'b'.repeat(24), sku: 'WATER', name: 'Nước', status: 'INACTIVE', effectiveActive: false, inventoryState: 'VALID' };
const row: Receipt = { id: 'a'.repeat(24), code: `ISS-${'a'.repeat(24)}`, status: 'DRAFT', version: 0, reason: 'Nhập hàng thực nhận', sourceReference: 'PO_36', totalCost: '50000',
  createdBy: 'c'.repeat(24), updatedBy: 'c'.repeat(24), postedBy: null, postedAt: null, createdAt: '2026-11-15T00:00:00Z', updatedAt: '2026-11-15T00:00:00Z',
  items: [{ id: 'd'.repeat(24), productId: option.id, quantity: 10, unitCost: '5000', lineTotalCost: '50000', skuSnapshot: option.sku, nameSnapshot: option.name, inactiveWarning: true }], movementIds: [], movements: [] };
const posted: PostedReceipt = { id: row.id, code: row.code, status: 'POSTED', version: 1, totalCost: row.totalCost, postedBy: row.createdBy, postedAt: '2026-11-15T01:00:00Z', movementIds: ['e'.repeat(24)] };
const postedDetail: Receipt = { ...row, ...posted, movements: [{ id: posted.movementIds[0], documentItemId: row.items[0].id, productId: option.id, sequence: 1,
  skuSnapshot: option.sku, nameSnapshot: option.name, onHandDelta: -10, reservedDelta: 0, beforeOnHand: 14, beforeReserved: 4, afterOnHand: 4, afterReserved: 4,
  sourceCode: row.code, sourceId: row.id, createdAt: posted.postedAt }] };
const page = <T,>(items: T[]): StockPage<T> => ({ items, total: items.length, page: 1, limit: 20, totalPages: items.length ? 1 : 0 });
beforeEach(() => {
  vi.spyOn(inventoryApi, 'detail').mockResolvedValue({ productId: option.id, categoryId: 'f'.repeat(24), sku: option.sku, name: option.name, productStatus: 'INACTIVE', effectiveActive: false, inventoryState: 'VALID', onHand: 14, reserved: 4, available: 10, version: 2, asOf: row.createdAt });
  vi.spyOn(stockIssuesApi, 'options').mockResolvedValue(page([option]));
  vi.spyOn(stockIssuesApi, 'detail').mockResolvedValue(row);
  vi.spyOn(stockIssuesApi, 'list').mockResolvedValue(page([row]));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); window.history.pushState({}, '', '/'); });

describe('US-38 TC12: receipt UI and operation recovery', () => {
  it('adds inactive SKU once, sends zero cost as string and displays server totals without posting draft', async () => {
    const saved = { ...row, totalCost: '0', items: [{ ...row.items[0], quantity: 1, unitCost: '0', lineTotalCost: '0' }] };
    const save = vi.spyOn(stockIssuesApi, 'save').mockResolvedValue(saved), post = vi.spyOn(stockIssuesApi, 'post');
    render(<StockDocumentEditor issue onClose={vi.fn()} onChanged={vi.fn()} />);
    await screen.findByRole('option', { name: /WATER · Nước · Ngừng bán/ });
    fireEvent.change(screen.getByLabelText('Lý do / chứng từ nguồn'), { target: { value: ' Hàng tặng theo chứng từ ' } });
    fireEvent.change(screen.getByLabelText('Mã chứng từ nguồn'), { target: { value: ' PO_36 ' } });
    fireEvent.change(screen.getByLabelText('Chọn SKU'), { target: { value: option.id } });
    await userEvent.click(screen.getByRole('button', { name: 'Thêm dòng' }));
    expect(screen.getByText(/ngừng bán vẫn được xuất ngoài bán/)).toBeDefined();
    expect(screen.getByRole('option', { name: /WATER · Nước · Ngừng bán/ })).toHaveProperty('disabled', true);
    await userEvent.click(screen.getByRole('button', { name: 'Lưu nháp' }));
    expect(save).toHaveBeenCalledWith({ reason: 'Hàng tặng theo chứng từ', sourceReference: 'PO_36', items: [{ productId: option.id, quantity: 1, unitCost: '0' }] }, expect.any(String), undefined);
    await screen.findByText('Đã lưu nháp. Tồn kho chưa thay đổi.'); expect(post).not.toHaveBeenCalled(); expect(screen.getByText('0 VND', { selector: 'strong' })).toBeDefined();
  });
  it('requires confirmation and disables double posting while pending, then shows immutable receipt and movement source', async () => {
    let finish!: (result: PostedReceipt) => void;
    const post = vi.spyOn(stockIssuesApi, 'post').mockReturnValue(new Promise(resolve => { finish = resolve; }));
    vi.mocked(stockIssuesApi.detail).mockResolvedValue(postedDetail);
    render(<StockDocumentEditor issue initial={row} onClose={vi.fn()} onChanged={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Ghi sổ' }));
    await screen.findByRole('dialog', { name: 'Xác nhận ghi sổ' }); expect(post).not.toHaveBeenCalled();
    await userEvent.dblClick(screen.getByRole('button', { name: 'Xác nhận ghi sổ' }));
    expect(post).toHaveBeenCalledTimes(1); expect(post).toHaveBeenCalledWith(row.id, 0, expect.any(String));
    expect(screen.getByRole('button', { name: 'Đóng form' })).toHaveProperty('disabled', true);
    finish(posted); await screen.findByText('Đã ghi sổ. Tồn kho đã được cập nhật.');
    expect(screen.queryByRole('button', { name: 'Lưu nháp' })).toBeNull(); expect(screen.getByLabelText('Lý do / chứng từ nguồn').matches(':disabled')).toBe(true);
    expect(screen.getByText(posted.movementIds[0])).toBeDefined(); expect(screen.getByText(/Nguồn:/).textContent).toContain(row.code);
  });
  it('keeps original post key/payload frozen after unknown response and lookup 404; replay resolves committed result', async () => {
    const post = vi.spyOn(stockIssuesApi, 'post').mockRejectedValueOnce(new ApiError('Mất phản hồi', 503, undefined, undefined, undefined, 'OPERATION_OUTCOME_UNKNOWN')).mockResolvedValueOnce(posted);
    vi.spyOn(stockIssuesApi, 'lookup').mockRejectedValueOnce(new ApiError('Chưa thấy kết quả', 404, undefined, undefined, undefined, 'OPERATION_UNKNOWN'));
    vi.mocked(stockIssuesApi.detail).mockResolvedValue(postedDetail);
    render(<StockDocumentEditor issue initial={row} onClose={vi.fn()} onChanged={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Ghi sổ' })); await userEvent.click(screen.getByRole('button', { name: 'Xác nhận ghi sổ' }));
    await screen.findByText('Mất phản hồi');
    expect(screen.getByLabelText('Số lượng WATER').matches(':disabled')).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Tra cứu kết quả' })); await screen.findByText('Chưa thấy kết quả');
    expect(screen.getByRole('button', { name: 'Đóng form' })).toHaveProperty('disabled', true);
    expect(stockIssuesApi.lookup).toHaveBeenCalledWith('STOCK_ISSUE_POST', post.mock.calls[0][2]);
    await userEvent.click(screen.getByRole('button', { name: 'Gửi lại cùng yêu cầu' }));
    await screen.findByText('Đã ghi sổ. Tồn kho đã được cập nhật.'); expect(post.mock.calls[1]).toEqual(post.mock.calls[0]);
  });
  it('keeps draft changes on version conflict, blocks posting dirty form, and reloads explicitly before retry', async () => {
    vi.spyOn(stockIssuesApi, 'save').mockRejectedValue(new ApiError('Phiên bản cũ', 409, undefined, undefined, undefined, 'VERSION_CONFLICT'));
    render(<StockDocumentEditor issue initial={row} onClose={vi.fn()} onChanged={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Số lượng WATER'), { target: { value: '7' } });
    expect(screen.getByRole('button', { name: 'Ghi sổ' })).toHaveProperty('disabled', true);
    await userEvent.click(screen.getByRole('button', { name: 'Lưu nháp' })); await screen.findByText('Phiên bản cũ');
    expect(screen.getByLabelText('Số lượng WATER')).toHaveProperty('value', '7'); expect(screen.getByRole('button', { name: 'Lưu nháp' })).toHaveProperty('disabled', true);
    vi.mocked(stockIssuesApi.detail).mockResolvedValue({ ...row, version: 1 });
    await userEvent.click(screen.getByRole('button', { name: 'Tải lại phiếu' }));
    await waitFor(() => expect(screen.getByLabelText('Số lượng WATER')).toHaveProperty('value', '10'));
    expect(screen.getByRole('button', { name: 'Ghi sổ' })).toHaveProperty('disabled', false);
  });
  it('recovers unknown update with lookup, without opening a new intention', async () => {
    const save = vi.spyOn(stockIssuesApi, 'save').mockRejectedValue(new ApiError('Mất kết nối'));
    vi.spyOn(stockIssuesApi, 'lookup').mockResolvedValue({ status: 'COMMITTED', responseBody: row });
    render(<StockDocumentEditor issue initial={row} onClose={vi.fn()} onChanged={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Lý do / chứng từ nguồn'), { target: { value: 'Lý do mới từ chứng từ' } });
    await userEvent.click(screen.getByRole('button', { name: 'Lưu nháp' })); await screen.findByText('Mất kết nối');
    await userEvent.click(screen.getByRole('button', { name: 'Tra cứu kết quả' }));
    await screen.findByText('Đã lưu nháp. Tồn kho chưa thay đổi.'); expect(save).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Đóng form' })).toHaveProperty('disabled', false);
  });
  it('list handles loading, literal filters, empty/error/retry and detail loading', async () => {
    render(<MemoryRouter><StockIssuesPage /></MemoryRouter>); expect(screen.getByRole('status').textContent).toContain('Đang tải');
    await screen.findByRole('button', { name: `Mở ${row.code}` });
    vi.mocked(stockIssuesApi.list).mockResolvedValueOnce(page([]));
    fireEvent.change(screen.getByLabelText('Tìm mã phiếu / chứng từ'), { target: { value: 'SOURCE.*' } });
    await userEvent.click(screen.getByRole('button', { name: 'Lọc phiếu' }));
    await screen.findByText('Không có phiếu xuất phù hợp.');
    expect(stockIssuesApi.list).toHaveBeenCalledWith(expect.objectContaining({ q: 'SOURCE.*', page: 1 }), expect.any(AbortSignal));
    vi.mocked(stockIssuesApi.list).mockRejectedValueOnce(new ApiError('Không tải được phiếu'));
    await userEvent.click(screen.getByRole('button', { name: 'Tải lại danh sách' })); await screen.findByText('Không tải được phiếu');
    await userEvent.click(screen.getByRole('button', { name: 'Tải lại danh sách' }));
    await userEvent.click(await screen.findByRole('button', { name: `Mở ${row.code}` }));
    await screen.findByRole('heading', { name: row.code }); expect(stockIssuesApi.detail).toHaveBeenCalledWith(row.id);
  });
  it('opens the exact committed receipt from inventory source navigation', async () => {
    vi.mocked(stockIssuesApi.detail).mockResolvedValue(postedDetail);
    render(<MemoryRouter initialEntries={[`/admin/stock-issues?documentId=${row.id}`]}><StockIssuesPage /></MemoryRouter>);
    await screen.findByRole('heading', { name: row.code });
    expect(stockIssuesApi.detail).toHaveBeenCalledWith(row.id, expect.any(AbortSignal));
    expect(screen.getByText(posted.movementIds[0])).toBeDefined(); expect(screen.queryByRole('button', { name: 'Lưu nháp' })).toBeNull();
  });
  it.each(['STAFF', 'TRAINER', 'MEMBER'] as const)('rejects %s at Admin route before loading issues', async roleCode => {
    vi.spyOn(apiClient, 'getSnapshot').mockReturnValue({ status: 'authenticated', user: { id: 'c'.repeat(24), fullName: 'Test', phone: '0901234567', roleCode } });
    vi.spyOn(apiClient, 'subscribe').mockImplementation(() => () => {}); vi.spyOn(apiClient, 'restore').mockResolvedValue();
    vi.spyOn(apiClient, 'request').mockResolvedValue({ unreadCount: 0, items: [] });
    for (const path of ['/admin/stock-issues']) {
      window.history.pushState({}, '', path); render(<App />); await screen.findByRole('heading', { name: 'Không có quyền truy cập' }); cleanup();
    }
    expect(stockIssuesApi.list).not.toHaveBeenCalled();
  });
  it.each(['ADMIN'] as const)('opens and restores the receipt route for %s', async roleCode => {
    vi.spyOn(apiClient, 'getSnapshot').mockReturnValue({ status: 'authenticated', user: { id: 'c'.repeat(24), fullName: 'Test', phone: '0901234567', roleCode } });
    vi.spyOn(apiClient, 'subscribe').mockImplementation(() => () => {}); vi.spyOn(apiClient, 'restore').mockResolvedValue();
    const path = `/${roleCode.toLowerCase()}/stock-issues`; window.history.pushState({}, '', path); render(<App />);
    await screen.findByRole('heading', { name: 'Phiếu xuất ngoài bán hàng' }); expect(resolveReturnTo(path, roleCode)).toBe(path);
  });
  it('blocks insufficient or missing availability without lowering quantity; refreshes before confirmation', async () => {
    const balance = await inventoryApi.detail(option.id);
    vi.mocked(inventoryApi.detail).mockResolvedValueOnce({ ...balance, available: 6, onHand: 10, reserved: 4 });
    const post = vi.spyOn(stockIssuesApi, 'post');
    render(<StockDocumentEditor issue initial={row} onClose={vi.fn()} onChanged={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Ghi sổ' }));
    await screen.findByText(/Không đủ tồn khả dụng hoặc kho cần đối chiếu/);
    expect(screen.getByLabelText('Số lượng WATER')).toHaveProperty('value', '10');
    expect(screen.queryByRole('dialog')).toBeNull(); expect(post).not.toHaveBeenCalled();
    vi.mocked(inventoryApi.detail).mockResolvedValueOnce({ ...balance, inventoryState: 'MISSING', available: null, onHand: null, reserved: null });
    await userEvent.click(screen.getByRole('button', { name: 'Ghi sổ' })); await screen.findByText(/thực tế —, đang giữ —, khả dụng —/);
    expect(screen.queryByRole('dialog')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Ghi sổ' }));
    await screen.findByRole('dialog', { name: 'Xác nhận ghi sổ' }); expect(post).not.toHaveBeenCalled();
  });
  it('keeps quantity and reloads document/stock after a posting availability conflict', async () => {
    vi.spyOn(stockIssuesApi, 'post').mockRejectedValue(new ApiError('Khả dụng vừa thay đổi', 409, undefined, undefined, undefined, 'INSUFFICIENT_AVAILABLE_STOCK'));
    render(<StockDocumentEditor issue initial={row} onClose={vi.fn()} onChanged={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Ghi sổ' })); await userEvent.click(screen.getByRole('button', { name: 'Xác nhận ghi sổ' }));
    await screen.findByText('Khả dụng vừa thay đổi'); expect(screen.getByLabelText('Số lượng WATER')).toHaveProperty('value', '10');
    await userEvent.click(screen.getByRole('button', { name: 'Tải lại phiếu' }));
    expect(stockIssuesApi.detail).toHaveBeenCalledWith(row.id);
    await userEvent.click(screen.getByRole('button', { name: 'Kiểm tra tồn khả dụng' }));
    await screen.findByText(/khả dụng 10/); expect(inventoryApi.detail).toHaveBeenCalledTimes(2);
  });
});
