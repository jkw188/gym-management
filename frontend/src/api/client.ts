import type { AuthResponse, AuthSnapshot, AuthUser, LogoutResult } from '../features/auth/auth.types';

const baseUrl = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');
const LOGOUT_MESSAGE = 'logout';
export interface AuthChannel {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}
const createAuthChannel = (): AuthChannel | null => typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('gym-auth');

export class ApiError extends Error {
  constructor(message: string, public readonly status?: number, public readonly requestId?: string,
    public readonly details?: { field: string; message: string }[], public readonly retryAfter?: number,
    public readonly code?: string) { super(message); }
}

export class ApiClient {
  private accessToken: string | null = null;
  private refreshPromise: Promise<AuthUser> | null = null;
  private logoutPromise: Promise<LogoutResult> | null = null;
  private sessionGeneration = 0;
  private snapshot: AuthSnapshot = { status: 'checking', user: null };
  private readonly listeners = new Set<() => void>();
  constructor(private readonly url: string, private readonly transport: typeof fetch = fetch,
    private readonly channel: AuthChannel | null = null) {
    this.channel?.addEventListener('message', event => {
      if (event.data === LOGOUT_MESSAGE) this.requireLogin();
    });
  }

  getSnapshot = (): AuthSnapshot => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(snapshot: AuthSnapshot) { this.snapshot = snapshot; for (const listener of this.listeners) listener(); }
  private anonymous() { this.accessToken = null; this.publish({ status: 'anonymous', user: null }); }
  requireLogin() { this.sessionGeneration++; this.anonymous(); }

  updateCurrentUser(user: AuthUser) {
    if (this.snapshot.status === 'authenticated' && this.snapshot.user?.id === user.id) {
      this.publish({ status: 'authenticated', user });
    }
  }

  private async send<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!/^https?:\/\//.test(this.url) || !this.url.endsWith('/api') || !path.startsWith('/') || path.startsWith('//')) {
      throw new ApiError('Cấu hình VITE_API_BASE_URL phải trỏ đến /api của backend.');
    }
    let response: Response;
    try {
      response = await this.transport.call(globalThis, `${this.url}${path}`, { ...init,
        signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new ApiError('Không kết nối được máy chủ. Vui lòng kiểm tra kết nối và thử lại.');
    }
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: { code?: string; message?: string; details?: { field: string; message: string }[] } } | null;
      throw new ApiError(body?.error?.message ?? (response.status === 503 ? 'Cơ sở dữ liệu chưa sẵn sàng.' : 'Yêu cầu không thành công.'),
        response.status, response.headers.get('X-Request-Id') ?? undefined, body?.error?.details,
        response.headers.has('Retry-After') ? Number(response.headers.get('Retry-After')) : undefined, body?.error?.code);
    }
    if (response.status === 204) return undefined as T;
    try { return await response.json() as T; }
    catch { throw new ApiError('Máy chủ trả về dữ liệu không hợp lệ.'); }
  }

  publicGet<T>(path: string, signal?: AbortSignal) { return this.send<T>(path, { signal }); }

  async login(phone: string, password: string): Promise<AuthUser> {
    const generation = ++this.sessionGeneration;
    const result = await this.send<AuthResponse>('/auth/login', { method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, password }) });
    if (generation !== this.sessionGeneration) throw new ApiError('Cần đăng nhập lại.', 401);
    this.accessToken = result.accessToken;
    this.publish({ status: 'authenticated', user: result.user });
    return result.user;
  }

  refreshSession(): Promise<AuthUser> {
    if (this.refreshPromise) return this.refreshPromise;
    if (this.snapshot.status === 'loggingOut') return Promise.reject(new ApiError('Đang đăng xuất.'));
    const generation = this.sessionGeneration;
    this.refreshPromise = (async () => {
      try {
        const result = await this.send<AuthResponse>('/auth/refresh', { method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' }, body: '{}' });
        if (generation !== this.sessionGeneration) throw new ApiError('Cần đăng nhập lại.', 401);
        this.accessToken = result.accessToken;
        const user = await this.send<AuthUser>('/auth/me', { headers: { Authorization: `Bearer ${this.accessToken}` } });
        if (generation !== this.sessionGeneration) throw new ApiError('Cần đăng nhập lại.', 401);
        if (this.snapshot.status !== 'loggingOut') this.publish({ status: 'authenticated', user });
        return user;
      } catch (error) {
        if (generation === this.sessionGeneration && error instanceof ApiError && error.status === 401) this.anonymous();
        throw error;
      } finally { this.refreshPromise = null; }
    })();
    return this.refreshPromise;
  }

  async restore(): Promise<void> {
    if (this.snapshot.status !== 'checking') return;
    this.publish({ status: 'checking', user: null });
    try { await this.refreshSession(); }
    catch (error) {
      if (error instanceof ApiError && error.status === 401) return;
      this.publish({ status: 'checking', user: null, error: error instanceof Error ? error.message : 'Không thể khôi phục phiên.',
        requestId: error instanceof ApiError ? error.requestId : undefined });
    }
  }

  logout(): Promise<LogoutResult> {
    this.logoutPromise ??= this.runLogout().finally(() => { this.logoutPromise = null; });
    return this.logoutPromise;
  }

  private async runLogout(): Promise<LogoutResult> {
    this.publish({ status: 'loggingOut', user: null });
    await this.refreshPromise?.catch(() => undefined);

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;
    try {
      await this.send<void>('/auth/logout', { method: 'POST', credentials: 'include', headers, body: '{}' });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        this.requireLogin();
        return 'unverified';
      }
      this.publish({ status: 'loggingOut', user: null, error: 'Chưa xác nhận đăng xuất, hãy thử lại.',
        requestId: error instanceof ApiError ? error.requestId : undefined });
      throw error;
    }

    this.requireLogin();
    this.channel?.postMessage(LOGOUT_MESSAGE);
    return 'revoked';
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (this.snapshot.status === 'loggingOut') throw new ApiError('Đang đăng xuất.');
    const token = this.accessToken;
    const generation = this.sessionGeneration;
    const send = async () => {
      const headers = new Headers(init.headers);
      if (this.accessToken) headers.set('Authorization', `Bearer ${this.accessToken}`);
      const result = await this.send<T>(path, { ...init, headers });
      if (generation !== this.sessionGeneration) throw new ApiError('Cần đăng nhập lại.', 401);
      return result;
    };
    try { return await send(); }
    catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
      if (generation !== this.sessionGeneration || this.snapshot.status === 'anonymous') throw error;
      if (init.signal?.aborted) throw error;
      // A delayed 401 may refer to the token another request has already refreshed.
      if (this.accessToken === token) await this.refreshSession();
      try { return await send(); }
      catch (retryError) {
        if (retryError instanceof ApiError && retryError.status === 401) this.anonymous();
        throw retryError;
      }
    }
  }
}

export const apiClient = new ApiClient(baseUrl, fetch, createAuthChannel());
export const apiGet = <T>(path: string, signal?: AbortSignal) => apiClient.publicGet<T>(path, signal);
