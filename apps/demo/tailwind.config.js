/** @type {import('tailwindcss').Config} */

// shadcn-style theme tokens used by the library components (`bg-background`,
// `text-muted-foreground`, `border-border`, `bg-primary/10`, ...). The values
// live in `src/index.css` as space-separated RGB channels so Tailwind's
// opacity modifiers work.
const token = (name) => `rgb(var(--${name}-rgb) / <alpha-value>)`;

export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
    "../../packages/*/src/**/*.{js,ts,jsx,tsx,svelte}",
  ],
  theme: {
    extend: {
      colors: {
        background: token("background"),
        foreground: token("foreground"),
        border: token("border"),
        input: token("input"),
        ring: token("ring"),
        muted: { DEFAULT: token("muted"), foreground: token("muted-foreground") },
        primary: { DEFAULT: token("primary"), foreground: token("primary-foreground") },
        secondary: { DEFAULT: token("secondary"), foreground: token("secondary-foreground") },
        accent: { DEFAULT: token("accent"), foreground: token("accent-foreground") },
        destructive: { DEFAULT: token("destructive"), foreground: token("destructive-foreground") },
        popover: { DEFAULT: token("popover"), foreground: token("popover-foreground") },
        card: { DEFAULT: token("card"), foreground: token("card-foreground") },
      },
      keyframes: {
        gradient: {
          "0%, 100%": { backgroundPosition: "0% 50%" },
          "50%": { backgroundPosition: "100% 50%" },
        },
      },
      animation: {
        gradient: "gradient 6s ease infinite",
      },
    },
  },
  plugins: [],
};
