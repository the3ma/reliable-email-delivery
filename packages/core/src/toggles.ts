export const TOGGLE_CACHE_MS = 5 * 60 * 1000;

export interface ToggleSource {
  /** Parameter name (relative to the prefix) -> value. */
  fetch(): Promise<Record<string, string>>;
}

export interface Toggles {
  sendEmails: boolean;
  recordDeliveries: boolean;
  /** fresh: just fetched; cached: within TTL; stale: refresh failed, old values served; failsafe: nothing to serve. */
  source: 'fresh' | 'cached' | 'stale' | 'failsafe';
}

export interface ToggleCacheOptions {
  ttlMs?: number;
  clock?: () => number;
  onRefreshError?: (error: unknown, servingStale: boolean) => void;
}

const FAIL_SAFE: Omit<Toggles, 'source'> = { sendEmails: false, recordDeliveries: false };

function interpret(values: Record<string, string>): Omit<Toggles, 'source'> {
  // Only the exact value enables; a typo or a missing parameter disables.
  return {
    sendEmails: values['send-emails'] === 'enabled',
    recordDeliveries: values['record-deliveries'] === 'enabled',
  };
}

/**
 * Lives at module scope in a Lambda so warm invocations reuse it. On refresh failure the stale
 * cache is served; with no cache at all both toggles are off (fail safe, not fail open).
 */
export class ToggleCache {
  private value: Omit<Toggles, 'source'> | undefined;
  private fetchedAt = 0;
  private readonly ttlMs: number;
  private readonly clock: () => number;

  constructor(
    private readonly source: ToggleSource,
    private readonly options: ToggleCacheOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? TOGGLE_CACHE_MS;
    this.clock = options.clock ?? Date.now;
  }

  async get(): Promise<Toggles> {
    const now = this.clock();
    if (this.value && now - this.fetchedAt < this.ttlMs) return { ...this.value, source: 'cached' };
    try {
      const values = await this.source.fetch();
      this.value = interpret(values);
      this.fetchedAt = now;
      return { ...this.value, source: 'fresh' };
    } catch (error) {
      this.options.onRefreshError?.(error, this.value !== undefined);
      if (this.value) return { ...this.value, source: 'stale' };
      return { ...FAIL_SAFE, source: 'failsafe' };
    }
  }
}

/** Deploy-time switch: anything except the literal string `false` (including unset) disables sending. */
export function isHardDisabled(value: string | undefined): boolean {
  return value !== 'false';
}
