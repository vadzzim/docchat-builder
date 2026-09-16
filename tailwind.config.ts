import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#172033",
        cloud: "#f7f8fc",
        lilac: "#7064d8",
      },
    },
  },
  plugins: [],
};

export default config;
