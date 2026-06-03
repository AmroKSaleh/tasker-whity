/** @type {import('tailwindcss').Config} */
// Drop-in additions for the Tasker project-view redesign.
// Merge into your existing tailwind.config.cjs — only the `theme.extend`
// branch matters; everything else is already in your project.
module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        ink:    { DEFAULT: '#1A1916', 2: '#3D3B36' },
        mute:   { DEFAULT: '#6B6867', 2: '#9A9896' },
        line:   { DEFAULT: '#D4D0C8', 2: '#ECE9E1' },
        surf:   { DEFAULT: '#F0EDE5', 2: '#F5F3ED' },
        paper:  '#FBFAF6',
        accent: {
          DEFAULT: '#D97757',
          soft: 'rgba(217,119,87,0.10)',
          edge: 'rgba(217,119,87,0.35)',
        },
        priority: {
          rush: '#C0432D',
          high: '#D97757',
          med:  '#8C8055',
          low:  '#6B6867',
          done: '#5C7A5F',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        '2xs': ['10px',  { lineHeight: '14px', letterSpacing: '0.08em' }],
        '3xs': ['9.5px', { lineHeight: '13px', letterSpacing: '0.10em' }],
      },
      boxShadow: {
        panel: '-12px 0 32px rgba(26,25,22,0.08)',
        sheet: '0 -8px 24px rgba(26,25,22,0.18)',
        fab:   '0 4px 16px rgba(26,25,22,0.25)',
        drag:  '0 18px 40px rgba(26,25,22,0.18), 0 0 0 1.5px #D97757',
      },
      borderRadius: {
        sheet: '14px',
      },
      transitionTimingFunction: {
        panel: 'cubic-bezier(0.2, 0.7, 0.3, 1)',
      },
      width: {
        col: '300px',
        'col-collapsed': '44px',
        'col-mobile': 'calc(100vw - 32px)',
        panel: '380px',
        sidebar: '288px',
      },
      keyframes: {
        'slide-in-right':  { '0%': { transform: 'translateX(100%)' }, '100%': { transform: 'translateX(0)' } },
        'slide-out-right': { '0%': { transform: 'translateX(0)' },    '100%': { transform: 'translateX(100%)' } },
        'fade-in':  { '0%': { opacity: 0 }, '100%': { opacity: 1 } },
        'fade-out': { '0%': { opacity: 1 }, '100%': { opacity: 0 } },
        'sheet-up':   { '0%': { transform: 'translateY(100%)' }, '100%': { transform: 'translateY(0)' } },
        'sheet-down': { '0%': { transform: 'translateY(0)' },    '100%': { transform: 'translateY(100%)' } },
      },
      animation: {
        'slide-in-right':  'slide-in-right 240ms cubic-bezier(0.2,0.7,0.3,1) both',
        'slide-out-right': 'slide-out-right 220ms cubic-bezier(0.2,0.7,0.3,1) both',
        'fade-in':  'fade-in 180ms linear both',
        'fade-out': 'fade-out 180ms linear both',
        'sheet-up':   'sheet-up 280ms cubic-bezier(0.2,0.7,0.3,1) both',
        'sheet-down': 'sheet-down 260ms cubic-bezier(0.2,0.7,0.3,1) both',
      },
    },
  },
  plugins: [],
};
