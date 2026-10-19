import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Identifier names that denote money; the float path must be unavailable for them.
const MONEY = "/[Pp]aise|[Aa]mount|[Bb]alance/";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Domain layer purity: no framework/DB imports, and no float path for money (EC-1).
  {
    files: ["src/domain/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@prisma/client", "next", "next/*", "../server/*", "../../server/*"],
              message: "src/domain must stay pure: no Prisma, Next.js or server imports.",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: `CallExpression[callee.name='parseFloat'][arguments.0.name=${MONEY}], CallExpression[callee.name='parseFloat'][arguments.0.property.name=${MONEY}]`,
          message: "No float parsing of money values; use integer paise.",
        },
        {
          selector: `CallExpression[callee.name='Number'][arguments.0.name=${MONEY}], CallExpression[callee.name='Number'][arguments.0.property.name=${MONEY}]`,
          message: "No Number() coercion of money values; use BigInt/integer paise.",
        },
        {
          selector: `CallExpression[callee.property.name='toFixed'][callee.object.name=${MONEY}], CallExpression[callee.property.name='toFixed'][callee.object.property.name=${MONEY}]`,
          message: "No .toFixed() on money values; format from integer paise.",
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
