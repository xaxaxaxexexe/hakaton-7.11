import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';

type Theme = 'dark' | 'light';
export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f8f6f1' : '#10100e');
    try { localStorage.setItem('zal:theme', theme); } catch { /* Theme remains usable when storage is unavailable. */ }
  }, [theme]);
  useEffect(() => {
    const sync = (event: StorageEvent) => { if (event.key === 'zal:theme') setTheme(event.newValue === 'light' ? 'light' : 'dark'); };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  const label = theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему';
  return <button className="theme-toggle" onClick={() => setTheme(value => value === 'dark' ? 'light' : 'dark')} aria-label={label} title={label}>{theme === 'dark' ? <Sun size={19}/> : <Moon size={19}/>}</button>;
}
