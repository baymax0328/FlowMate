import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './app/App';
import './styles/app.css';
import './styles/theme.css';
import './styles/workspace-design.css';
import './styles/personal-dashboard.css';
import './styles/light-emerald.css';
import './styles/dark-mode.css';
import './styles/interaction-refinements.css';
import './styles/corner-shape.css';

const NO_RETRY = ['AUTH_REQUIRED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION', 'INVALID_TRANSITION', 'VERSION_CONFLICT', 'PROPOSAL_STALE'];

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 8000,
      refetchOnWindowFocus: false,
      retry: (count, err) => {
        const code = String((err as { code?: string } | undefined)?.code ?? '');
        if (NO_RETRY.includes(code)) return false;
        return count < 1;
      },
    },
    mutations: { retry: 0 },
  },
});

// 渲染崩溃只发生在浏览器里，没有堆栈就只能靠猜：这里把错误回报到服务端日志（不落库、不鉴权）
let last = '';
function report(where: string, message = 'unknown', stack?: string) {
  const key = where + message;
  if (key === last) return;           // 同一错误只报一次，避免刷屏
  last = key;
  void fetch('/api/v1/client-log', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-FlowMate-Client': 'web' },
    body: JSON.stringify({ where, message: message.slice(0, 500), stack: (stack ?? '').slice(0, 2000), url: location.pathname + location.search }),
  }).catch(() => undefined);
}

window.addEventListener('error', (e) => report('window.error', e.message ?? 'unknown', e.error?.stack));
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason as { message?: string; stack?: string } | undefined;
  report('unhandledrejection', r?.message ?? String(e.reason), r?.stack);
});

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <App onRenderError={report} />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);



