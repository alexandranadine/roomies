#!/usr/bin/env node
/**
 * Lightweight import-boundary guard for Roomies monorepo layers.
 *
 * Protected rules (M0 — intentionally small; extend as domains appear):
 * - frontend must not import backend or Prisma implementation
 * - backend must not import frontend
 * - shared must stay environment-neutral (no Node/browser-only APIs via imports,
 *   and must not import frontend, backend, or Prisma)
 * - backend domain modules must not reach into another domain's repository/
 *   internal persistence (pattern reserved for future domains)
 * - Prisma client/contract internals stay under backend platform/persistence
 *   (and prisma/), not frontend/shared
 *
 * This is a filesystem import scan, not Nx/Turborepo. Add rules as the graph grows.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]);

/** @typedef {{ file: string, line: number, importPath: string, rule: string }} Violation */

/** @type {Violation[]} */
const violations = [];

/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function walk(dir) {
  /** @type {string[]} */
  const files = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return files;
    }
    throw error;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === 'node_modules' ||
        entry.name === 'dist' ||
        entry.name === 'dist-ssr' ||
        entry.name === 'coverage' ||
        entry.name === 'test-results' ||
        entry.name === 'playwright-report'
      ) {
        continue;
      }
      files.push(...(await walk(full)));
      continue;
    }
    if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
}

/**
 * @param {string} source
 * @returns {{ path: string, line: number }[]}
 */
function extractImports(source) {
  /** @type {{ path: string, line: number }[]} */
  const found = [];
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
  ];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const before = source.slice(0, match.index);
      const line = before.split('\n').length;
      found.push({ path: match[1], line });
    }
  }
  return found;
}

/**
 * @param {string} file
 * @param {string} importPath
 * @param {number} line
 * @param {string} rule
 */
function fail(file, importPath, line, rule) {
  violations.push({
    file: path.relative(root, file).replaceAll('\\', '/'),
    line,
    importPath,
    rule,
  });
}

/**
 * @param {string} importPath
 */
function isPrismaPackage(importPath) {
  return (
    importPath === 'prisma' ||
    importPath.startsWith('prisma/') ||
    importPath === '@prisma/orm-postgres' ||
    importPath.startsWith('@prisma/')
  );
}

/**
 * @param {string} file
 * @param {string} importPath
 * @param {number} line
 */
function checkFrontend(file, importPath, line) {
  if (
    importPath.startsWith('@roomies/backend') ||
    importPath.includes('/backend/') ||
    /(^|\/)backend(\/|$)/.test(importPath)
  ) {
    fail(file, importPath, line, 'frontend must not import backend');
  }
  if (isPrismaPackage(importPath)) {
    fail(file, importPath, line, 'frontend must not import Prisma');
  }
  // Relative escapes into backend/shared prisma
  if (
    importPath.includes('src/prisma') ||
    importPath.includes('contract.prisma')
  ) {
    fail(
      file,
      importPath,
      line,
      'frontend must not import Prisma contract artifacts',
    );
  }
}

/**
 * @param {string} file
 * @param {string} importPath
 * @param {number} line
 */
function checkBackend(file, importPath, line) {
  if (
    importPath.startsWith('@roomies/frontend') ||
    importPath.includes('/frontend/') ||
    /(^|\/)frontend(\/|$)/.test(importPath)
  ) {
    fail(file, importPath, line, 'backend must not import frontend');
  }

  const rel = path.relative(root, file).replaceAll('\\', '/');
  if (
    importPath === 'better-auth' ||
    importPath.startsWith('better-auth/') ||
    importPath.startsWith('@better-auth/')
  ) {
    fail(
      file,
      importPath,
      line,
      'backend must access Better Auth through platform/auth and auth-runtime',
    );
  }
  // Future domain isolation: domain A must not import domain B's repository internals.
  // Pattern: backend/src/domains/<name>/... importing .../domains/<other>/.../repository
  const domainMatch = /^backend\/src\/domains\/([^/]+)\//.exec(rel);
  if (domainMatch) {
    const ownDomain = domainMatch[1];
    const otherRepo =
      /(?:^|[./])domains\/([^/]+)\/(?:.+\/)?(?:repository|repositories)(?:\/|$)/.exec(
        importPath,
      );
    if (otherRepo && otherRepo[1] !== ownDomain) {
      fail(
        file,
        importPath,
        line,
        `domain "${ownDomain}" must not import domain "${otherRepo[1]}" repository internals`,
      );
    }
  }
}

/**
 * @param {string} file
 * @param {string} importPath
 * @param {number} line
 */
function checkAuthRuntime(file, importPath, line) {
  if (
    isPrismaPackage(importPath) ||
    importPath.includes('/prisma/') ||
    importPath.includes('/domains/')
  ) {
    fail(
      file,
      importPath,
      line,
      'auth-runtime must not depend on Prisma or product/domain modules',
    );
  }
}

/**
 * @param {string} file
 * @param {string} importPath
 * @param {number} line
 */
function checkShared(file, importPath, line) {
  if (
    importPath.startsWith('@roomies/frontend') ||
    importPath.startsWith('@roomies/backend') ||
    /(^|\/)frontend(\/|$)/.test(importPath) ||
    /(^|\/)backend(\/|$)/.test(importPath)
  ) {
    fail(file, importPath, line, 'shared must not import frontend or backend');
  }
  if (isPrismaPackage(importPath)) {
    fail(file, importPath, line, 'shared must not import Prisma');
  }
  // Node/browser implementation packages that would break environment neutrality
  const forbidden = [
    'express',
    'cors',
    'helmet',
    'react',
    'react-dom',
    'react-router',
    'vite',
    'fs',
    'node:fs',
    'path',
    'node:path',
    'http',
    'node:http',
  ];
  if (forbidden.includes(importPath)) {
    fail(
      file,
      importPath,
      line,
      'shared must remain environment-neutral (no Node/browser runtime imports)',
    );
  }
}

/**
 * @param {string} packageDir
 * @param {(file: string, importPath: string, line: number) => void} checker
 */
async function scanPackage(packageDir, checker) {
  const files = await walk(path.join(root, packageDir));
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const item of extractImports(source)) {
      checker(file, item.path, item.line);
    }
  }
}

await scanPackage('frontend/src', checkFrontend);
await scanPackage('backend/src', checkBackend);
await scanPackage('backend/auth-runtime/src', checkAuthRuntime);
await scanPackage('shared/src', checkShared);

if (violations.length > 0) {
  console.error('Architecture boundary violations:\n');
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    import "${v.importPath}"`);
    console.error(`    rule: ${v.rule}\n`);
  }
  process.exit(1);
}

console.log('Architecture boundary checks passed.');
