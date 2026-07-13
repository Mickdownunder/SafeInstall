// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * ESLint flat config. Lints the TypeScript core (src/, tests/) with
 * type-aware rules — the linter the code-SOTA audit flagged as missing.
 *
 * The three rules the audit named are enforced as errors on top of the
 * recommended sets:
 *   - @typescript-eslint/no-explicit-any (from recommended)
 *   - @typescript-eslint/no-floating-promises (type-aware; catches un-awaited
 *     promises — a real correctness hazard in this async-heavy codebase)
 *   - @typescript-eslint/switch-exhaustiveness-check (type-aware; every union
 *     switch must handle all members, so a new finding kind or status can't
 *     silently fall through)
 *
 * The .mjs/.cjs build and demo scripts are not part of the typed core and are
 * not in tsconfig, so they are left out of type-aware linting.
 */
export default tseslint.config(
  {
    ignores: ["dist/**", "coverage/**", "**/*.mjs", "**/*.cjs", "demo/**", "scripts/**"]
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      // `_`-prefix is the codebase's marker for a deliberately-unused binding
      // (a dropped destructure key, a signature-only param, an ignored catch).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }
      ],
      // package.json is read at runtime via require() so the build (rootDir:
      // src) never bundles the manifest into dist/. Allow require() for JSON.
      "@typescript-eslint/no-require-imports": ["error", { allow: ["\\.json$"] }]
    }
  }
);
