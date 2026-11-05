/**
 * A settlement travels as a custom `piher.settlement` message: the transcript draws a card
 * (name, role, outcome, elapsed) while the text the model reads stays exactly the settlement
 * notice. A host without custom-message support gets the same text as a plain user message, so
 * delivery never depends on the rendering.
 */

export const SETTLEMENT_CUSTOM_TYPE = 'piher.settlement';

/** Why the worker left: normal settlement, a dead pane / settle timeout, or a reclaimed row. */
export type SettlementOutcome = 'settled' | 'failed' | 'closed';

/** Card fields only — the notice text itself is the message content. */
export interface SettlementCard {
  name: string;
  /** Role name from the ledger row's `kind`; `null` for a plain task. */
  role: string | null;
  outcome: SettlementOutcome;
  /** Worker lifetime, spawn → settlement; `null` when the row is gone. */
  elapsedMs: number | null;
}

/** `12s` / `3m04s` / `2h11m`: short enough for a card header, unambiguous at a glance. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

/** `kind` is the ledger row's role label; `'task'` (the default) means the worker ran no role. */
export function settlementRole(kind: string | null | undefined): string | null {
  return typeof kind === 'string' && kind !== '' && kind !== 'task' ? kind : null;
}

export function settlementCard(input: {
  name: string;
  kind?: string | null;
  outcome: SettlementOutcome;
  startedAt?: number | null;
  now?: number;
}): SettlementCard {
  const now = input.now ?? Date.now();
  const startedAt = typeof input.startedAt === 'number' && Number.isFinite(input.startedAt)
    ? input.startedAt
    : null;
  return {
    name: input.name,
    role: settlementRole(input.kind),
    outcome: input.outcome,
    elapsedMs: startedAt === null ? null : Math.max(0, now - startedAt),
  };
}

export interface SettlementMessageApi {
  sendMessage?(
    message: { customType: string; content: string; display: boolean; details?: unknown },
    opts?: { deliverAs?: string; triggerTurn?: boolean },
  ): void;
  sendUserMessage?(content: string, opts?: { deliverAs?: string; triggerTurn?: boolean }): void;
}

/**
 * Deliver one settlement notice. Custom message first (card rendered, content untouched), then the
 * plain notice when the host has no custom messages or the renderer could not be registered; a
 * synchronous throw from either path propagates so the caller can retry instead of losing the
 * settlement.
 */
export async function sendSettlementNotice(
  api: SettlementMessageApi,
  input: {
    content: string;
    mode: 'steer' | 'followUp';
    /** Absent for a collapsed batch: the card describes one settlement, the batch text covers many. */
    card?: SettlementCard | null;
    /** False when no `registerMessageRenderer` exists, so a card would render as raw JSON. */
    cardsRendered: boolean;
  },
): Promise<void> {
  const opts = { deliverAs: input.mode, triggerTurn: true };
  if (input.cardsRendered && typeof api.sendMessage === 'function') {
    try {
      api.sendMessage({
        customType: SETTLEMENT_CUSTOM_TYPE,
        content: input.content,
        display: true,
        ...(input.card ? { details: input.card } : {}),
      }, opts);
      return;
    } catch {
      /* Older host or a rejected custom message: the plain notice below is the delivery. */
    }
  }
  api.sendUserMessage?.(input.content, opts);
}
