import { Lightbulb, LightbulbOff } from 'lucide-react';
export default function LightSwitch({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  const Icon = on ? Lightbulb : LightbulbOff;
  return <button type="button" className="cinema-light-switch" aria-label="Прожекторы стадиона" role="switch" aria-checked={on} title={on ? 'Приглушить прожекторы' : 'Включить прожекторы'} onClick={onToggle}><Icon size={16} aria-hidden="true"/><span className="light-switch-track" aria-hidden="true"><i/></span></button>;
}
