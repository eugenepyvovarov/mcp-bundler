/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./preview.html",
    "./js/**/*.js",
    // Include any other template files if they exist
  ],
  safelist: [
    // Ensure purple classes are always included
    'bg-purple-600',
    'bg-purple-700',
    'hover:bg-purple-600',
    'hover:bg-purple-700',
    'text-purple-600',
    'text-purple-700',
    'border-purple-600',
    'border-purple-700',
  ],
  theme: {
    extend: {
      // Custom colors for the MCP Catalogue
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
        }
      },
      // Custom spacing if needed
      spacing: {
        '18': '4.5rem',
        '88': '22rem',
      }
    },
  },
  plugins: [],
}