import eslint from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-ssr/**',
      '**/*.tsbuildinfo',
      'coverage/**',
      'package-lock.json',
      'frontend/test-results/**',
      'frontend/playwright-report/**',
      'frontend/blob-report/**',
      // Vite HTML entry is not TypeScript-checked
      'frontend/index.html',
      // Prisma 8 generated contract artifacts (re-emitted; do not hand-edit)
      '**/src/prisma/contract.json',
      '**/src/prisma/contract.d.ts',
      '**/migrations/snapshots/**',
      '**/migrations/app/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['frontend/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },
  {
    files: ['frontend/vite.config.ts', 'frontend/playwright.config.ts'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ['frontend/e2e/**/*.{ts,tsx}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
  },
  {
    files: ['scripts/**/*.{js,mjs,cjs}', 'backend/scripts/**/*.{ts,js,mjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ['backend/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ['shared/**/*.{ts,tsx}'],
    languageOptions: {
      // Environment-neutral: no Node or browser globals.
      globals: {},
    },
  },
  {
    files: ['*.{js,mjs,cjs}', 'eslint.config.*'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  eslintConfigPrettier,
);
