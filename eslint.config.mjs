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
      // Prisma 8 generated contract artifacts (re-emitted; do not hand-edit)
      '**/src/prisma/contract.json',
      '**/src/prisma/contract.d.ts',
      '**/migrations/snapshots/**',
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
