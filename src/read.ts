/**
 * Read commands. Everything prints in human units with the raw atomic value
 * available through `--json`, so an agent never has to divide by 1e7 or
 * 1e18 itself.
 */
import { Asset } from '@stellar/stellar-sdk';
import {
    OrderKind,
    Status,
    VaultOrderKind,
    estimateMarket,
    estimatePosition,
    formatToken,
    loadTokenBalance,
    type MarketPosition,
    type PendingOrder,
} from '@zenith-protocols/zenex-sdk';
import { fetchCandles, fetchFills, fetchLifecycles, fetchMarketTrades } from './api.js';
import { loadSnapshot, openSession, requireAccount, type SessionOptions } from './context.js';
import { isMissingTrustline } from './token.js';
import { PRICE_DECIMALS, fmtAmount, fmtNum, fmtPct, fmtPrice, shortAddr, toJson } from './units.js';

export interface OutputOptions {
    json?: boolean;
}

export const ORDER_KIND_NAMES: Record<OrderKind, string> = {
    [OrderKind.MarketIncrease]: 'market open/increase',
    [OrderKind.LimitIncrease]: 'limit open/increase',
    [OrderKind.StopIncrease]: 'stop open/increase',
    [OrderKind.MarketDecrease]: 'market close/decrease',
    [OrderKind.LimitDecrease]: 'take-profit (limit decrease)',
    [OrderKind.StopDecrease]: 'stop-loss (stop decrease)',
};

const STATUS_NAMES: Record<number, string> = {
    [Status.Active]: 'active',
    [Status.OnIce]: 'on-ice (opens blocked)',
    [Status.Frozen]: 'frozen (all halted)',
    [Status.Delisted]: 'delisted (wind-down)',
    4: 'retired',
};

/** Aligned `key  value` block. */
export function kv(rows: [string, string][]): string {
    const width = Math.max(...rows.map(([k]) => k.length));
    return rows.map(([k, v]) => `${k.padEnd(width)}  ${v}`).join('\n');
}

export function table(headers: string[], rows: string[][]): string {
    const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
    const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ');
    return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

function emit(opts: OutputOptions, text: string, json: unknown): void {
    process.stdout.write((opts.json ? toJson(json) : text) + '\n');
}

export async function cmdMarkets(opts: SessionOptions & OutputOptions): Promise<void> {
    const s = await openSession({ ...opts, anonymous: true });
    const rows = s.pin.markets.map((m) => [m.id, m.symbol, m.market, m.collateral]);
    emit(
        opts,
        `network ${s.pin.key} (${s.net.rpc})\n` + table(['id', 'pair', 'market contract', 'collateral'], rows),
        { network: s.pin.key, rpc: s.net.rpc, api: s.pin.api, markets: s.pin.markets },
    );
}

export async function cmdPrice(opts: SessionOptions & OutputOptions): Promise<void> {
    const s = await openSession({ ...opts, anonymous: true });
    const { fetchTicker } = await import('./api.js');
    const t = await fetchTicker(s.pin, s.market);
    const bid = BigInt(t.bid);
    const ask = BigInt(t.ask);
    const age = Math.max(0, Math.floor(Date.now() / 1000) - t.observationsTimestamp);
    emit(
        opts,
        kv([
            ['market', `${s.market.symbol} (${s.pin.key})`],
            ['bid', fmtPrice(bid)],
            ['ask', fmtPrice(ask)],
            ['mid', fmtPrice(BigInt(t.price))],
            ['spread', fmtPct((Number(ask - bid) / Number(ask)) * 100, 3)],
            ['observed', `${new Date(t.observationsTimestamp * 1000).toISOString()} (${age}s ago)`],
        ]),
        {
            market: s.market.id,
            network: s.pin.key,
            bid: t.bid,
            ask: t.ask,
            mid: t.price,
            priceDecimals: PRICE_DECIMALS,
            decimal: { bid: formatToken(bid, PRICE_DECIMALS), ask: formatToken(ask, PRICE_DECIMALS), mid: formatToken(BigInt(t.price), PRICE_DECIMALS) },
            observedAt: t.observationsTimestamp,
        },
    );
}

export async function cmdMarket(opts: SessionOptions & OutputOptions): Promise<void> {
    const s = await openSession({ ...opts, anonymous: true });
    const snap = await loadSnapshot(s, { withUser: false });
    const m = snap.market.accrue(snap.price);
    const est = estimateMarket(m, snap.price);
    const d = m.assetDecimals;
    const q = s.market.quote;
    const side = (name: string, e: typeof est.long) =>
        [
            [`${name} open interest`, `${fmtNum(e.openInterestValue)} ${q} (${fmtNum(e.openInterestTokens, 4)} ${s.market.base})`],
            [`${name} capacity left`, `${fmtNum(e.openCapacity)} ${q}`],
            [`${name} utilization`, fmtPct(e.utilizationPercent)],
            [`${name} funding /h`, `${fmtPct(e.fundingRatePercent1h, 4)}${e.charged ? ' (pays)' : ' (receives)'}`],
            [`${name} borrow /h`, fmtPct(e.borrowRatePercent1h, 4)],
            [`${name} net rate /h`, fmtPct(e.netRatePercent1h, 4)],
        ] as [string, string][];
    emit(
        opts,
        kv([
            ['market', `${s.market.symbol} (${s.pin.key}) ${s.market.market}`],
            ['status', STATUS_NAMES[m.status] ?? String(m.status)],
            ['price', `bid ${fmtPrice(snap.price.bid)} / ask ${fmtPrice(snap.price.ask)}`],
            ['max leverage', `${fmtNum(est.maxLeverage, 1)}x`],
            ['min order', `${fmtAmount(m.config.minOrderNotional, d)} ${q} notional, ${fmtAmount(m.config.minOrderMargin, d)} ${q} margin`],
            ['max position', `${fmtAmount(m.config.maxPositionNotional, d)} ${q}`],
            ['exec fee', `${fmtAmount(m.config.execFee, d, 4)} ${q} per order (keeper)`],
            ['vault min deposit', `${fmtAmount(m.config.minDeposit, d)} ${q}`],
            ...side('long', est.long),
            ...side('short', est.short),
            ['vault assets', `${fmtNum(est.vaultAssets)} ${q} (share price ${fmtNum(est.sharePrice, 6)})`],
            ['ledger', String(m.ledger)],
        ]),
        {
            market: s.market.id,
            network: s.pin.key,
            contract: s.market.market,
            status: m.status,
            ledger: m.ledger,
            price: { bid: snap.price.bid, ask: snap.price.ask },
            config: m.config,
            data: m.data,
            estimate: est,
        },
    );
}

export function positionRows(p: MarketPosition, est: ReturnType<typeof estimatePosition>, base: string, quote: string): [string, string][] {
    return [
        ['side', p.isLong ? 'LONG' : 'SHORT'],
        ['size', `${fmtNum(est.notional)} ${quote} (${fmtNum(est.tokens, 4)} ${base})`],
        ['entry price', fmtNum(est.entryPrice, 5)],
        ['margin', `${fmtNum(est.margin)} ${quote}`],
        ['leverage', `${fmtNum(est.leverage)}x`],
        ['pnl', `${fmtNum(est.pnl)} ${quote} (net ${fmtNum(est.netPnl)} ${quote}, ${fmtPct(est.netPnlPercent)})`],
        ['equity', `${fmtNum(est.equity)} ${quote}`],
        ['pending funding', `${fmtNum(est.pendingFunding, 4)} ${quote}`],
        ['pending borrowing', `${fmtNum(est.pendingBorrowing, 4)} ${quote}`],
        ['liquidation price', `${fmtNum(est.liquidationPrice, 5)} (${fmtPct(est.liquidationDistancePercent)} away, health ${fmtNum(est.healthFactor)})`],
        ['close fee', `${fmtNum(est.closeFee, 4)} ${quote}`],
        ['withdrawable margin', `${fmtNum(est.maxWithdrawableMargin)} ${quote}`],
        ['unlocked notional', `${fmtNum(est.unlockedNotional)} ${quote}`],
        ['attached exits', p.decreaseOrders.length ? p.decreaseOrders.map((id) => `#${id}`).join(', ') : 'none'],
    ];
}

export async function cmdPosition(opts: SessionOptions & OutputOptions & { long?: boolean; short?: boolean }): Promise<void> {
    const s = await openSession(opts);
    const acct = requireAccount(s);
    const snap = await loadSnapshot(s);
    const m = snap.market.accrue(snap.price);
    const user = snap.user!;
    const sides = opts.long ? [user.long] : opts.short ? [user.short] : [user.long, user.short];
    const open = sides.filter((p) => p.isOpen());
    const blocks: string[] = [];
    const json: unknown[] = [];
    for (const p of open) {
        const est = estimatePosition(m, p, snap.price);
        blocks.push(kv(positionRows(p, est, s.market.base, s.market.quote)));
        json.push({ side: p.isLong ? 'long' : 'short', raw: p, estimate: est });
    }
    const header = `account ${acct.ref} (${shortAddr(acct.address)}) on ${s.market.symbol} ${s.pin.key}, price bid ${fmtPrice(snap.price.bid)} / ask ${fmtPrice(snap.price.ask)}`;
    emit(
        opts,
        open.length ? `${header}\n\n${blocks.join('\n\n')}` : `${header}\n\nno open position${opts.long ? ' (long)' : opts.short ? ' (short)' : ''}`,
        { account: acct.address, market: s.market.id, network: s.pin.key, ledger: m.ledger, price: { bid: snap.price.bid, ask: snap.price.ask }, positions: json },
    );
}

export function describeOrder(o: PendingOrder, decimals: number, quote: string, shareDecimals = decimals + 6): string[] {
    if (o.type === 'order') {
        const r = o.order;
        const trigger = r.triggerPrice === 0n ? '-' : fmtPrice(r.triggerPrice);
        const bound = r.priceBound === 0n ? 'unbounded' : fmtPrice(r.priceBound);
        const notional = r.notional >= 2n ** 126n ? 'full close' : `${fmtAmount(r.notional, decimals)} ${quote}`;
        return [`#${o.id}`, r.isLong ? 'long' : 'short', ORDER_KIND_NAMES[r.kind] ?? String(r.kind), notional, `${fmtAmount(r.margin, decimals)} ${quote}`, trigger, bound, String(r.expiration)];
    }
    const v = o.order;
    const kind = v.kind === VaultOrderKind.Deposit ? 'vault deposit' : 'vault redeem';
    return [`#${o.id}`, '-', kind, v.kind === VaultOrderKind.Deposit ? `${fmtAmount(v.amount, decimals)} ${quote}` : `${fmtAmount(v.amount, shareDecimals, 6)} shares`, '-', '-', '-', '-'];
}

export async function cmdOrders(opts: SessionOptions & OutputOptions): Promise<void> {
    const s = await openSession(opts);
    const acct = requireAccount(s);
    const snap = await loadSnapshot(s);
    const orders = await snap.user!.loadOrders(s.sdkNetwork);
    const d = snap.market.assetDecimals;
    const rows = orders.map((o) => describeOrder(o, d, s.market.quote, d + snap.market.vaultDecimalsOffset));
    emit(
        opts,
        rows.length
            ? `resting orders for ${acct.ref} on ${s.market.symbol} ${s.pin.key} (ledger ${snap.market.ledger})\n` +
                  table(['id', 'side', 'kind', 'size', 'margin', 'trigger', 'price bound', 'expires (ledger)'], rows)
            : `no resting orders for ${acct.ref} on ${s.market.symbol} ${s.pin.key}`,
        { account: acct.address, market: s.market.id, network: s.pin.key, ledger: snap.market.ledger, orders },
    );
}

export async function cmdBalance(opts: SessionOptions & OutputOptions): Promise<void> {
    const s = await openSession(opts);
    const acct = requireAccount(s);
    const snap = await loadSnapshot(s);
    const native = Asset.native().contractId(s.net.passphrase);
    const d = snap.market.assetDecimals;
    const [usdcOrNull, xlm, shares] = await Promise.all([
        loadTokenBalance(s.sdkNetwork, s.market.collateral, acct.address).catch((err: unknown) => {
            if (isMissingTrustline(err)) return null;
            throw err;
        }),
        loadTokenBalance(s.sdkNetwork, native, acct.address).catch(() => 0n),
        loadTokenBalance(s.sdkNetwork, s.market.vault, acct.address).catch(() => 0n),
    ]);
    const usdc = usdcOrNull ?? 0n;
    const resting = await snap.user!.loadOrders(s.sdkNetwork);
    let escrowedShares = 0n;
    let escrowedDeposits = 0n;
    for (const o of resting) {
        if (o.type !== 'vaultOrder') continue;
        if (o.order.kind === VaultOrderKind.Redeem) escrowedShares += o.order.amount;
        else escrowedDeposits += o.order.amount;
    }
    const collateralLine = usdcOrNull === null
        ? `NO TRUSTLINE — run \`stellar zenex trustline --send\` first, then fund the account with ${s.market.quote}`
        : `${fmtAmount(usdc, d)} (collateral, free to trade)`;
    const shareDecimals = d + snap.market.vaultDecimalsOffset;
    const credit = snap.user!.claimableCredit;
    emit(
        opts,
        kv([
            ['account', `${acct.ref} (${acct.address})`],
            ['network', s.pin.key],
            [s.market.quote, collateralLine],
            ['XLM', `${fmtAmount(xlm, 7)} (pays network fees)`],
            ['vault shares', `${fmtAmount(shares, shareDecimals, 6)} (~${fmtAmount(snap.market.sharesToAssets(shares, snap.price), d)} ${s.market.quote})${escrowedShares ? `, plus ${fmtAmount(escrowedShares, shareDecimals, 6)} escrowed in a resting redeem` : ''}${escrowedDeposits ? `, plus ${fmtAmount(escrowedDeposits, d)} ${s.market.quote} escrowed in a resting deposit` : ''}`],
            ['claimable credit', `${fmtAmount(credit, d)} ${s.market.quote}${credit > 0n ? '  → stellar zenex claim' : ''}`],
        ]),
        { account: acct.address, network: s.pin.key, collateral: usdc, hasTrustline: usdcOrNull !== null, xlm, vaultShares: shares, escrowedShares, escrowedDeposits, claimableCredit: credit, decimals: { collateral: d, shares: shareDecimals, xlm: 7 } },
    );
}

export async function cmdHistory(opts: SessionOptions & OutputOptions & { fills?: boolean; trades?: boolean; limit?: string; cursor?: string }): Promise<void> {
    const s = await openSession({ ...opts, anonymous: !!opts.trades });
    const limit = Math.max(1, Math.min(200, Number(opts.limit ?? 20)));
    const d = 7;
    const q = s.market.quote;
    if (opts.trades) {
        const page = await fetchMarketTrades(s.pin, s.market, limit, opts.cursor);
        const rows = page.items.map((f) => [f.occurredAt, f.side, f.kind, fmtAmount(BigInt(f.notionalAtomic), d), fmtAmount(BigInt(f.tokensAtomic), d, 4), fmtPrice(BigInt(f.priceAtomic)), f.transactionHash.slice(0, 8)]);
        emit(opts, `recent fills on ${s.market.symbol} ${s.pin.key}\n` + table(['time', 'side', 'kind', `size ${q}`, `size ${s.market.base}`, 'price', 'tx'], rows) + (page.nextCursor ? `\nnext: --cursor ${page.nextCursor}` : ''), page);
        return;
    }
    const acct = requireAccount(s);
    if (opts.fills) {
        const page = await fetchFills(s.pin, acct.address, s.market, limit, opts.cursor);
        const rows = page.items.map((f) => {
            const fees = BigInt(f.fees.baseAtomic) + BigInt(f.fees.impactAtomic) + BigInt(f.fees.fundingAtomic) + BigInt(f.fees.borrowingAtomic) + BigInt(f.fees.liqFeeAtomic);
            return [f.occurredAt, `#${f.orderId}`, f.side, f.kind, fmtAmount(BigInt(f.notionalAtomic), d), fmtPrice(BigInt(f.priceAtomic)), fmtAmount(fees, d, 4), fmtAmount(BigInt(f.pnlAtomic), d), f.transactionHash.slice(0, 8)];
        });
        emit(opts, table(['time', 'order', 'side', 'kind', `size ${q}`, 'price', `fees ${q}`, `pnl ${q}`, 'tx'], rows) + (page.nextCursor ? `\nnext: --cursor ${page.nextCursor}` : ''), page);
        return;
    }
    const page = await fetchLifecycles(s.pin, acct.address, s.market, limit, opts.cursor);
    const rows = page.items.map((l) => [
        l.openedAt,
        l.finalizedAt ?? 'open',
        l.side,
        fmtNum(Number(l.size)),
        `${fmtNum(Number(l.leverage), 1)}x`,
        fmtNum(Number(l.entryPrice), 5),
        l.exitPrice ? fmtNum(Number(l.exitPrice), 5) : '-',
        fmtAmount(BigInt(l.netPnlAtomic), d),
        l.finalizationReason ?? '-',
    ]);
    emit(
        opts,
        `positions of ${acct.ref} on ${s.market.symbol} ${s.pin.key}\n` + table(['opened', 'closed', 'side', `size ${q}`, 'lev', 'entry', 'exit', `net pnl ${q}`, 'reason'], rows) + (page.nextCursor ? `\nnext: --cursor ${page.nextCursor}` : ''),
        page,
    );
}

export async function cmdCandles(opts: SessionOptions & OutputOptions & { res?: string; from?: string; to?: string; count?: string }): Promise<void> {
    const s = await openSession({ ...opts, anonymous: true });
    const res = opts.res ?? '1h';
    const now = Math.floor(Date.now() / 1000);
    const to = opts.to ? parseTime(opts.to) : now;
    const seconds = resolutionSeconds(res);
    const count = Math.max(1, Math.min(1000, Number(opts.count ?? 48)));
    const from = opts.from ? parseTime(opts.from) : to - seconds * count;
    const candles = await fetchCandles(s.pin, s.market, res, from, to);
    const rows = candles.map((c) => [new Date(c.time * 1000).toISOString(), fmtNum(c.open, 5), fmtNum(c.high, 5), fmtNum(c.low, 5), fmtNum(c.close, 5)]);
    emit(opts, `${s.market.symbol} ${res} candles (${candles.length})\n` + table(['time', 'open', 'high', 'low', 'close'], rows), { market: s.market.id, resolution: res, candles });
}

function resolutionSeconds(res: string): number {
    const map: Record<string, number> = { '1m': 60, '1': 60, '5m': 300, '5': 300, '15m': 900, '15': 900, '1h': 3600, '60': 3600, '4h': 14400, '240': 14400, '1d': 86400, '1D': 86400, D: 86400 };
    const v = map[res];
    if (v === undefined) throw new Error(`unsupported resolution "${res}" (1m 5m 15m 1h 4h 1d)`);
    return v;
}

function parseTime(text: string): number {
    if (/^\d+$/.test(text)) return Number(text);
    const ms = Date.parse(text);
    if (Number.isNaN(ms)) throw new Error(`bad time "${text}": use unix seconds or ISO-8601`);
    return Math.floor(ms / 1000);
}
