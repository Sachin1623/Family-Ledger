import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import {ErrorBoundary} from './components/ErrorBoundary';
import './index.css';

// Prevent benign background Vite HMR or WebSocket connection failures from causing unhandled rejections
const isHmrError = (err: any): boolean => {
  if (!err) return false;
  const msg = (err.message || String(err) || '').toLowerCase();
  return (
    msg.includes('websocket') || 
    msg.includes('vite') || 
    msg.includes('hmr') || 
    msg.includes('closed without opened') || 
    msg.includes('connection lost')
  );
};

window.addEventListener('unhandledrejection', (event) => {
  if (isHmrError(event.reason) || isHmrError((event as any).detail)) {
    event.stopImmediatePropagation();
    event.preventDefault();
  }
}, true);

window.addEventListener('error', (event) => {
  if (isHmrError(event.message) || isHmrError(event.error)) {
    event.stopImmediatePropagation();
    event.preventDefault();
  }
}, true);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
