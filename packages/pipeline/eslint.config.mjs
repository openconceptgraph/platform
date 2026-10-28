import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  ...tseslint.configs.recommended,
  {
    rules: {
      // Tests assert on rows they have just loaded.
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
]);
