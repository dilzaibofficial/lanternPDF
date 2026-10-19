import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "dist-server/**", "node_modules/**", "public/pdfjs/**", "test-results/**", "playwright-report/**", "coverage/**", "docs/evidence/**", "tests/.tmp/**"],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      eqeqeq: ["error", "always"],
      "no-var": "error",
      "prefer-const": "error",
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports", fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-non-null-assertion": "error",
    },
  },

  // The web app: browser code with React. Only the two classic hook rules are enforced; the other rules in the
  // plugin are for the React Compiler, which this project does not use.
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser, ...globals.worker } },
    plugins: { "react-hooks": reactHooks, "react-refresh": reactRefresh },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // A hook may live next to the provider it belongs to; only genuine mixes of components and other exports warn.
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true, allowExportNames: ["useCapabilities", "useEngineAvailable", "useHandoff", "useAcceptHandoff", "useTheme", "useCatalogState", "usePageScope"] }],
    },
  },

  // Plain browser scripts served as they are (the theme initialiser runs before the app loads).
  {
    files: ["public/**/*.js"],
    languageOptions: { sourceType: "script", globals: globals.browser },
  },

  // Node code: the optional server, build scripts, configuration and the test helpers.
  {
    files: ["server/**/*.ts", "shared/**/*.ts", "scripts/**/*.{js,mjs,ts}", "*.config.{js,ts}", "tests/**/*.{ts,mjs}"],
    languageOptions: { globals: globals.node },
    rules: { "no-console": "off" },
  },

  // Tests are allowed what makes assertions readable.
  {
    files: ["tests/**/*.{ts,mjs}"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
