import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  // O mesmo `@/` do tsconfig. O vitest nao le `paths` do TypeScript sozinho.
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    // `node`: o que esta sob teste e a parte PURA (reducer + borda do
    // transporte). Nada aqui toca DOM -- se um teste precisar de browser, o
    // corte entre modelo e tela esta errado.
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
