/**
 * The Zenex public API: display prices, candles and indexed history. Open
 * endpoints, no key. Rate limited per IP (read routes: 100 requests/min),
 * so a bot polls prices, not history, in a loop.
 */
import type { MarketPin, NetworkPin } from './networks.js';

export interface Ticker {
    marketId: string;
    feedID: string;
    /** 18-decimal strings, straight from the Chainlink Data Streams report. */
    price: string;
    bid: string;
    ask: string;
    observationsTimestamp: number;
    validFromTimestamp: number;
}

export interface Candle {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
}

/** Candle resolutions the API serves, with the human aliases this CLI accepts. */
export const RESOLUTIONS: Record<string, string> = {
    '1m': '1', '5m': '5', '15m': '15', '1h': '60', '4h': '240', '1d': '1D',
    '1': '1', '5': '5', '15': '15', '60': '60', '240': '240', '1D': '1D', 'D': '1D',
};

async function getJson<T>(url: string): Promise<T> {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        throw new Error(`${res.status} from ${url}: ${body}`);
    }
    return (await res.json()) as T;
}

export async function fetchTicker(pin: NetworkPin, market: MarketPin): Promise<Ticker> {
    const body = await getJson<{ data: Ticker[] }>(`${pin.api}/v1/prices/tickers`);
    const hit = body.data.find((t) => t.marketId === market.id || t.feedID === market.feedId);
    if (!hit) throw new Error(`no ticker for ${market.id} on ${pin.key}`);
    return hit;
}

export async function fetchCandles(
    pin: NetworkPin,
    market: MarketPin,
    resolution: string,
    from: number,
    to: number,
): Promise<Candle[]> {
    const res = RESOLUTIONS[resolution];
    if (res === undefined) {
        throw new Error(`unsupported resolution "${resolution}"; use one of ${Object.keys(RESOLUTIONS).join(', ')}`);
    }
    const q = new URLSearchParams({ symbol: market.chartSymbol, resolution: res, from: String(from), to: String(to) });
    const body = await getJson<{ s: string; t?: number[]; o?: number[]; h?: number[]; l?: number[]; c?: number[]; errmsg?: string }>(
        `${pin.api}/v1/prices/udf/history?${q}`,
    );
    if (body.s === 'no_data') return [];
    if (body.s !== 'ok') throw new Error(`candles: ${body.errmsg ?? body.s}`);
    const t = body.t ?? [];
    return t.map((time, i) => ({
        time,
        open: body.o?.[i] ?? NaN,
        high: body.h?.[i] ?? NaN,
        low: body.l?.[i] ?? NaN,
        close: body.c?.[i] ?? NaN,
    }));
}

export interface Page<T> {
    items: T[];
    nextCursor: string | null;
}

/** One indexed fill of a trade order (open, increase, decrease, close, liquidation, ADL). */
export interface Fill {
    id: string;
    marketId: string;
    user: string;
    side: 'long' | 'short';
    kind: string;
    orderId: string;
    lifecycleId: string;
    priceAtomic: string;
    notionalAtomic: string;
    tokensAtomic: string;
    marginAtomic: string;
    fees: { baseAtomic: string; impactAtomic: string; fundingAtomic: string; borrowingAtomic: string; liqFeeAtomic: string };
    pnlAtomic: string;
    returnedMarginAtomic: string | null;
    keeper: string;
    occurredAt: string;
    transactionHash: string;
}

/** One indexed position lifecycle: from first open to final close. */
export interface Lifecycle {
    lifecycleId: string;
    marketId: string;
    side: 'long' | 'short';
    openedAt: string;
    finalizedAt: string | null;
    finalizationReason: string | null;
    entryPrice: string;
    exitPrice: string | null;
    size: string;
    leverage: string;
    grossPnlAtomic: string;
    netPnlAtomic: string;
    fees: { baseAtomic: string; impactAtomic: string; fundingAtomic: string; borrowingAtomic: string; liqFeeAtomic: string };
    marginPostedAtomic: string;
    activityCount: number;
}

export interface IndexedOrder {
    [key: string]: unknown;
}

async function page<T>(url: string, params: Record<string, string | undefined>): Promise<Page<T>> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, v);
    const body = await getJson<{ data: Page<T> }>(`${url}?${q}`);
    return body.data;
}

export function fetchFills(pin: NetworkPin, account: string, market: MarketPin, limit: number, cursor?: string): Promise<Page<Fill>> {
    return page<Fill>(`${pin.api}/v1/accounts/${account}/trade/fills`, { market: market.id, limit: String(limit), cursor });
}

export function fetchLifecycles(pin: NetworkPin, account: string, market: MarketPin, limit: number, cursor?: string): Promise<Page<Lifecycle>> {
    return page<Lifecycle>(`${pin.api}/v1/accounts/${account}/trade/lifecycles`, { market: market.id, limit: String(limit), cursor });
}

export function fetchIndexedOrders(pin: NetworkPin, account: string, market: MarketPin, limit: number, cursor?: string): Promise<Page<IndexedOrder>> {
    return page<IndexedOrder>(`${pin.api}/v1/accounts/${account}/trade/orders`, { market: market.id, limit: String(limit), cursor });
}

/** One anonymized fill from the market-wide tape. */
export interface MarketTrade {
    id: string;
    side: 'long' | 'short';
    kind: string;
    priceAtomic: string;
    notionalAtomic: string;
    tokensAtomic: string;
    occurredAt: string;
    transactionHash: string;
}

export function fetchMarketTrades(pin: NetworkPin, market: MarketPin, limit: number, cursor?: string): Promise<Page<MarketTrade>> {
    return page<MarketTrade>(`${pin.api}/v1/markets/${market.id}/trades`, { limit: String(limit), cursor });
}
