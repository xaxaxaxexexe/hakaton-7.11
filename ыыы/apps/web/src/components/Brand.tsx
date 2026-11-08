import { Link } from 'react-router-dom';

export default function Brand({ compact = false }: { compact?: boolean }) {
  return <Link className="brand" to="/" aria-label="SEKTOR — на главную">
    <svg className="brand-mark" viewBox="0 0 36 36" fill="none" aria-hidden="true">
      <path d="M8 27V14a5 5 0 0 1 5-5h10a5 5 0 0 1 5 5v13M5 21h26M9 27h18M11 27v4m14-4v4" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg><span>SEKTOR<span className="brand-dot">.</span></span>{!compact && <span className="brand-caption">ваше место на трибуне</span>}
  </Link>;
}
