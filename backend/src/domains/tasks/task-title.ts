import { InvalidTaskTitleError } from './errors.js';

/**
 * Bounded only by the unbounded TEXT persistence column. Trims surrounding
 * whitespace, rejects empty-after-trim, and does not truncate or slug.
 */
export function normalizeTaskTitle(raw: string): string {
  const title = raw.trim();
  if (title.length === 0) {
    throw new InvalidTaskTitleError();
  }
  return title;
}
