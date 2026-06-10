/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        page: "#0d1219",
        surface: "#121a28",
        elevated: "#1a2436",
        panel: "#161f30",
        panelBorder: "#2d3d56",
        foreground: "#f0f4fc",
        muted: "#c8d4e6",
        subtle: "#9eb0c8",
        faint: "#7d92ad",
        accent: "#B6F906",
        buy: "#22c55e",
        sell: "#ef4444"
      }
    }
  },
  plugins: []
};
