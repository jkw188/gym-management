const eventName = 'gym:classes-changed';
const storageKey = 'gym:classes-revision';

// API không cache lịch. Báo các tab cùng origin và tải lại khi quay về tab để cập nhật thay đổi từ thiết bị khác.
export function invalidateClasses() {
  window.dispatchEvent(new Event(eventName));
  try { localStorage.setItem(storageKey, crypto.randomUUID()); } catch { /* Tab hiện tại vẫn nhận sự kiện. */ }
}
export function subscribeClassChanges(refresh: () => void) {
  const storage = (event: StorageEvent) => { if (event.key === storageKey) refresh(); };
  const visible = () => { if (document.visibilityState === 'visible') refresh(); };
  window.addEventListener(eventName, refresh);
  window.addEventListener('storage', storage);
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', visible);
  return () => {
    window.removeEventListener(eventName, refresh); window.removeEventListener('storage', storage);
    window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', visible);
  };
}
