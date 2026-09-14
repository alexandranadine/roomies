export const HOUSE_PULSE_ACTION = {
  read: 'house_pulse.read',
} as const;

export type HousePulseAction =
  (typeof HOUSE_PULSE_ACTION)[keyof typeof HOUSE_PULSE_ACTION];
