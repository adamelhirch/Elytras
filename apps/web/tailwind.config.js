/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        // Palette Elytras — sombre et moderne
        brand: {
          50: "#f0f4ff",
          100: "#dce6ff",
          400: "#6b8cff",
          500: "#4f6ef7",
          600: "#3b57e8",
          700: "#2d44c4",
          900: "#1a2a7a",
        },
      },
    },
  },
  plugins: [],
};
