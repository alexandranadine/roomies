#!/usr/bin/env node
/**
 * Guard for the authoritative full-verification path.
 *
 * Lightweight `npm run check` may skip PostgreSQL integration tests when
 * TEST_DATABASE_URL is unset. Full verification must refuse that silence.
 *
 * Does not print, persist, or hardcode credentials.
 */

const url = process.env['TEST_DATABASE_URL']?.trim();

if (!url) {
  console.error(
    'TEST_DATABASE_URL is required for full verification. PostgreSQL integration tests must not be skipped.',
  );
  console.error(
    'Set TEST_DATABASE_URL to a dedicated local/CI test database (name matching *_test or *_ci), then rerun.',
  );
  console.error(
    'Unit-only workflows can keep using `npm run check` without this variable.',
  );
  process.exit(1);
}

console.log('TEST_DATABASE_URL is set for full verification.');
