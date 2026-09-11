/** Shaped like a newspaper host: Tailwind v4 over a token layer. */
export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: "var(--bt-surface)",
        ink: "var(--bt-ink)",
        rule: "var(--bt-rule)",
        masthead: "var(--bt-masthead)",
      },
      fontFamily: { serif: "var(--bt-font-headline)" },
      borderRadius: { card: "var(--bt-radius)" },
    },
  },
};
