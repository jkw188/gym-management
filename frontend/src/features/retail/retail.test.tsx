import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../App';
import { ApiError, apiClient } from '../../api/client';
import { resolveReturnTo } from '../auth/auth.routes';
import { RetailCatalogPage } from './RetailCatalogPage';
import { RetailForm } from './RetailForm';
import { RetailImage } from './RetailImage';
import { retailApi, type Category, type Product, type RetailPage } from './retail.api';

const category: Category = { id: 'a'.repeat(24), name: 'Đồ uống', status: 'ACTIVE', version: 0, affectedActiveProductCount: 4,
  createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:00.000Z' };
const product: Product = { id: 'b'.repeat(24), name: 'Nước suối', status: 'ACTIVE', version: 0, categoryId: category.id,
  categoryName: category.name, categoryStatus: 'ACTIVE', sku: 'WATER', description: '<b>nội dung</b>', imageUrl: null, price: '5000',
  effectiveActive: true, createdAt: category.createdAt, updatedAt: category.updatedAt };
const page = <T,>(items: T[]): RetailPage<T> => ({ items, page: 1, limit: 20, total: items.length, totalPages: items.length ? 1 : 0 });
beforeEach(() => {
  vi.spyOn(retailApi, 'list').mockImplementation(async kind => kind === 'categories' ? page([category]) : page([product]) as never);
  vi.spyOn(retailApi, 'detail').mockImplementation(async kind => (kind === 'categories' ? category : product) as never);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); window.history.pushState({}, '', '/'); });

describe('US-34 admin retail UI', () => {
  it('previews category impact before confirm, then submits one idempotent mutation', async () => {
    const save = vi.spyOn(retailApi, 'save').mockResolvedValue({ ...category, status: 'INACTIVE', version: 1 }), saved = vi.fn();
    render(<RetailForm kind="categories" initial={category} onSaved={saved} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Trạng thái'), { target: { value: 'INACTIVE' } });
    await userEvent.click(screen.getByRole('button', { name: 'Xem trước' }));
    await screen.findByText(/4 sản phẩm có trạng thái ACTIVE sẽ bị ẩn/);
    expect(save).not.toHaveBeenCalled(); expect(retailApi.detail).toHaveBeenCalledWith('categories', category.id);
    await userEvent.click(screen.getByRole('button', { name: 'Xác nhận lưu' }));
    expect(save).toHaveBeenCalledWith('categories', { version: 0, status: 'INACTIVE' }, expect.any(String), category.id);
    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  });
  it('product form never edits SKU/stock/cost, renders markup as text and sends optional clear', async () => {
    const save = vi.spyOn(retailApi, 'save').mockResolvedValue({ ...product, description: null });
    const { container } = render(<RetailForm kind="products" initial={product} onSaved={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('option', { name: 'Đồ uống (ACTIVE)' });
    expect(screen.getByLabelText('SKU')).toHaveProperty('disabled', true);
    expect(screen.queryByLabelText(/Tồn kho|Giá vốn|reserved|onHand/i)).toBeNull();
    fireEvent.change(screen.getByLabelText('Mô tả'), { target: { value: '' } });
    await userEvent.click(screen.getByRole('button', { name: 'Xem trước' }));
    await userEvent.click(screen.getByRole('button', { name: 'Xác nhận lưu' }));
    expect(save).toHaveBeenCalledWith('products', { version: 0, description: null }, expect.any(String), product.id);
    expect(container.querySelector('b')).toBeNull();
  });
  it('stale version preserves draft and requires explicit reload before another attempt', async () => {
    vi.spyOn(retailApi, 'save').mockRejectedValue(new ApiError('Phiên bản cũ', 409, 'req34', undefined, undefined, 'VERSION_CONFLICT'));
    render(<RetailForm kind="products" initial={product} onSaved={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('option', { name: 'Đồ uống (ACTIVE)' });
    fireEvent.change(screen.getByLabelText('Tên'), { target: { value: 'Bản nhập' } });
    await userEvent.click(screen.getByRole('button', { name: 'Xem trước' })); await userEvent.click(screen.getByRole('button', { name: 'Xác nhận lưu' }));
    await screen.findByText('Phiên bản cũ');
    expect(screen.getByLabelText('Tên')).toHaveProperty('value', 'Bản nhập');
    expect(screen.getByRole('button', { name: 'Xem trước' })).toHaveProperty('disabled', true);
    vi.mocked(retailApi.detail).mockResolvedValueOnce({ ...product, name: 'Bản mới', version: 1 });
    await userEvent.click(screen.getByRole('button', { name: 'Tải lại dữ liệu' }));
    await waitFor(() => expect(screen.getByLabelText('Tên')).toHaveProperty('value', 'Bản mới'));
  });
  it('network/unknown outcome freezes draft and reuses key/payload even after lookup 404', async () => {
    const save = vi.spyOn(retailApi, 'save').mockRejectedValueOnce(new ApiError('Mất kết nối')).mockResolvedValueOnce(category);
    vi.spyOn(retailApi, 'lookup').mockRejectedValueOnce(new ApiError('Chưa thấy kết quả', 404, undefined, undefined, undefined, 'OPERATION_UNKNOWN'));
    const saved = vi.fn(); render(<RetailForm kind="categories" onSaved={saved} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Tên'), { target: { value: 'Đồ uống' } });
    await userEvent.click(screen.getByRole('button', { name: 'Xem trước' })); await userEvent.click(screen.getByRole('button', { name: 'Xác nhận lưu' }));
    await screen.findByText('Mất kết nối');
    expect(screen.getByRole('button', { name: 'Đóng form' })).toHaveProperty('disabled', true);
    await userEvent.click(screen.getByRole('button', { name: 'Tra cứu kết quả' })); await screen.findByText('Chưa thấy kết quả');
    expect(screen.getByRole('button', { name: 'Đóng form' })).toHaveProperty('disabled', true);
    await userEvent.click(screen.getByRole('button', { name: 'Gửi lại cùng yêu cầu' }));
    expect(save.mock.calls[1]).toEqual(save.mock.calls[0]); await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  });
  it('creates a product only after preview and prevents double confirmation from changing the request key', async () => {
    let finish!: (value: Product) => void;
    const save = vi.spyOn(retailApi, 'save').mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const saved = vi.fn(); render(<RetailForm kind="products" onSaved={saved} onClose={vi.fn()} />);
    await screen.findByRole('option', { name: 'Đồ uống (ACTIVE)' });
    fireEvent.change(screen.getByLabelText('Tên'), { target: { value: ' Nước suối ' } });
    fireEvent.change(screen.getByLabelText('SKU'), { target: { value: 'water' } });
    fireEvent.change(screen.getByLabelText('Danh mục'), { target: { value: category.id } });
    await userEvent.click(screen.getByRole('button', { name: 'Xem trước' }));
    expect(save).not.toHaveBeenCalled();
    await userEvent.dblClick(screen.getByRole('button', { name: 'Xác nhận lưu' }));
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('products', { name: 'Nước suối', sku: 'WATER', categoryId: category.id,
      price: '0', status: 'ACTIVE', description: null, imageUrl: null }, expect.any(String), undefined);
    finish(product); await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  });
  it('list handles loading, effectiveActive, literal search, empty and recoverable error', async () => {
    vi.mocked(retailApi.list).mockImplementation(async kind => (kind === 'categories' ? page([category]) : page([{ ...product, categoryStatus: 'INACTIVE', effectiveActive: false }])) as never);
    render(<MemoryRouter><RetailCatalogPage kind="products" /></MemoryRouter>);
    expect(screen.getByRole('status').textContent).toContain('Đang tải');
    await screen.findByText('Ẩn do danh mục ngừng bán');
    vi.mocked(retailApi.list).mockResolvedValueOnce(page([]));
    fireEvent.change(screen.getByLabelText('Tìm theo tên hoặc SKU'), { target: { value: 'literal.*' } });
    await userEvent.click(screen.getByRole('button', { name: 'Tìm kiếm' }));
    await screen.findByText('Không có sản phẩm phù hợp.');
    expect(retailApi.list).toHaveBeenCalledWith('products', expect.objectContaining({ q: 'literal.*' }), expect.any(AbortSignal));
    vi.mocked(retailApi.list).mockRejectedValueOnce(new ApiError('Lỗi đọc danh sách'));
    fireEvent.change(screen.getByLabelText('Lọc trạng thái'), { target: { value: 'INACTIVE' } });
    await screen.findByText('Lỗi đọc danh sách');
    await userEvent.click(screen.getByRole('button', { name: 'Tải lại danh sách' })); await screen.findByText('Ẩn do danh mục ngừng bán');
  });
  it('unsafe/broken images use placeholder; descriptions remain text in preview', async () => {
    const { rerender, container } = render(<RetailImage url="javascript:alert(1)" name="Nước" />);
    expect(screen.getByRole('img').textContent).toBe('Chưa có ảnh'); expect(container.querySelector('img')).toBeNull();
    rerender(<RetailImage url="https://example.test/404.png" name="Nước" />);
    fireEvent.error(screen.getByRole('img')); expect(container.querySelector('img')).toBeNull();
    cleanup(); const form = render(<RetailForm kind="products" initial={product} onSaved={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('option', { name: 'Đồ uống (ACTIVE)' });
    fireEvent.change(screen.getByLabelText('Tên'), { target: { value: 'Tên mới' } });
    await userEvent.click(screen.getByRole('button', { name: 'Xem trước' }));
    expect(screen.getByText('<b>nội dung</b>', { selector: 'p' })).toBeDefined(); expect(form.container.querySelector('b')).toBeNull();
  });
  it.each(['STAFF', 'TRAINER', 'MEMBER'] as const)('actual routes reject %s before loading catalog', async roleCode => {
    vi.spyOn(apiClient, 'getSnapshot').mockReturnValue({ status: 'authenticated', user: { id: 'c'.repeat(24), fullName: 'Test', phone: '0901234567', roleCode } });
    vi.spyOn(apiClient, 'subscribe').mockImplementation(() => () => {}); vi.spyOn(apiClient, 'restore').mockResolvedValue();
    // Member's notification bell is independent of the catalog page.
    vi.spyOn(apiClient, 'request').mockResolvedValue({ unreadCount: 0, items: [] });
    for (const path of ['/admin/categories', '/admin/products']) {
      window.history.pushState({}, '', path); render(<App />);
      await screen.findByRole('heading', { name: 'Không có quyền truy cập' }); expect(retailApi.list).not.toHaveBeenCalled(); cleanup();
    }
    expect(resolveReturnTo('/admin/products', 'ADMIN')).toBe('/admin/products');
    expect(resolveReturnTo('/admin/products', roleCode)).not.toBe('/admin/products');
  });
});
