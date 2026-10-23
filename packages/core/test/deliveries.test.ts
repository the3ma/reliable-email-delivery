import { describe, expect, it } from 'vitest';
import { DeliveryStatus, claimDelivery, epochSeconds } from '../src/index.js';
import { InMemoryDeliveriesStore } from '../src/testing/index.js';

const ID = 'a'.repeat(64);
const T0 = new Date('2026-10-23T08:00:00Z');
const later = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000);

describe('claimDelivery state machine', () => {
  it('absent -> CLAIMED with a 120 s lease owned by the caller', async () => {
    const store = new InMemoryDeliveriesStore();
    const outcome = await claimDelivery(store, { deliveryId: ID, owner: 'req-1', now: T0 });
    expect(outcome).toEqual({ kind: 'claimed', leaseUntil: epochSeconds(T0) + 120 });
    expect(store.items.get(ID)).toMatchObject({
      status: DeliveryStatus.CLAIMED,
      leaseOwner: 'req-1',
      leaseUntil: epochSeconds(T0) + 120,
      attempts: 0,
    });
  });

  it('a live lease held by another worker is contention (retry later)', async () => {
    const store = new InMemoryDeliveriesStore();
    await claimDelivery(store, { deliveryId: ID, owner: 'req-1', now: T0 });
    const outcome = await claimDelivery(store, { deliveryId: ID, owner: 'req-2', now: later(60) });
    expect(outcome).toEqual({ kind: 'contended' });
    expect(store.items.get(ID)?.leaseOwner).toBe('req-1');
  });

  it('a lease is still live at exactly leaseUntil', async () => {
    const store = new InMemoryDeliveriesStore();
    await claimDelivery(store, { deliveryId: ID, owner: 'req-1', now: T0 });
    expect(await claimDelivery(store, { deliveryId: ID, owner: 'req-2', now: later(120) })).toEqual(
      {
        kind: 'contended',
      },
    );
  });

  it('an expired lease becomes AMBIGUOUS and is never resent', async () => {
    const store = new InMemoryDeliveriesStore();
    await claimDelivery(store, { deliveryId: ID, owner: 'req-1', now: T0 });
    const outcome = await claimDelivery(store, { deliveryId: ID, owner: 'req-2', now: later(121) });
    expect(outcome).toEqual({ kind: 'ambiguous' });
    expect(store.items.get(ID)).toMatchObject({
      status: DeliveryStatus.AMBIGUOUS,
      reason: 'lease_expired',
    });
    // A third worker now sees a terminal state.
    expect(await claimDelivery(store, { deliveryId: ID, owner: 'req-3', now: later(200) })).toEqual(
      {
        kind: 'duplicate',
        status: DeliveryStatus.AMBIGUOUS,
      },
    );
  });

  it('AMBIGUOUS is conditional on the observed lease: a concurrent change means contention', async () => {
    const store = new InMemoryDeliveriesStore();
    await claimDelivery(store, { deliveryId: ID, owner: 'req-1', now: T0 });
    const originalGet = store.get.bind(store);
    store.get = async (id) => {
      const seen = await originalGet(id);
      // Between our read and our conditional write, the original owner finishes.
      await store.complete(ID, 'req-1', later(130), {
        status: DeliveryStatus.SENT,
        sesMessageId: 'm-1',
      });
      return seen;
    };
    expect(await claimDelivery(store, { deliveryId: ID, owner: 'req-2', now: later(125) })).toEqual(
      {
        kind: 'contended',
      },
    );
    expect(store.items.get(ID)?.status).toBe(DeliveryStatus.SENT);
  });

  it.each([
    DeliveryStatus.SENT,
    DeliveryStatus.SKIPPED,
    DeliveryStatus.FAILED_PERMANENT,
    DeliveryStatus.AMBIGUOUS,
  ])('%s -> duplicate (dropped)', async (status) => {
    const store = new InMemoryDeliveriesStore();
    store.items.set(ID, { deliveryId: ID, status, attempts: 1, updatedAt: '', expiresAt: 0 });
    expect(await claimDelivery(store, { deliveryId: ID, owner: 'req-2', now: T0 })).toEqual({
      kind: 'duplicate',
      status,
    });
  });

  it('RELEASED can be claimed again and keeps the attempt count', async () => {
    const store = new InMemoryDeliveriesStore();
    await claimDelivery(store, { deliveryId: ID, owner: 'req-1', now: T0 });
    expect(
      await store.complete(ID, 'req-1', later(1), {
        status: DeliveryStatus.RELEASED,
        reason: 'Throttling',
      }),
    ).toBe(true);
    expect(store.items.get(ID)).toMatchObject({ status: DeliveryStatus.RELEASED, attempts: 1 });
    expect(store.items.get(ID)?.leaseOwner).toBeUndefined();

    const outcome = await claimDelivery(store, { deliveryId: ID, owner: 'req-2', now: later(10) });
    expect(outcome.kind).toBe('claimed');
    expect(store.items.get(ID)).toMatchObject({
      status: DeliveryStatus.CLAIMED,
      leaseOwner: 'req-2',
      attempts: 1,
    });
  });

  it('only the lease owner can complete', async () => {
    const store = new InMemoryDeliveriesStore();
    await claimDelivery(store, { deliveryId: ID, owner: 'req-1', now: T0 });
    expect(
      await store.complete(ID, 'req-2', later(1), {
        status: DeliveryStatus.SENT,
        sesMessageId: 'm',
      }),
    ).toBe(false);
    expect(
      await store.complete(ID, 'req-1', later(1), {
        status: DeliveryStatus.SENT,
        sesMessageId: 'm',
      }),
    ).toBe(true);
    expect(
      await store.complete(ID, 'req-1', later(2), {
        status: DeliveryStatus.SENT,
        sesMessageId: 'm',
      }),
    ).toBe(false);
    expect(store.items.get(ID)).toMatchObject({ status: DeliveryStatus.SENT, sesMessageId: 'm' });
  });

  it('skip writes SKIPPED only over absent or RELEASED', async () => {
    const store = new InMemoryDeliveriesStore();
    expect(await store.skip(ID, 'suppressed', T0, 0)).toBe(true);
    expect(store.items.get(ID)).toMatchObject({
      status: DeliveryStatus.SKIPPED,
      reason: 'suppressed',
    });

    const other = 'b'.repeat(64);
    await claimDelivery(store, { deliveryId: other, owner: 'req-1', now: T0 });
    await store.complete(other, 'req-1', T0, { status: DeliveryStatus.SENT, sesMessageId: 'm' });
    expect(await store.skip(other, 'disabled', T0, 0)).toBe(false);
    expect(store.items.get(other)?.status).toBe(DeliveryStatus.SENT);
  });

  it('a record that vanished between claim and read is contention, not a send', async () => {
    const store = new InMemoryDeliveriesStore();
    store.claim = () => Promise.resolve(false);
    expect(await claimDelivery(store, { deliveryId: ID, owner: 'req-1', now: T0 })).toEqual({
      kind: 'contended',
    });
  });

  it('store errors propagate (the caller turns them into a retry)', async () => {
    const store = new InMemoryDeliveriesStore();
    store.failNext.claim = new Error('ProvisionedThroughputExceededException');
    await expect(
      claimDelivery(store, { deliveryId: ID, owner: 'req-1', now: T0 }),
    ).rejects.toThrow();
  });
});
