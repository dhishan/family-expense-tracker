/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#eff6ff',
          100: '#dbeafe',
          200: '#bfdbfe',
          300: '#93c5fd',
          400: '#60a5fa',
          500: '#3b82f6',
          600: '#2563eb',
          700: '#1d4ed8',
          800: '#1e40af',
          900: '#1e3a8a',
          950: '#172554',
        },
        expense: {
          groceries: '#22c55e',
          dining: '#f97316',
          transportation: '#3b82f6',
          utilities: '#a855f7',
          entertainment: '#ec4899',
          healthcare: '#14b8a6',
          shopping: '#eab308',
          travel: '#06b6d4',
          education: '#6366f1',
          other: '#6b7280',
        }
      },
    },
  },
  plugins: [],
}
