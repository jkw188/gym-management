import { useState } from 'react';

function safeImage(value: string | null) {
  if (!value || /[\s\\\u0000-\u001f\u007f]/.test(value)) return false;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
}
export function RetailImage({ url, name }: { url: string | null; name: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!safeImage(url) || failed === url) return <span role="img" aria-label={`Chưa có ảnh ${name}`}>Chưa có ảnh</span>;
  return <img src={url!} alt={name} width={64} height={64} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(url)} />;
}
