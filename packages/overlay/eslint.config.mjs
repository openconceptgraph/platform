import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  ...tseslint.configs.recommended,
  globalIgnores(["migrations/**"]),
  {
    rules: {
      // Tests assert on rows they have just inserted.
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
]);
