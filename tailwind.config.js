/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx}",
    "./components/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      // Admin console palette. Neutral names; the values keep the original look.
      // `muted` is secondary text: 5.2:1 on `surface` and 5.8:1 on white (WCAG AA).
      colors: {
        brand: {
          DEFAULT: "#BA0C2F",
          dark: "#8A0922",
        },
        ink: "#000000",
        surface: "#F3F4F6",
        muted: "#5F6673",
      },
      // Fonts are self-hosted by next/font (app/layout.js), which sets these variables.
      fontFamily: {
        display: ["var(--font-display)", "Georgia", "serif"],
        body: ["var(--font-body)", "system-ui", "sans-serif"],
      },
      keyframes: {
        "pulse-soft": {
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
        // `both` holds the first keyframe during an animation-delay, so a
        // staggered item stays hidden until its turn instead of blinking.
        "pulse-soft": "pulse-soft 2s ease-in-out infinite",
        "slide-up": "slide-up 0.4s ease-out both",
        "fade-in": "fade-in 0.3s ease-out both",
        "scale-in": "scale-in 0.3s ease-out both",
        "bar-grow": "bar-grow 0.6s ease-out both",
      },
    },
  },
  plugins: [],
};
