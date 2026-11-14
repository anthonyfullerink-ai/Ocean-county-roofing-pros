/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    './app/templates/**/*.html',
    './app/static/js/**/*.js',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Plus Jakarta Sans', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      colors: {
        brand: {
          navy: '#0A486D',
          teal: '#17ABA4',
          blue: '#0A486D',
          accent: '#17ABA4',
          dark: '#062B42',
          light: '#F8FAFC',
        },
        obsidian: {
          bg: '#0a0a0c',
          sidebar: '#0f1014',
          card: '#14161c',
          hover: '#1a1d26',
          border: '#1f222a',
          accent: '#14b8a6',
        },
      },
    },
  },
  plugins: [],
};
