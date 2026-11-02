import { createRoot } from 'react-dom/client';
import './index.css';
import { PublicPage } from './page.tsx';
import { loadLocale, preferredLocale } from '../i18n.ts';

// 首屏骨架先按访客浏览器语言；拿到账本后改用主人设置的语言（见 page.tsx）
void loadLocale(preferredLocale()).then(() => createRoot(document.getElementById('app')!).render(<PublicPage />));
