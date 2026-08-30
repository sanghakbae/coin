export const IOS_HINT_SNOOZE_MS: number;

export function isIosSafari(userAgent: string, maxTouchPoints?: number): boolean;

export function shouldShowIosHint(input: {
  userAgent: string;
  maxTouchPoints?: number;
  standalone?: boolean;
  dismissedAt?: number;
  now?: number;
}): boolean;
