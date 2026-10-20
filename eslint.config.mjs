import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Identifier names that denote money; the float path must be unavailable for them.
const MONEY = "/[Pp]aise|[Aa]mount|[Bb]alance/";
// Selector matching a call whose argument is a money identifier (`amount`) or member (`row.amount`).
const moneyArg = (call, argPath) =>
  `${call}[${argPath}.name=${MONEY}], ${call}[${argPath}.property.name=${MONEY}]`;

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Applies to src/, tests/ and the config files alike. The Next presets do not enable it, which is how a duplicate
  // `vitest` import survived into a committed test file. `import type` beside a value import stays allowed.
  {
    rules: {
      "no-duplicate-imports": ["error", { allowSeparateTypeImports: true }],
    },
  },
  // Domain layer purity: no framework/DB imports, and no float path for money (EC-1).
  {
    files: ["src/domain/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              // `@/*` maps to `src/*`, so `@/server/*` is the server layer; `**/server` catches
              // relative paths of any depth. `@prisma/client`, `next`, `next/*` are package names
              // (no `@/` alias form of them exists).
              group: [
                "@prisma/client",
                "next",
                "next/*",
                "@/server",
                "@/server/*",
                "**/server",
                "**/server/*",
              ],
              message: "src/domain must stay pure: no Prisma, Next.js or server imports.",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: [
            moneyArg("CallExpression[callee.name='parseFloat']", "arguments.0"),
            moneyArg("CallExpression[callee.object.name='Number'][callee.property.name=/^parse(Float|Int)$/]", "arguments.0"),
          ].join(", "),
          message: "No float parsing of money values; use integer paise.",
        },
        {
          selector: moneyArg("CallExpression[callee.name='Number']", "arguments.0"),
          message: "No Number() coercion of money values; use BigInt/integer paise.",
        },
        {
          selector: `UnaryExpression[operator='+'][argument.name=${MONEY}], UnaryExpression[operator='+'][argument.property.name=${MONEY}]`,
          message: "No unary + coercion of money values; use BigInt/integer paise.",
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
