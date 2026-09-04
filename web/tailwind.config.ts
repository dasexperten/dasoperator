import type { Config } from 'tailwindcss';

const config: Config = {
  // No darkMode — apothecary system is light by default with dark inverse zones
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './node_modules/@tremor/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // ===== APOTHECARY CANVAS =====
        // Warm off-white paper (not stark white)
        background: 'var(--bg-canvas)',     // paper #FBFAF6
        foreground: 'var(--fg-1)',          // schwarz-ink #1A1519

        card: 'var(--paper-raised)',         // pure white for cards
        'card-foreground': 'var(--fg-1)',

        muted: 'var(--paper-sunk)',          // F3F0E8 sunk panels
        'muted-foreground': 'var(--fg-2)',   // stone-500

        // ===== BORDERS =====
        border: 'var(--border-hairline)',    // 1px hairlines
        input: 'var(--border-subtle)',
        ring: 'var(--brand-rot)',

        // ===== HERITAGE PALETTE =====
        // Used as accents only, never large fills
        schwarz: {
          DEFAULT: 'var(--brand-schwarz)',   // #282229
          ink: 'var(--brand-schwarz-ink)',   // #1A1519 deeper
        },
        rot: {
          DEFAULT: 'var(--brand-rot)',       // #E5202C signature red
          deep: '#A6141F',                    // hover/press — one step under the accent
        },
        gold: 'var(--brand-gold)',           // #FEF004
        paper: 'var(--paper)',

        // ===== STONES (apothecary neutrals) =====
        stone: {
          100: 'var(--stone-100)',
          200: 'var(--stone-200)',
          300: 'var(--stone-300)',
          400: 'var(--stone-400)',
          500: 'var(--stone-500)',
          600: 'var(--stone-600)',
          700: 'var(--stone-700)',
        },
        bone: 'var(--bone)',

        // ===== ACCENT (rot is our action color) =====
        accent: {
          DEFAULT: 'var(--brand-rot)',
          foreground: 'var(--paper-raised)',
        },

        // ===== STATUS =====
        success: 'var(--status-success)',
        warning: 'var(--status-warning)',
        error: 'var(--status-error)',
        info: 'var(--status-info)',

        // ===== TREMOR v3 TOKENS =====
        // Tremor paints its charts, tooltips and legends with `*-tremor-*`
        // utilities. Undefined here, they generated nothing — the tooltip came
        // out with no plate and its ink landed on top of the dark bars. Pinned
        // to the apothecary palette so every Tremor surface obeys the contrast
        // law (Owner hard block · Marika 2026-09-04).
        tremor: {
          brand: {
            faint: 'var(--paper-sunk)',
            muted: '#F8D3D6',
            subtle: '#EC6670',
            DEFAULT: 'var(--brand-rot)',
            emphasis: '#C71926',
            inverted: 'var(--paper-raised)',
          },
          background: {
            muted: 'var(--paper-sunk)',
            subtle: 'var(--paper)',
            DEFAULT: 'var(--paper-raised)',
            emphasis: 'var(--fg-1)',
          },
          border: { DEFAULT: 'var(--border-subtle)' },
          ring: { DEFAULT: 'var(--border-strong)' },
          content: {
            subtle: 'var(--fg-2)',
            DEFAULT: 'var(--fg-2)',
            emphasis: 'var(--fg-1)',
            strong: 'var(--fg-1)',
            inverted: 'var(--paper-raised)',
          },
        },

        // ===== PRODUCT LINE ACCENTS =====
        innoweiss: 'var(--line-innoweiss)',
        detox: 'var(--line-detox)',
        fresh: 'var(--line-fresh)',
        sensitive: 'var(--line-sensitive)',
        kids: 'var(--line-kids)',
      },

      fontFamily: {
        sans: ['var(--font-body)'],
        display: ['var(--font-display)'],
        narrow: ['var(--font-narrow)'],
        accent: ['var(--font-accent)'],
        mono: ['var(--font-mono)'],
      },

      fontSize: {
        'tremor-label': ['13px', { lineHeight: '18px' }],
        'tremor-default': ['14px', { lineHeight: '20px' }],
        'tremor-title': ['16px', { lineHeight: '24px' }],
        'tremor-metric': ['30px', { lineHeight: '36px' }],
      },

      borderRadius: {
        // Restrained apothecary radii
        none: '0',
        xs: 'var(--radius-xs)',     // 2px
        sm: 'var(--radius-sm)',     // 4px
        DEFAULT: 'var(--radius-sm)', // 4px (default = sm in apothecary)
        md: 'var(--radius-md)',     // 6px
        lg: 'var(--radius-lg)',     // 10px
        full: 'var(--radius-pill)', // pill (only for tags/chips)
        'tremor-small': 'var(--radius-xs)',
        'tremor-default': 'var(--radius-sm)',
        'tremor-full': 'var(--radius-pill)',
      },

      boxShadow: {
        // Printed shadows, not glassy
        none: 'none',
        hairline: 'var(--shadow-hairline)',
        card: 'var(--shadow-card)',
        raised: 'var(--shadow-raised)',
        float: 'var(--shadow-float)',
        DEFAULT: 'var(--shadow-card)',
        'tremor-input': 'var(--shadow-hairline)',
        'tremor-card': 'var(--shadow-card)',
        'tremor-dropdown': 'var(--shadow-float)',
      },

      transitionTimingFunction: {
        standard: 'var(--ease-standard)',
        emphasis: 'var(--ease-emphasis)',
        exit: 'var(--ease-exit)',
      },

      transitionDuration: {
        fast: 'var(--dur-fast)',     // 120ms
        DEFAULT: 'var(--dur-base)',  // 200ms
        slow: 'var(--dur-slow)',     // 360ms
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};

export default config;
