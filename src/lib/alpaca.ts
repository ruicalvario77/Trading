import { env, alpacaBaseUrl } from "./env";
import type { OHLCV } from "./indicators";

const DATA_URL = "https://data.alpaca.markets";

/** Full-market data. Volumes are real consolidated volumes, history goes back to 2016. */
export const DATA_FEED = "sip";

export function alpacaConfigured(): boolean {
  return !!env("APCA_API_KEY_ID") && !!env("APCA_API_SECRET_KEY");
}

function headers(): HeadersInit {
  const key = env("APCA_API_KEY_ID");
  const secret = env("APCA_API_SECRET_KEY");
  if (!key || !secret) throw new Error("Alpaca API keys are not set");
  return { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret, accept: "application/json" };
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: headers(), cache: "no-store" });
  if (!res.ok) throw new Error(`Alpaca ${res.status} ${res.statusText} for ${url.split("?")[0]}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

export type AlpacaAccount = {
  id: string; status: string; currency: string; equity: string; cash: string; buying_power: string;
  pattern_day_trader: boolean; trading_blocked: boolean; account_blocked: boolean;
};

export type AlpacaClock = { timestamp: string; is_open: boolean; next_open: string; next_close: string };

export function getAccount(): Promise<AlpacaAccount> {
  return get(`${alpacaBaseUrl()}/v2/account`);
}

export function getClock(): Promise<AlpacaClock> {
  return get(`${alpacaBaseUrl()}/v2/clock`);
}

type RawBar = { t: string; o: number; h: number; l: number; c: number; v: number };
type BarsResponse = { bars: Record<string, RawBar[]> | null; next_page_token: string | null };

/**
 * Daily bars for many symbols from `start` (ISO date), split-adjusted, full-market (SIP) data.
 * The free plan serves SIP history as long as the request ends at least 15 minutes ago, so `end` is
 * clamped to 20 minutes before now.
 * Returns a map of symbol to ascending bars. Follows pagination.
 */
export async function getDailyBars(symbolList: string[], start: string, end: string): Promise<Record<string, OHLCV[]>> {
  const out: Record<string, OHLCV[]> = {};
  const latest = new Date(Date.now() - 20 * 60_000).toISOString();
  const safeEnd = end.length <= 10 && `${end}T23:59:59Z` < latest ? `${end}T23:59:59Z` : latest;
  const chunk = 100;
  for (let i = 0; i < symbolList.length; i += chunk) {
    const syms = symbolList.slice(i, i + chunk).join(",");
    let token: string | null = null;
    do {
      const params = new URLSearchParams({
        symbols: syms, timeframe: "1Day", start, end: safeEnd, limit: "10000", adjustment: "split", feed: DATA_FEED, sort: "asc",
      });
      if (token) params.set("page_token", token);
      const page: BarsResponse = await get(`${DATA_URL}/v2/stocks/bars?${params.toString()}`);
      for (const [sym, raw] of Object.entries(page.bars ?? {})) {
        const list = (out[sym] ??= []);
        for (const b of raw) list.push({ date: b.t.slice(0, 10), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v });
      }
      token = page.next_page_token;
    } while (token);
  }
  return out;
}

// Order endpoints, used from milestone 3 onward.
export type BracketOrderRequest = {
  symbol: string; qty: number; entryStop: number; entryLimit: number; takeProfit: number | null; stopLoss: number; clientOrderId: string;
  /** "stop": buy on a rise through entryStop (good till cancelled). "open": buy at the next open (day order). */
  entryType?: "stop" | "open";
};

export async function submitBracketOrder(o: BracketOrderRequest): Promise<{ id: string; status: string }> {
  const res = await fetch(`${alpacaBaseUrl()}/v2/orders`, {
    method: "POST",
    headers: { ...headers(), "content-type": "application/json" },
    body: JSON.stringify({
      symbol: o.symbol, qty: String(o.qty), side: "buy",
      ...(o.entryType === "open"
        ? { type: "market", time_in_force: "day" }
        : { type: "stop_limit", time_in_force: "gtc", stop_price: o.entryStop.toFixed(2), limit_price: o.entryLimit.toFixed(2) }),
      // With no target, the order only attaches a stop loss (one-triggers-other).
      ...(o.takeProfit !== null
        ? { order_class: "bracket", take_profit: { limit_price: o.takeProfit.toFixed(2) } }
        : { order_class: "oto" }),
      stop_loss: { stop_price: o.stopLoss.toFixed(2) },
      client_order_id: o.clientOrderId,
    }),
  });
  if (!res.ok) throw new Error(`Alpaca order rejected ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as { id: string; status: string };
}

export async function getOrder(id: string): Promise<import("./trades").BrokerOrder> {
  return get(`${alpacaBaseUrl()}/v2/orders/${encodeURIComponent(id)}?nested=true`);
}

export async function cancelOrder(id: string): Promise<void> {
  const res = await fetch(`${alpacaBaseUrl()}/v2/orders/${encodeURIComponent(id)}`, { method: "DELETE", headers: headers() });
  // 422 means the order is already filled or cancelled, which is fine here.
  if (!res.ok && res.status !== 404 && res.status !== 422) throw new Error(`Alpaca cancel ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

/** Market order for the next session's open when sent after the close. */
export async function submitMarketOrder(symbol: string, qty: number, side: "buy" | "sell", clientOrderId: string): Promise<{ id: string; status: string }> {
  const res = await fetch(`${alpacaBaseUrl()}/v2/orders`, {
    method: "POST",
    headers: { ...headers(), "content-type": "application/json" },
    body: JSON.stringify({ symbol, qty: String(qty), side, type: "market", time_in_force: "day", client_order_id: clientOrderId }),
  });
  if (!res.ok) throw new Error(`Alpaca ${side} rejected ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as { id: string; status: string };
}

export function submitMarketSell(symbol: string, qty: number, clientOrderId: string) {
  return submitMarketOrder(symbol, qty, "sell", clientOrderId);
}

export type AlpacaAsset = { symbol: string; name: string; exchange: string; tradable: boolean; status: string; fractionable?: boolean };

/** Every active US equity Alpaca lists (stocks and ETFs). */
export async function getAssets(): Promise<AlpacaAsset[]> {
  return get(`${alpacaBaseUrl()}/v2/assets?status=active&asset_class=us_equity`);
}
