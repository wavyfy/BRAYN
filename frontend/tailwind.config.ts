import type { Config } from 'tailwindcss';

function token(name: string) {
  return `rgb(var(--${name}) / <alpha-value>)`;
}

const config: Config = {
  darkMode: 'class',
  content: ['./app/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        background: token('background'),
        surface: token('surface'),
        canvas: token('canvas'),
        'surface-elevated': token('surface-elevated'),
        subtle: token('subtle'),
        foreground: token('foreground'),
        'muted-foreground': token('muted-foreground'),
        border: token('border'),
        'border-strong': token('border-strong'),
        primary: token('primary'),
        'primary-foreground': token('primary-foreground'),
        accent: token('accent'),
        'accent-foreground': token('accent-foreground'),
        success: token('success'),
        warning: token('warning'),
        danger: token('danger'),
        info: token('info'),
        focus: token('focus'),
      },
      /* Two elevation levels, warm-tinted to match the ink: panels sit just above the canvas; the canvas and popovers float. */
      boxShadow: {
        panel: '0 1px 2px 0 rgb(28 25 23 / 0.04)',
        raised: '0 1px 2px 0 rgb(28 25 23 / 0.04), 0 4px 12px -4px rgb(28 25 23 / 0.06)',
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};

export default config;
