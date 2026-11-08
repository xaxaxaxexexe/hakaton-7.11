import { ArrowRight, RefreshCw, AlertCircle } from 'lucide-react';
import type { ReactNode } from 'react';

export function Loading({ label = 'Готовим ваш матч…' }: { label?: string }) {
  return <div className="feedback loading-state" role="status"><span className="loader" aria-hidden="true"/><p>{label}</p></div>;
}
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <div className="feedback error-state" role="alert"><AlertCircle size={28}/><h3>Небольшой перерыв</h3><p>{message}</p>{onRetry && <button className="button button--secondary" onClick={onRetry}><RefreshCw size={16}/>Попробовать ещё раз</button>}</div>;
}
export function EmptyState({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="feedback empty-state"><span className="empty-mark"><ArrowRight/></span><h3>{title}</h3><p>{children}</p>{action}</div>;
}
