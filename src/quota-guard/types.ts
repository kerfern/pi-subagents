export type GuardedProvider = 'openai-codex' | 'commandcode';

export interface Policy {
  warn: number;
  pause: number;
  resume: number;
}

export interface QuotaWindow {
  id: string;
  used: number;
  cap: number;
  resetAt: string;
}

export type QuotaScope = 'account' | 'provider';

export interface QuotaSnapshot {
  providerId: GuardedProvider;
  scope: QuotaScope;
  accountId?: string;
  workspaceId?: string;
  checkedAt: string;
  windows: readonly QuotaWindow[];
}

export interface Assessment {
  state: 'open' | 'warn' | 'pause' | 'wait';
  reason:
    | 'healthy'
    | 'threshold'
    | 'reserve'
    | 'unknown-reserve'
    | 'reset-settling'
    | 'unavailable';
  limitingWindow?: string;
  nextCheckAt?: string;
}

export type GuardMode = 'running' | 'paused';
