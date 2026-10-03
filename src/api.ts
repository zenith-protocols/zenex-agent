/**
 * The Zenex public API: display prices, candles and indexed history. Open
 * endpoints, no key. Rate limited per IP (read routes: 100 requests/min),
 * so a bot polls prices, not history, in a loop.
 */

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

/** What the API knows about a market, from `GET /v1/config`. */
export interface ApiMarket {
    id: string;
    trading: string;
    vault: string;
    collateral: string;
    feedId: string;
    chartSymbol: string;
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

const configCache = new Map<string, Promise<ApiMarket[]>>();

/** The API's market list, fetched once per process per origin. */
export function fetchApiMarkets(api: string): Promise<ApiMarket[]> {
    let hit = configCache.get(api);
    if (!hit) {
        hit = getJson<{ markets: ApiMarket[] }>(`${api}/v1/config`).then((c) => c.markets);
        configCache.set(api, hit);
    }
    return hit;
}

/** The API's entry for a market contract, or undefined when the API does not list it. */
export async function apiMarketFor(api: string, marketContract: string): Promise<ApiMarket | undefined> {
    return (await fetchApiMarkets(api)).find((m) => m.trading === marketContract);
}

/** The live ticker for a feed (the market's on-chain anchor), matched by feed id. */
export async function fetchTicker(api: string, feedIdHex: string): Promise<Ticker> {
    const body = await getJson<{ data: Ticker[] }>(`${api}/v1/prices/tickers`);
    const hit = body.data.find((t) => t.feedID.toLowerCase() === feedIdHex.toLowerCase());
    if (!hit) throw new Error(`${api} serves no ticker for feed ${feedIdHex}`);
    return hit;
}

export async function fetchCandles(api: string, chartSymbol: string, resolution: string, from: number, to: number): Promise<Candle[]> {
    const res = RESOLUTIONS[resolution];
    if (res === undefined) {
        throw new Error(`unsupported resolution "${resolution}"; use one of ${Object.keys(RESOLUTIONS).join(', ')}`);
    }
    const q = new URLSearchParams({ symbol: chartSymbol, resolution: res, from: String(from), to: String(to) });
    const body = await getJson<{ s: string; t?: number[]; o?: number[]; h?: number[]; l?: number[]; c?: number[]; errmsg?: string }>(
        `${api}/v1/prices/udf/history?${q}`,
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

async function page<T>(url: string, params: Record<string, string | undefined>): Promise<Page<T>> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, v);
    const body = await getJson<{ data: Page<T> }>(`${url}?${q}`);
    return body.data;
}

export function fetchFills(api: string, account: string, marketId: string, limit: number, cursor?: string): Promise<Page<Fill>> {
    return page<Fill>(`${api}/v1/accounts/${account}/trade/fills`, { market: marketId, limit: String(limit), cursor });
}

export function fetchLifecycles(api: string, account: string, marketId: string, limit: number, cursor?: string): Promise<Page<Lifecycle>> {
    return page<Lifecycle>(`${api}/v1/accounts/${account}/trade/lifecycles`, { market: marketId, limit: String(limit), cursor });
}

export function fetchMarketTrades(api: string, marketId: string, limit: number, cursor?: string): Promise<Page<MarketTrade>> {
    return page<MarketTrade>(`${api}/v1/markets/${marketId}/trades`, { limit: String(limit), cursor });
}
