/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx}",
    "./components/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        uga: {
          red: "#BA0C2F",
          "red-dark": "#8A0922",
          black: "#000000",
          white: "#FFFFFF",
          gray: "#F3F4F6",
          "gray-mid": "#9CA3AF",
        },
      },
      fontFamily: {
        display: ['"Merriweather"', "Georgia", "serif"],
        body: ['"Source Sans 3"', '"Source Sans Pro"', "system-ui", "sans-serif"],
      },
      keyframes: {
        "pulse-red": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.6" },
        },
        "slide-up": {
          "0%": { opacity: "0", transform: "translateY(16px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "fade-in": {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        "scale-in": {
          "0%": { opacity: "0", transform: "scale(0.9)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
        "bar-grow": {
          "0%": { width: "0%" },
          "100%": { width: "var(--bar-width)" },
        },
      },
      animation: {
        "pulse-red": "pulse-red 2s ease-in-out infinite",
        "slide-up": "slide-up 0.4s ease-out forwards",
        "fade-in": "fade-in 0.3s ease-out forwards",
        "scale-in": "scale-in 0.3s ease-out forwards",
        "bar-grow": "bar-grow 0.6s ease-out forwards",
      },
    },
  },
  plugins: [],
};
