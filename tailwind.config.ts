import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // UI Spec 视觉 Token
        "bg-page": "#f5f7fb",
        "bg-card": "#ffffff",
        "text-primary": "#1f2937",
        "text-secondary": "#6b7280",
        "text-report": "#8a6a3b",
        "brand-dark": "#0f2744",
        "border-soft": "#e5e7eb",
        "chip-bg": "#f3f4f6",
        // 研究方向色点
        "dir-all": "#d4a017",
        "dir-arch": "#3b82f6",
        "dir-repr": "#14b8a6",
        "dir-gen": "#b45309",
        "dir-lm": "#8b5cf6",
        "dir-agent": "#ef4444",
        "dir-vision": "#2563eb",
        "dir-mm": "#e11d48",
        "dir-rl": "#65a30d",
        "dir-embodied": "#f43f5e",
        "dir-ad3d": "#6b7280",
      },
      borderRadius: {
        card: "20px",
        chip: "10px",
        button: "12px",
      },
      boxShadow: {
        card: "0 8px 30px rgba(15, 23, 42, 0.06)",
      },
      backgroundImage: {
        "grid-pattern": "url('/grid-pattern.svg')",
      },
    },
  },
  plugins: [],
};

export default config;
