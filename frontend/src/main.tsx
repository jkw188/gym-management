import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { notificationFeed } from './features/notifications/notification-feed';

// EN-03 bước 3: theo dõi đăng nhập để mở socket thông báo cho hội viên (chỉ mở sau khi login).
notificationFeed.start();

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
