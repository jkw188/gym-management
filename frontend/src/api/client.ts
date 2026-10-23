import type { AuthResponse, AuthSnapshot, AuthUser } from '../features/auth/auth.types';

const baseUrl = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(message: string, public readonly status?: number, public readonly requestId?: string,
    public readonly details?: { field: string; message: string }[], public readonly retryAfter?: number,
    public readonly code?: string) { super(message); }
}

export class ApiClient {
  private accessToken: string | null = null;
  private refreshPromise: Promise<AuthUser> | null = null;
  private sessionGeneration = 0;
  private snapshot: AuthSnapshot = { status: 'checking', user: null };
  private readonly listeners = new Set<() => void>();
  constructor(private readonly url: string, private readonly transport: typeof fetch = fetch) {}

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
    const generation = this.sessionGeneration;
    this.refreshPromise = (async () => {
      try {
        const result = await this.send<AuthResponse>('/auth/refresh', { method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' }, body: '{}' });
        if (generation !== this.sessionGeneration) throw new ApiError('Cần đăng nhập lại.', 401);
        this.accessToken = result.accessToken;
        const user = await this.send<AuthUser>('/auth/me', { headers: { Authorization: `Bearer ${this.accessToken}` } });
        if (generation !== this.sessionGeneration) throw new ApiError('Cần đăng nhập lại.', 401);
        this.publish({ status: 'authenticated', user });
        return user;
      } catch (error) {
        if (generation === this.sessionGeneration && error instanceof ApiError && error.status === 401) this.anonymous();
        throw error;
      } finally { this.refreshPromise = null; }
    })();
    return this.refreshPromise;
  }

  async restore(): Promise<void> {
    if (this.snapshot.status === 'authenticated' || this.snapshot.status === 'anonymous') return;
    this.publish({ status: 'checking', user: null });
    try { await this.refreshSession(); }
    catch (error) {
      if (error instanceof ApiError && error.status === 401) return;
      this.publish({ status: 'checking', user: null, error: error instanceof Error ? error.message : 'Không thể khôi phục phiên.',
        requestId: error instanceof ApiError ? error.requestId : undefined });
    }
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = this.accessToken;
    const generation = this.sessionGeneration;
    const send = () => {
      const headers = new Headers(init.headers);
      if (this.accessToken) headers.set('Authorization', `Bearer ${this.accessToken}`);
      return this.send<T>(path, { ...init, headers });
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

export const apiClient = new ApiClient(baseUrl);
export const apiGet = <T>(path: string, signal?: AbortSignal) => apiClient.publicGet<T>(path, signal);
