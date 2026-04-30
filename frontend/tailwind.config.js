module.exports = {
  content: ["./src/**/*.{js,jsx,ts,tsx}", "./public/index.html"],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        heading: ["Manrope", "system-ui", "sans-serif"],
        body: ["Work Sans", "system-ui", "sans-serif"],
      },
      colors: {
        bg: { base: "#0B1010", surface: "#141C1C", elevated: "#1E2929" },
        ink: { primary: "#F8FAFA", secondary: "#A1B0B0", tertiary: "#687777" },
        brand: {
          DEFAULT: "#2B8A8F",
          light: "#45A7AC",
          dark: "#19666B",
          subtle: "rgba(43,138,143,0.15)",
        },
        income: "#10B981",
        expense: "#F43F5E",
        warn: "#F59E0B",
        info: "#3B82F6",
      },
      borderColor: {
        subtle: "rgba(255,255,255,0.06)",
        strong: "rgba(255,255,255,0.12)",
      },
      borderRadius: {
        xl: "0.75rem",
        "2xl": "1rem",
      },
      boxShadow: {
        card: "0 2px 8px rgba(0,0,0,0.25)",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};
