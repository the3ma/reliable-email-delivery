import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useResource } from './useResource';

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

const flush = () =>
  act(async () => {
    await Promise.resolve();
  });

describe('useResource polling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    setVisibility('visible');
  });

  it('polls at the interval and doubles the delay after failures, up to the cap', async () => {
    let fail = true;
    const load = vi.fn(() => (fail ? Promise.reject(new Error('down')) : Promise.resolve(1)));
    const { result } = renderHook(() => useResource('k', load, { pollMs: 100, maxBackoffMs: 300 }));
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    expect(result.current.error?.message).toBe('down');

    await act(() => vi.advanceTimersByTimeAsync(199));
    expect(load).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(load).toHaveBeenCalledTimes(2); // 200 ms after the first failure

    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(load).toHaveBeenCalledTimes(3); // capped at 300 ms

    fail = false;
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(load).toHaveBeenCalledTimes(4);
    expect(result.current.data).toBe(1);
    expect(result.current.error).toBeUndefined();

    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(load).toHaveBeenCalledTimes(5); // back to the base interval after a success
  });

  it('pauses while the tab is hidden and refreshes as soon as it is visible', async () => {
    const load = vi.fn(() => Promise.resolve('ok'));
    renderHook(() => useResource('k', load, { pollMs: 100 }));
    await flush();
    expect(load).toHaveBeenCalledTimes(1);

    act(() => {
      setVisibility('hidden');
    });
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(load).toHaveBeenCalledTimes(1);

    act(() => {
      setVisibility('visible');
    });
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('keeps the last good data while a poll fails', async () => {
    let fail = false;
    const load = vi.fn(() => (fail ? Promise.reject(new Error('blip')) : Promise.resolve('v1')));
    const { result } = renderHook(() => useResource('k', load, { pollMs: 100 }));
    await flush();
    expect(result.current.data).toBe('v1');

    fail = true;
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(result.current.data).toBe('v1');
    expect(result.current.error?.message).toBe('blip');
    expect(result.current.loading).toBe(false);
  });

  it('reports loading again for a new key and drops stale data', async () => {
    const load = vi.fn((_signal: AbortSignal) => Promise.resolve('data'));
    const { result, rerender } = renderHook(({ k }) => useResource(k, load), {
      initialProps: { k: 'a' },
    });
    await flush();
    expect(result.current.data).toBe('data');
    rerender({ k: 'b' });
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeUndefined();
    await flush();
    expect(result.current.loading).toBe(false);
  });
});
