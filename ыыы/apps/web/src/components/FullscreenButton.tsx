import { Maximize, Minimize } from 'lucide-react';
import '../styles/fullscreen.css';

export default function FullscreenButton({ active, busy, onToggle, label = 'Развернуть на весь экран' }: {
  active: boolean; busy?: boolean; onToggle: () => void; label?: string;
}) {
  const title = active ? 'Выйти из полноэкранного режима' : label;
  return <button type="button" className="fullscreen-button" onClick={onToggle} disabled={busy} aria-label={title} title={title} aria-pressed={active}>
    {active ? <Minimize size={18} aria-hidden="true" /> : <Maximize size={18} aria-hidden="true" />}<span>{active ? 'Свернуть' : 'На весь экран'}</span>
  </button>;
}
