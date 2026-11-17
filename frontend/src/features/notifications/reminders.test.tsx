import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { NotificationSourceLink } from './NotificationSourceLink';
import type { NotificationSource } from './notifications.types';

afterEach(cleanup);
describe('US-49: liên kết nguồn allowlist', () => {
  const source: NotificationSource = { type: 'PT_BOOKING', id: 'a'.repeat(24), dueAt: '2026-11-09T11:00:00Z' };
  it.each([
    ['MEMBER', source, '/member/pt-bookings'], ['TRAINER', source, '/trainer/bookings'],
    ['MEMBER', { ...source, type: 'MEMBERSHIP' as const }, '/member/memberships'],
  ])('vai trò %s đi tới trang kiểm quyền nguồn', (role, value, route) => {
    render(<MemoryRouter><NotificationSourceLink role={role} source={value} /></MemoryRouter>);
    expect(screen.getByRole('link').getAttribute('href')).toBe(route);
  });
  it.each([
    undefined, { ...source, id: 'https://evil.test' }, { ...source, type: 'https://evil.test' } as unknown as NotificationSource,
  ])('nguồn thiếu hoặc ngoài allowlist không có link: %j', value => {
    render(<MemoryRouter><NotificationSourceLink role="MEMBER" source={value} /></MemoryRouter>);
    expect(screen.queryByRole('link')).toBeNull();
  });
  it('Staff/Admin không được dẫn vào màn hình Member/PT từ metadata', () => {
    render(<MemoryRouter><NotificationSourceLink role="ADMIN" source={source} /></MemoryRouter>);
    expect(screen.queryByRole('link')).toBeNull();
  });
});
