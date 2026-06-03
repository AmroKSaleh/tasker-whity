// Tasker Redesign — shared icons + small atoms

const Icon = {
  grip: (props) => (
    <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" {...props}>
      <circle cx="3" cy="3" r="1" /><circle cx="7" cy="3" r="1" />
      <circle cx="3" cy="7" r="1" /><circle cx="7" cy="7" r="1" />
      <circle cx="3" cy="11" r="1" /><circle cx="7" cy="11" r="1" />
    </svg>
  ),
  play: (props) => (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="currentColor" {...props}>
      <path d="M2.5 1.5 L9 5.5 L2.5 9.5 Z" />
    </svg>
  ),
  pause: (props) => (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="currentColor" {...props}>
      <rect x="2" y="2" width="2.5" height="7" />
      <rect x="6.5" y="2" width="2.5" height="7" />
    </svg>
  ),
  more: (props) => (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" {...props}>
      <circle cx="3" cy="7" r="1.2" /><circle cx="7" cy="7" r="1.2" /><circle cx="11" cy="7" r="1.2" />
    </svg>
  ),
  edit: (props) => (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M9 1.5 L11.5 4 L4 11.5 L1.5 11.5 L1.5 9 Z" />
    </svg>
  ),
  trash: (props) => (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M2 3.5 L11 3.5 M5 1.5 L8 1.5 L8.5 3.5 L4.5 3.5 Z M3 3.5 L4 11.5 L9 11.5 L10 3.5" />
    </svg>
  ),
  collapse: (props) => (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M5 2 L2 5 M2 5 L5 8 M2 5 L11 5" />
    </svg>
  ),
  cal: (props) => (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" {...props}>
      <rect x="1.5" y="2.5" width="10" height="9" rx="1.5" />
      <path d="M4 1 L4 4 M9 1 L9 4 M1.5 5.5 L11.5 5.5" />
    </svg>
  ),
  chevronL: (props) => (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M9 3 L4 7 L9 11" />
    </svg>
  ),
  chevronR: (props) => (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M5 3 L10 7 L5 11" />
    </svg>
  ),
  close: (props) => (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" {...props}>
      <path d="M3 3 L11 11 M11 3 L3 11" />
    </svg>
  ),
  plus: (props) => (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" {...props}>
      <path d="M6 2 L6 10 M2 6 L10 6" />
    </svg>
  ),
  zap: (props) => (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" {...props}>
      <path d="M7 0.5 L2 6.5 L5.5 6.5 L5 11.5 L10 5.5 L6.5 5.5 Z" />
    </svg>
  ),
  search: (props) => (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" {...props}>
      <circle cx="6" cy="6" r="4" />
      <path d="M9.2 9.2 L12 12" />
    </svg>
  ),
  battery: (props) => (
    <svg width="22" height="11" viewBox="0 0 22 11" fill="none" {...props}>
      <rect x="0.5" y="0.5" width="18" height="10" rx="2" stroke="currentColor" />
      <rect x="2" y="2" width="14" height="7" rx="1" fill="currentColor" />
      <rect x="19.5" y="3.5" width="2" height="4" rx="0.5" fill="currentColor" />
    </svg>
  ),
  signal: (props) => (
    <svg width="14" height="11" viewBox="0 0 14 11" fill="currentColor" {...props}>
      <rect x="0" y="8" width="2" height="3" rx="0.5" />
      <rect x="4" y="5" width="2" height="6" rx="0.5" />
      <rect x="8" y="2" width="2" height="9" rx="0.5" />
      <rect x="12" y="0" width="2" height="11" rx="0.5" />
    </svg>
  ),
  wifi: (props) => (
    <svg width="13" height="11" viewBox="0 0 13 11" fill="currentColor" {...props}>
      <path d="M6.5 2 C4 2 1.8 3 0 4.5 L1.5 6 C3 4.8 4.7 4.1 6.5 4.1 C8.3 4.1 10 4.8 11.5 6 L13 4.5 C11.2 3 9 2 6.5 2 Z" />
      <path d="M6.5 5.2 C5 5.2 3.6 5.8 2.5 6.7 L4 8.2 C4.7 7.6 5.6 7.3 6.5 7.3 C7.4 7.3 8.3 7.6 9 8.2 L10.5 6.7 C9.4 5.8 8 5.2 6.5 5.2 Z" />
      <circle cx="6.5" cy="9.5" r="1.2" />
    </svg>
  ),
};

// Tiny atom: section progress sparkline-ish
function ProgressBar({ done, total, w = 70, dark }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="bar" style={{ width: w, background: dark ? 'rgba(251,250,246,0.18)' : undefined }}>
      <i style={{ width: pct + '%', background: dark ? 'var(--paper)' : undefined }} />
    </div>
  );
}

Object.assign(window, { Icon, ProgressBar });
