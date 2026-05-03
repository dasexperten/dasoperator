import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './node_modules/@tremor/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        background: 'hsl(0 0% 7%)',
        foreground: 'hsl(0 0% 98%)',
        card: 'hsl(0 0% 10%)',
        'card-foreground': 'hsl(0 0% 98%)',
        muted: 'hsl(0 0% 16%)',
        'muted-foreground': 'hsl(0 0% 64%)',
        border: 'hsl(0 0% 20%)',
        accent: 'hsl(24 95% 53%)',
        'accent-foreground': 'hsl(0 0% 98%)',
      },
      fontFamily: {
        sans: ['system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};

export default config;
