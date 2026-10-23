import { describe, expect, it, vi } from 'vitest';
import { TOGGLE_CACHE_MS, ToggleCache, isHardDisabled } from '../src/index.js';
import { StaticToggleSource } from '../src/testing/index.js';

const ENABLED = { 'send-emails': 'enabled', 'record-deliveries': 'enabled' };

function setup(values: Record<string, string> = ENABLED) {
  let now = 1_000_000;
  const source = new StaticToggleSource(values);
  const onRefreshError = vi.fn();
  const cache = new ToggleCache(source, { clock: () => now, onRefreshError });
  return { source, cache, onRefreshError, advance: (ms: number) => (now += ms) };
}

describe('ToggleCache', () => {
  it('fetches once and serves from cache for 5 minutes', async () => {
    const { source, cache, advance } = setup();
    expect(await cache.get()).toEqual({
      sendEmails: true,
      recordDeliveries: true,
      source: 'fresh',
    });
    advance(TOGGLE_CACHE_MS - 1);
    expect((await cache.get()).source).toBe('cached');
    expect(source.calls).toBe(1);
    advance(1);
    expect((await cache.get()).source).toBe('fresh');
    expect(source.calls).toBe(2);
  });

  it('serves the stale cache when a refresh fails', async () => {
    const { source, cache, advance, onRefreshError } = setup();
    await cache.get();
    source.failWith = new Error('ssm down');
    advance(TOGGLE_CACHE_MS);
    expect(await cache.get()).toEqual({
      sendEmails: true,
      recordDeliveries: true,
      source: 'stale',
    });
    expect(onRefreshError).toHaveBeenCalledWith(source.failWith, true);
  });

  it('fails safe (everything off) when there is no cache at all', async () => {
    const { source, cache, onRefreshError } = setup();
    source.failWith = new Error('ssm down');
    expect(await cache.get()).toEqual({
      sendEmails: false,
      recordDeliveries: false,
      source: 'failsafe',
    });
    expect(onRefreshError).toHaveBeenCalledWith(source.failWith, false);
  });

  it('retries the fetch on the next call after a fail-safe answer', async () => {
    const { source, cache } = setup();
    source.failWith = new Error('ssm down');
    await cache.get();
    source.failWith = undefined;
    expect((await cache.get()).sendEmails).toBe(true);
  });

  it.each([
    [{}, false],
    [{ 'send-emails': 'disabled' }, false],
    [{ 'send-emails': 'Enabled' }, false],
    [{ 'send-emails': 'true' }, false],
    [{ 'send-emails': 'enabled' }, true],
  ])('only the exact value "enabled" enables: %j -> %s', async (values, expected) => {
    const { cache } = setup(values);
    expect((await cache.get()).sendEmails).toBe(expected);
  });
});

describe('isHardDisabled', () => {
  it.each([
    [undefined, true],
    ['', true],
    ['true', true],
    ['FALSE', true],
    ['False', true],
    [' false', true],
    ['0', true],
    ['no', true],
    ['false', false],
  ])('SENDING_HARD_DISABLED=%j -> disabled=%s', (value, expected) => {
    expect(isHardDisabled(value)).toBe(expected);
  });
});
