import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // shadcn registry components import from "@/..." — the CLI writes them
      // expecting this alias, so it has to match components.json.
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // The fee arithmetic the UI quotes must be the same code the vault runs.
      // Aliasing the engine rather than copying it means a change to the
      // protocol fee cannot land in one place and not the other.
      "@engine": fileURLToPath(new URL("../src", import.meta.url)),
    },
  },
  server: { port: 5173 },
});
