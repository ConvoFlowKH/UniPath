/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./public/index.html'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        heading: ['Urbanist', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      colors: {
        brand: {
          50: '#fff3ed', 100: '#ffe3d5', 200: '#ffc4aa', 300: '#ff9c74',
          400: '#ff8256', 500: '#fe6a2e', 600: '#ef5015', 700: '#c73e10',
          800: '#9e3212', 900: '#7f2c14',
        },
        ink: { 900: '#111111', 800: '#1b1b1b', 700: '#292929' },
      },
      boxShadow: {
        soft: '0 10px 30px -10px rgba(15, 23, 42, 0.12)',
        card: '0 2px 10px rgba(15, 23, 42, 0.06)',
      },
      keyframes: {
        popIn: { '0%': { opacity: 0, transform: 'scale(.9)' }, '100%': { opacity: 1, transform: 'scale(1)' } },
        checkDraw: { '0%': { strokeDashoffset: 48 }, '100%': { strokeDashoffset: 0 } },
      },
      animation: {
        popIn: 'popIn .35s ease forwards',
        checkDraw: 'checkDraw .6s ease forwards .15s',
      },
    },
  },
  plugins: [],
};
