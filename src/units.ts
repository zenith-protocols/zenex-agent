/**
 * Every conversion between what a human types and what the contract takes
 * lives here, and nowhere else. Sizes, margin and fees are quote-token
 * amounts (USDC, 7 decimals on Stellar); prices are 18-decimal, the native
 * precision of the Chainlink report the keeper fills against; slippage is
 * basis points; expirations are ledger sequence numbers.
 */
import { formatToken, parseAtomic } from '@zenith-protocols/zenex-sdk';

export const PRICE_DECIMALS = 18;

/** `"50"` or `"50.25"` of a token with `decimals` → atomic bigint. Rejects floats, exponents, negatives. */
export function parseAmount(text: string, decimals: number, what: string): bigint {
    const clean = text.trim().replace(/,/g, '').replace(/^\$/, '');
    let value: bigint;
    try {
        value = parseAtomic(clean, decimals);
    } catch {
        throw new Error(`${what}: "${text}" is not a decimal amount (use plain digits like 50 or 12.5)`);
    }
    if (value <= 0n) throw new Error(`${what}: must be positive, got "${text}"`);
    return value;
}

/** A quote price typed as `"0.2150"` → 18-dec bigint. */
export function parsePrice(text: string, what = 'price'): bigint {
    return parseAmount(text, PRICE_DECIMALS, what);
}

/** `"1"` (percent) → `100n` bps; `"0.25"` → `25n`. Two decimal places of a percent is the resolution. */
export function parsePercentBps(text: string, what = 'slippage'): bigint {
    const clean = text.trim().replace(/%$/, '');
    let bps: bigint;
    try {
        bps = parseAtomic(clean, 2);
    } catch {
        throw new Error(`${what}: "${text}" is not a percentage (use 1 for 1%, 0.5 for 0.5%)`);
    }
    if (bps < 0n) throw new Error(`${what}: cannot be negative`);
    return bps;
}

/** `"5"` or `"5x"` → leverage as a rational (numerator, 1e4 denominator). */
export function parseLeverage(text: string): bigint {
    const clean = text.trim().replace(/x$/i, '');
    let lev: bigint;
    try {
        lev = parseAtomic(clean, 4);
    } catch {
        throw new Error(`leverage: "${text}" is not a number (use 5 or 2.5)`);
    }
    if (lev < 10_000n) throw new Error(`leverage: must be at least 1x, got "${text}"`);
    return lev;
}

export const LEVERAGE_SCALE = 10_000n;

/** Margin that gives `notional` at `leverage` (1e4-scaled), rounded up so the position never exceeds the leverage asked for. */
export function marginForLeverage(notional: bigint, leverage: bigint): bigint {
    return (notional * LEVERAGE_SCALE + leverage - 1n) / leverage;
}

export function fmtAmount(atomic: bigint, decimals: number, places = 2): string {
    return formatToken(atomic, decimals).toLocaleString('en-US', { minimumFractionDigits: places, maximumFractionDigits: places });
}

export function fmtPrice(atomic18: bigint, places = 5): string {
    return formatToken(atomic18, PRICE_DECIMALS).toLocaleString('en-US', { minimumFractionDigits: places, maximumFractionDigits: places });
}

export function fmtPct(value: number, places = 2): string {
    return `${value.toFixed(places)}%`;
}

export function fmtNum(value: number, places = 2): string {
    return value.toLocaleString('en-US', { minimumFractionDigits: places, maximumFractionDigits: places });
}

export function fmtBps(bps: bigint): string {
    return `${(Number(bps) / 100).toFixed(2)}%`;
}

export function shortAddr(addr: string): string {
    return addr.length > 12 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr;
}

/** JSON.stringify that survives bigint. */
export function toJson(value: unknown): string {
    return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
}
