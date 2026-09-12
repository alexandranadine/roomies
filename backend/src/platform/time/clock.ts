/**
 * Injectable time port. Command use cases take one Clock.now() as the
 * semantic occurredAt for that command.
 */
export type Clock = {
  now(): Date;
};

export const systemClock: Clock = {
  now() {
    return new Date();
  },
};
