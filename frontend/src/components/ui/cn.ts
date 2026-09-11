import { clsx, type ClassValue } from 'clsx';

/** Small className composer for UI primitives. */
export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}
