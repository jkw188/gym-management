// Tầng giao diện – khung chung cho hai trang /forgot-password và /reset-password (US-05).
// Giữ challenge trong bộ nhớ (state React), không đưa lên URL hay localStorage (US-05-TC16).
import { useState } from 'react';
import { Outlet, useOutletContext } from 'react-router-dom';

// Thông tin của flow đang làm: định danh đã nhập, challenge server trả, và thông báo chung.
export interface ResetFlow { identifier: string; challenge: string; message: string }

interface FlowContext { flow: ResetFlow | null; setFlow: (flow: ResetFlow | null) => void }

// Route cha: khi chuyển giữa hai trang con, component này không bị gỡ nên state flow vẫn còn.
export function PasswordResetFlow() {
  const [flow, setFlow] = useState<ResetFlow | null>(null);
  return <Outlet context={{ flow, setFlow } satisfies FlowContext} />;
}

export function useResetFlow() {
  return useOutletContext<FlowContext>();
}
