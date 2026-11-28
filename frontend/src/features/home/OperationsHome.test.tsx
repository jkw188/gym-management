import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { servicesApi, type PublicPlan } from '../services/services.api';
import { shopApi, type PublicProduct } from '../shop/shop.api';
import { OperationsHome } from './OperationsHome';

const page = <T,>(items: T[]) => ({ items, page: 1, limit: 20, total: items.length, totalPages: items.length ? 1 : 0 });
const plan: PublicPlan = { id: 'plan-1', code: 'GYM_1', name: 'Gym tháng', kind: 'GYM', durationDays: 30,
  sessionsQuota: 0, price: '399000', benefits: 'Tập tự do', version: 0 };
const product: PublicProduct = { id: 'product-1', sku: 'WATER', name: 'Bình nước', category: { id: 'gear', name: 'Phụ kiện' },
  price: '129000', version: 0, availability: 'IN_STOCK', asOf: '2026-11-28T03:00:00.000Z' };

function renderHome(role: 'ADMIN' | 'STAFF') {
  render(<MemoryRouter><OperationsHome role={role} name="Minh Anh" /></MemoryRouter>);
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('operations home', () => {
  it('shows three plans and four real product links together and keeps the report shortcut ADMIN-only', async () => {
    vi.spyOn(servicesApi, 'list').mockResolvedValue(page(Array.from({ length: 4 }, (_, index) => ({ ...plan, id: `plan-${index}` }))));
    vi.spyOn(shopApi, 'listProducts').mockResolvedValue(page(Array.from({ length: 5 }, (_, index) => ({ ...product, id: `product-${index}` }))));
    renderHome('STAFF');

    const plans = screen.getByRole('region', { name: 'Gói tập nổi bật' });
    const products = screen.getByRole('region', { name: 'Sản phẩm nổi bật' });
    expect(await within(plans).findAllByRole('listitem')).toHaveLength(3);
    expect(await within(products).findAllByRole('listitem')).toHaveLength(4);
    expect(within(products).getAllByRole('link', { name: /Bình nước/ })[0].getAttribute('href')).toBe('/shop/product-0');
    expect(screen.getByRole('link', { name: /Bán tại quầy/ }).getAttribute('href')).toBe('/staff/pos');
    expect(screen.queryByRole('link', { name: /Báo cáo thu & hoàn/ })).toBeNull();
  });

  it('keeps a successful empty plans response while retrying only the failed products request', async () => {
    const plans = vi.spyOn(servicesApi, 'list').mockResolvedValue(page([]));
    const products = vi.spyOn(shopApi, 'listProducts')
      .mockRejectedValueOnce(new ApiError('Cơ sở dữ liệu chưa sẵn sàng', 503, 'request-products'))
      .mockResolvedValue(page([product]));
    renderHome('ADMIN');

    expect(await screen.findByText('Chưa có gói đang bán.')).toBeTruthy();
    expect((await screen.findByRole('alert')).textContent).toContain('request-products');
    expect(screen.queryByText('Chưa có sản phẩm đang bán.')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
    expect(await screen.findByRole('link', { name: /Bình nước/ })).toBeTruthy();
    expect(screen.getByText('Chưa có gói đang bán.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(plans).toHaveBeenCalledTimes(1);
    expect(products).toHaveBeenCalledTimes(2);
  });
});
