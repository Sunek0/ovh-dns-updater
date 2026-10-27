import { describe, expect, it, vi } from 'vitest';
import type { SubdomainSyncResult } from '../src/types.js';
import { StateStore } from '../src/services/StateStore.js';

const T0 = new Date('2026-01-01T00:00:00.000Z');

function subdomainResult(
  overrides: Partial<SubdomainSyncResult> & Pick<SubdomainSyncResult, 'status'>,
): SubdomainSyncResult {
  return {
    domain: 'example.com',
    subdomain: '',
    ...overrides,
  };
}

function recordResult(
  store: StateStore,
  params: {
    accountId?: string;
    domain?: string;
    subdomain?: string;
    targetIp: string;
    status: SubdomainSyncResult['status'];
    previousTarget?: string;
    error?: string;
    trigger?: 'startup' | 'scheduler' | 'ondemand';
    at?: Date;
  },
) {
  const accountId = params.accountId ?? 'acc1';
  const domain = params.domain ?? 'example.com';
  const subdomain = params.subdomain ?? '';
  const records = params.previousTarget === undefined
    ? []
    : [{
        recordId: 1,
        previousTarget: params.previousTarget,
        status: params.status === 'failed' ? 'failed' as const : 'updated' as const,
      }];

  store.recordRecordResult({
    accountId,
    domain,
    subdomain,
    targetIp: params.targetIp,
    trigger: params.trigger ?? 'scheduler',
    at: params.at,
    result: subdomainResult({
      domain,
      subdomain,
      status: params.status,
      error: params.error,
      records: records.length > 0 ? records : undefined,
    }),
  });
}

describe('StateStore', () => {
  it('initializes configured records as pending with resolved FQDNs', () => {
    const store = new StateStore({
      startedAt: T0,
      now: () => new Date(T0.getTime() + 65_000),
      historySize: 42,
      refreshSeconds: 7,
      schedulerEnabled: true,
      schedulerIntervalSeconds: 600,
      ondemandEnabled: true,
      accounts: [{
        id: 'personal',
        domains: [{
          name: 'example.com',
          subdomains: ['@', '*', 'www', { api: 'metadata' }],
        }],
      }],
    });

    const snapshot = store.getSnapshot();

    expect(snapshot.startedAt).toBe(T0.toISOString());
    expect(snapshot.uptimeSeconds).toBe(65);
    expect(snapshot.nextCheckAt).toBe('2026-01-01T00:10:00.000Z');
    expect(snapshot.scheduler).toEqual({ enabled: true, intervalSeconds: 600 });
    expect(snapshot.ondemand).toEqual({ enabled: true });
    expect(snapshot.ui).toEqual({ refreshSeconds: 7, historySize: 42 });
    expect(snapshot.accounts).toHaveLength(1);
    expect(snapshot.accounts[0].domains[0].records).toEqual([
      expect.objectContaining({
        fqdn: 'example.com',
        type: 'A',
        subdomain: '',
        status: 'pending',
        initialValue: null,
        currentValue: null,
      }),
      expect.objectContaining({ fqdn: '*.example.com', subdomain: '*', status: 'pending' }),
      expect.objectContaining({ fqdn: 'www.example.com', subdomain: 'www', status: 'pending' }),
      expect.objectContaining({ fqdn: 'api.example.com', subdomain: 'api', status: 'pending' }),
    ]);
  });

  it('keeps the initial IP, tracks changes and only advances the scheduler on scheduled checks', () => {
    let now = new Date(T0.getTime());
    const store = new StateStore({
      now: () => now,
      schedulerEnabled: true,
      schedulerIntervalSeconds: 600,
    });

    store.recordIpCheck({ trigger: 'startup', ip: '1.1.1.1' });
    let snapshot = store.getSnapshot();

    expect(snapshot.initialIp).toBe('1.1.1.1');
    expect(snapshot.currentIp).toBe('1.1.1.1');
    expect(snapshot.lastCheckResult).toEqual({
      status: 'ok',
      ip: '1.1.1.1',
      error: null,
    });
    expect(snapshot.nextCheckAt).toBe('2026-01-01T00:10:00.000Z');
    expect(snapshot.counters.checks).toBe(1);

    now = new Date(T0.getTime() + 5 * 60_000);
    store.recordIpCheck({ trigger: 'ondemand', ip: '2.2.2.2' });
    snapshot = store.getSnapshot();

    expect(snapshot.initialIp).toBe('1.1.1.1');
    expect(snapshot.currentIp).toBe('2.2.2.2');
    expect(snapshot.nextCheckAt).toBe('2026-01-01T00:10:00.000Z');
    expect(snapshot.counters.checks).toBe(2);
    expect(store.getEvents({ type: 'public_ip_changed' }).events).toEqual([
      expect.objectContaining({
        trigger: 'ondemand',
        oldValue: '1.1.1.1',
        newValue: '2.2.2.2',
        accountId: null,
      }),
    ]);
  });

  it('records an IP check failure without losing the current IP', () => {
    const store = new StateStore({ now: () => T0 });
    store.recordIpCheck({ trigger: 'startup', ip: '1.1.1.1' });
    store.recordIpCheck({ trigger: 'scheduler', error: 'providers down' });

    const snapshot = store.getSnapshot();
    expect(snapshot.currentIp).toBe('1.1.1.1');
    expect(snapshot.lastCheckResult).toEqual({
      status: 'error',
      ip: null,
      error: 'providers down',
    });
    expect(snapshot.counters.errors).toBe(1);
    expect(store.getEvents({ type: 'error' }).events[0]).toEqual(
      expect.objectContaining({ message: 'providers down', accountId: null }),
    );
  });

  it('transitions pending -> ok while retaining the initial value', () => {
    const store = new StateStore({
      now: () => T0,
      accounts: [{ id: 'acc1', domains: [{ name: 'example.com', subdomains: ['@'] }] }],
    });

    recordResult(store, {
      targetIp: '1.1.1.1',
      previousTarget: '1.1.1.1',
      status: 'unchanged',
    });

    const record = store.getSnapshot().accounts[0].domains[0].records[0];
    expect(record).toMatchObject({
      fqdn: 'example.com',
      status: 'ok',
      initialValue: '1.1.1.1',
      currentValue: '1.1.1.1',
      lastCheckedAt: T0.toISOString(),
      lastChangedAt: null,
      lastError: null,
    });
    expect(store.getSnapshot().counters).toEqual({ checks: 0, updates: 0, errors: 0 });
    expect(store.getEvents().events[0].action).toBe('unchanged');
  });

  it('transitions pending -> updated and keeps the first observed value as initial', () => {
    let now = new Date(T0.getTime());
    const store = new StateStore({
      now: () => now,
      accounts: [{ id: 'acc1', domains: [{ name: 'example.com', subdomains: ['www'] }] }],
    });

    recordResult(store, {
      subdomain: 'www',
      targetIp: '2.2.2.2',
      previousTarget: '1.1.1.1',
      status: 'updated',
    });

    now = new Date(T0.getTime() + 60_000);
    recordResult(store, {
      subdomain: 'www',
      targetIp: '2.2.2.2',
      previousTarget: '2.2.2.2',
      status: 'unchanged',
    });

    const record = store.getSnapshot().accounts[0].domains[0].records[0];
    expect(record).toMatchObject({
      status: 'ok',
      initialValue: '1.1.1.1',
      currentValue: '2.2.2.2',
      lastChangedAt: T0.toISOString(),
      lastCheckedAt: new Date(T0.getTime() + 60_000).toISOString(),
      lastError: null,
    });
    expect(store.getSnapshot().counters.updates).toBe(1);
    expect(store.getEvents({ type: 'updated' }).events[0]).toEqual(
      expect.objectContaining({ oldValue: '1.1.1.1', newValue: '2.2.2.2' }),
    );
  });

  it('transitions pending -> error and clears the error after recovery', () => {
    const store = new StateStore({
      now: () => T0,
      accounts: [{ id: 'acc1', domains: [{ name: 'example.com', subdomains: ['www'] }] }],
    });

    recordResult(store, {
      subdomain: 'www',
      targetIp: '2.2.2.2',
      previousTarget: '1.1.1.1',
      status: 'failed',
      error: 'OVH rejected the update',
    });

    let record = store.getSnapshot().accounts[0].domains[0].records[0];
    expect(record).toMatchObject({
      status: 'error',
      initialValue: '1.1.1.1',
      currentValue: '1.1.1.1',
      lastError: 'OVH rejected the update',
    });
    expect(store.getSnapshot().counters.errors).toBe(1);

    recordResult(store, {
      subdomain: 'www',
      targetIp: '2.2.2.2',
      previousTarget: '2.2.2.2',
      status: 'unchanged',
    });

    record = store.getSnapshot().accounts[0].domains[0].records[0];
    expect(record).toMatchObject({
      status: 'ok',
      currentValue: '2.2.2.2',
      lastError: null,
    });
    expect(store.getEvents({ type: 'error' }).events[0]).toEqual(
      expect.objectContaining({
        fqdn: 'www.example.com',
        message: 'OVH rejected the update',
      }),
    );
  });

  it('uses a circular buffer for events', () => {
    const store = new StateStore({
      now: () => T0,
      historySize: 2,
      accounts: [{ id: 'acc1', domains: [{ name: 'example.com', subdomains: ['@'] }] }],
    });

    recordResult(store, {
      targetIp: '1.1.1.1',
      previousTarget: '0.0.0.1',
      status: 'updated',
      trigger: 'startup',
    });
    recordResult(store, {
      targetIp: '1.1.1.1',
      previousTarget: '1.1.1.1',
      status: 'unchanged',
      trigger: 'scheduler',
    });
    recordResult(store, {
      targetIp: '2.2.2.2',
      previousTarget: '1.1.1.1',
      status: 'failed',
      error: 'boom',
      trigger: 'ondemand',
    });

    const result = store.getEvents({ limit: 10 });
    expect(result.total).toBe(2);
    expect(result.events).toHaveLength(2);

    const ids = result.events.map(event => event.id);
    expect(ids).toEqual([3, 2]);
    expect(result.events[0]).toEqual(expect.objectContaining({
      action: 'error',
      trigger: 'ondemand',
      message: 'boom',
    }));
  });

  it('filters events by account, domain, type and limit', () => {
    let now = new Date(T0.getTime());
    const store = new StateStore({
      now: () => now,
      historySize: 20,
      accounts: [
        { id: 'acc1', domains: [{ name: 'example.com', subdomains: ['@', 'www'] }] },
        { id: 'acc2', domains: [{ name: 'other.com', subdomains: ['@'] }] },
      ],
    });

    recordResult(store, {
      accountId: 'acc1',
      targetIp: '1.1.1.1',
      previousTarget: '0.0.0.1',
      status: 'updated',
    });
    now = new Date(T0.getTime() + 1_000);
    recordResult(store, {
      accountId: 'acc1',
      subdomain: 'www',
      targetIp: '1.1.1.1',
      previousTarget: '1.1.1.1',
      status: 'unchanged',
    });
    now = new Date(T0.getTime() + 2_000);
    recordResult(store, {
      accountId: 'acc2',
      domain: 'other.com',
      targetIp: '1.1.1.1',
      previousTarget: '8.8.8.8',
      status: 'failed',
      error: 'nope',
    });

    expect(store.getEvents({ account: 'acc1' }).total).toBe(2);
    expect(store.getEvents({ domain: 'other.com' }).total).toBe(1);
    expect(store.getEvents({ type: 'updated' }).total).toBe(1);

    const limited = store.getEvents({
      account: 'acc1',
      domain: 'example.com',
      limit: 1,
    });
    expect(limited.total).toBe(2);
    expect(limited.events).toHaveLength(1);
    expect(limited.events[0].action).toBe('unchanged');
  });

  it('exposes the last IP detection provider and failures', () => {
    const store = new StateStore({ now: () => T0 });

    store.recordIpDetection({
      ip: '1.1.1.1',
      provider: 'https://ip.working',
      failures: [{ provider: 'https://ip.failing', error: 'timeout' }],
      detectedAt: T0,
    });

    expect(store.getSnapshot().ipProvider).toEqual({
      provider: 'https://ip.working',
      lastDetectionAt: T0.toISOString(),
      failures: [{ provider: 'https://ip.failing', error: 'timeout' }],
    });
  });

  it('marks every configured record of an account as failed on an account error', () => {
    const store = new StateStore({
      now: () => T0,
      accounts: [{
        id: 'acc1',
        domains: [{
          name: 'example.com',
          subdomains: ['@', 'www'],
        }],
      }],
    });

    store.recordAccountError({
      trigger: 'scheduler',
      accountId: 'acc1',
      error: 'OVH unavailable',
    });

    const snapshot = store.getSnapshot();
    expect(snapshot.counters.errors).toBe(1);
    for (const record of snapshot.accounts[0].domains[0].records) {
      expect(record.status).toBe('error');
      expect(record.lastError).toBe('OVH unavailable');
      expect(record.lastCheckedAt).toBe(T0.toISOString());
    }
    expect(store.getEvents().events[0]).toEqual(expect.objectContaining({
      accountId: 'acc1',
      action: 'error',
      domain: null,
      message: 'OVH unavailable',
    }));
  });

  it('records the final synchronization outcome', () => {
    const store = new StateStore({ now: () => T0 });
    store.recordIpCheck({ trigger: 'startup', ip: '1.1.1.1' });
    store.recordSyncOutcome({ status: 'partial', error: 'one account failed' });

    expect(store.getSnapshot().lastCheckResult).toEqual({
      status: 'partial',
      ip: '1.1.1.1',
      error: 'one account failed',
    });
  });

  it('records zone refresh failures as domain-scoped error events', () => {
    const store = new StateStore({
      now: () => T0,
      accounts: [{ id: 'acc1', domains: [{ name: 'example.com', subdomains: ['@'] }] }],
    });

    store.recordDomainError({
      trigger: 'scheduler',
      accountId: 'acc1',
      domain: 'example.com',
      error: 'Zone refresh failed',
    });

    expect(store.getSnapshot().counters.errors).toBe(1);
    expect(store.getEvents({ domain: 'example.com' }).events[0]).toEqual(
      expect.objectContaining({
        action: 'error',
        accountId: 'acc1',
        domain: 'example.com',
        subdomain: null,
        fqdn: null,
        message: 'Zone refresh failed',
      }),
    );
  });

  it('notifies subscribers, isolates listener failures and supports unsubscribe', () => {
    const store = new StateStore({
      now: () => T0,
      accounts: [{ id: 'acc1', domains: [{ name: 'example.com', subdomains: ['@'] }] }],
    });
    const throwingListener = vi.fn(() => {
      throw new Error('listener exploded');
    });
    const listener = vi.fn();

    store.subscribe(throwingListener);
    const unsubscribe = store.subscribe(listener);

    store.recordIpCheck({ trigger: 'startup', ip: '1.1.1.1' });
    expect(listener).toHaveBeenLastCalledWith(undefined);
    expect(listener).toHaveBeenCalledTimes(1);

    recordResult(store, {
      targetIp: '1.1.1.1',
      previousTarget: '0.0.0.1',
      status: 'updated',
    });
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: 1,
        action: 'updated',
        fqdn: 'example.com',
      }),
    );
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().currentIp).toBe('1.1.1.1');

    unsubscribe();
    store.recordSyncOutcome({ status: 'ok' });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
