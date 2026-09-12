export const HOME_ACTION = {
  read: 'home.read',
} as const;

export type HomeAction = (typeof HOME_ACTION)[keyof typeof HOME_ACTION];
