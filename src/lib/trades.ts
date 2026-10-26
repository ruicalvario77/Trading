import { round2 } from "./indicators";
import type { Trade } from "./db/schema";

/** Buy-stop entry with a limit a little above it, so a gap far past the trigger does not fill. */
export function entryLimitFor(entry: number): number {
  return round2(entry + Math.max(0.05, entry * 0.003));
}

/** Untriggered entries are cancelled after this many calendar days (about 2 trading days). */
export const ENTRY_EXPIRY_DAYS = 3;

export type BrokerLeg = { id: string; type: string; status: string; filled_avg_price: string | null; filled_at: string | null };
export type BrokerOrder = BrokerLeg & { legs?: BrokerLeg[] | null };

export type TradeUpdate = Partial<
  Pick<Trade, "status" | "entryFill" | "enteredAt" | "exitFill" | "exitedAt" | "exitReason" | "pnlUsd" | "rMultiple">
>;

const DEAD = new Set(["canceled", "expired", "rejected", "done_for_day", "suspended"]);

/**
 * Compares one stored trade with its bracket order at the broker and returns the fields that changed,
 * or null when nothing did. Handles an entry and an exit both happening between two syncs.
 */
export function reconcileTrade(trade: Trade, order: BrokerOrder): TradeUpdate | null {
  const update: TradeUpdate = {};
  let status = trade.status;
  let entryFill = trade.entryFill;

  if (status === "pending_entry") {
    if (order.status === "filled" && order.filled_avg_price) {
      entryFill = Number(order.filled_avg_price);
      status = "open";
      Object.assign(update, { status, entryFill, enteredAt: order.filled_at ? new Date(order.filled_at) : new Date() });
    } else if (DEAD.has(order.status)) {
      return { status: "cancelled" };
    } else {
      return null;
    }
  }

  if (status === "open" && entryFill !== null) {
    const exitLeg = (order.legs ?? []).find((l) => l.status === "filled" && l.filled_avg_price);
    if (exitLeg) {
      const exitFill = Number(exitLeg.filled_avg_price);
      const initialRisk = entryFill - trade.plannedStop;
      const reason = exitLeg.type === "limit" ? "target" : trade.breakevenMoved ? "trail" : "stop";
      Object.assign(update, {
        status: "closed",
        exitFill,
        exitedAt: exitLeg.filled_at ? new Date(exitLeg.filled_at) : new Date(),
        exitReason: reason,
        pnlUsd: round2((exitFill - entryFill) * trade.shares),
        rMultiple: initialRisk > 0 ? Math.round(((exitFill - entryFill) / initialRisk) * 100) / 100 : null,
      });
    }
  }

  return Object.keys(update).length ? update : null;
}

/** Monday 00:00 UTC of the week containing `now`. */
export function weekStartUtc(now: Date): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return d;
}

export type LimitInputs = {
  committed: number; // approved candidates + pending entries + open positions
  maxPositions: number;
  weekPnlUsd: number;
  accountUsd: number;
  weeklyLossLimitPct: number;
};

/** Returns why a new trade is not allowed, or null when it is. */
export function limitBlock(x: LimitInputs): string | null {
  if (x.committed >= x.maxPositions) return `already at the ${x.maxPositions}-position limit`;
  const limitUsd = (x.accountUsd * x.weeklyLossLimitPct) / 100;
  if (x.weekPnlUsd <= -limitUsd) return `weekly loss limit reached ($${(-x.weekPnlUsd).toFixed(2)} of $${limitUsd.toFixed(2)})`;
  return null;
}
