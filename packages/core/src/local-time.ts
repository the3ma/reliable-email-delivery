export interface LocalParts {
  /** YYYY-MM-DD in the given zone. */
  date: string;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of `instant` in `timeZone`; DST comes from the platform's tz database. */
export function localParts(instant: Date, timeZone: string): LocalParts {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): string => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new Error(`missing ${type} in formatted date`);
    return part.value;
  };
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')),
    minute: Number(get('minute')),
  };
}

export interface DigestWindow {
  /** Inclusive local hour, 0-23. */
  startHour: number;
  /** Exclusive local hour, 1-24. */
  endHour: number;
}

export const DEFAULT_DIGEST_WINDOW: DigestWindow = { startHour: 6, endHour: 10 };

export interface DigestDue {
  due: boolean;
  localDate: string;
}

/** Due when the user's local wall-clock hour is inside the window; the period is their local date. */
export function digestDue(instant: Date, timeZone: string, window: DigestWindow): DigestDue {
  const local = localParts(instant, timeZone);
  return {
    due: local.hour >= window.startHour && local.hour < window.endHour,
    localDate: local.date,
  };
}

export function parseDigestWindow(
  start: string | undefined,
  end: string | undefined,
): DigestWindow {
  const startHour =
    start === undefined || start === '' ? DEFAULT_DIGEST_WINDOW.startHour : Number(start);
  const endHour = end === undefined || end === '' ? DEFAULT_DIGEST_WINDOW.endHour : Number(end);
  if (
    !Number.isInteger(startHour) ||
    !Number.isInteger(endHour) ||
    startHour < 0 ||
    endHour > 24 ||
    startHour >= endHour
  ) {
    throw new Error('digest window must satisfy 0 <= start < end <= 24 (whole hours)');
  }
  return { startHour, endHour };
}
