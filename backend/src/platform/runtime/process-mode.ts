import type { ProcessMode } from '../config/types.js';

export function startsHttpServer(mode: ProcessMode): boolean {
  return mode === 'web' || mode === 'combined';
}

export function startsRecurrenceWorker(mode: ProcessMode): boolean {
  return mode === 'worker' || mode === 'combined';
}
