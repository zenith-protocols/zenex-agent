/**
 * Write commands. Each one turns human input into the exact `create_order`
 * / `cancel_order` / `create_vault_order` arguments through the SDK's
 * order intents, pre-flights the identical object through the SDK's fill
 * engine, prints a plan, and runs `stellar contract invoke` so the Stellar
 * CLI signs and submits. Without `--send` nothing leaves this machine: the
 * plan is printed and the call is only simulated.
 */
import {
    OrderIntent,
    OrderKind,
    VaultOrderIntent,
    VaultOrderKind,
    previewOrder,
    type MarketPosition,
    type OrderParams,
} from '@zenith-protocols/zenex-sdk';
import { loadSnapshot, openSession, requireAccount, type Session, type SessionOptions, type Snapshot } from './context.js';
import { ORDER_KIND_NAMES, describeOrder, kv } from './read.js';
import { configDirArgs, runStellar, shellQuote } from './stellar.js';
import { classicAssetOf } from './token.js';
import { fmtAmount, fmtBps, fmtNum, fmtPrice, marginForLeverage, parseAmount, parseLeverage, parsePercentBps, parsePrice, shortAddr, toJson } from './units.js';

export interface WriteOptions extends SessionOptions {
    json?: boolean;
    /** Submit. Without it: plan + simulation only. */
    send?: boolean;
    /** Print the unsigned transaction XDR instead (for `stellar tx sign | stellar tx send`). */
    buildOnly?: boolean;
    /** Print the Stellar CLI command and stop. */
    print?: boolean;
    /** Override the plugin's safety caps. */
    force?: boolean;
    slippage?: string;
    ttl?: string;
}

export interface SideOptions {
    long?: boolean;
    short?: boolean;
}

/** Slippage above this needs --force: past it a "market" order is effectively unbounded. */
const MAX_SLIPPAGE_BPS = 500n;
const DEFAULT_SLIPPAGE = '1';
const DEFAULT_TTL = 60;

function side(opts: SideOptions): boolean {
    if (opts.long === opts.short) throw new Error('pick a side: --long or --short');
    return !!opts.long;
}

function slippageBps(opts: WriteOptions): bigint {
    const bps = parsePercentBps(opts.slippage ?? DEFAULT_SLIPPAGE);
    if (bps === 0n) throw new Error('slippage 0 means unbounded on this contract; pass a positive value');
    if (bps > MAX_SLIPPAGE_BPS && !opts.force) {
        throw new Error(`slippage ${fmtBps(bps)} is above the ${fmtBps(MAX_SLIPPAGE_BPS)} cap; add --force if you mean it`);
    }
    return bps;
}

function ttl(opts: WriteOptions): number {
    const n = Number(opts.ttl ?? DEFAULT_TTL);
    if (!Number.isInteger(n) || n < 1 || n > 100_000) throw new Error('--ttl must be a whole number of ledgers (1..100000)');
    return n;
}

interface Plan {
    action: string;
    lines: [string, string][];
    fn: 'create_order' | 'cancel_order' | 'create_vault_order' | 'cancel_vault_order' | 'claim_credit';
    args: Record<string, string | boolean>;
    preview?: unknown;
    /** Quote-token decimals, for rendering numeric return values. */
    decimals?: number;
}

/** The `-- fn --arg value …` tail exactly as the Stellar CLI's generated contract CLI takes it. */
function contractArgs(plan: Plan): string[] {
    const out = ['--', plan.fn];
    for (const [k, v] of Object.entries(plan.args)) out.push(`--${k}`, typeof v === 'boolean' ? String(v) : v);
    return out;
}

function invokeArgv(session: Session, plan: Plan, opts: WriteOptions): string[] {
    const acct = requireAccount(session);
    const mode = opts.buildOnly ? ['--build-only'] : opts.send ? [] : ['--send=no'];
    return ['contract', 'invoke', '--id', session.market.market, ...session.net.cliArgs, ...acct.cliArgs, ...configDirArgs(opts), ...mode, ...contractArgs(plan)];
}

async function execute(session: Session, plan: Plan, opts: WriteOptions): Promise<void> {
    const acct = requireAccount(session);
    const argv = invokeArgv(session, plan, opts);
    const command = `stellar ${shellQuote(argv)}`;
    const mode = opts.buildOnly ? 'BUILD ONLY: simulated, unsigned envelope on stdout; pipe into `stellar tx sign --sign-with-key <id>` | `stellar tx send`' : opts.send ? 'SEND: signing and submitting' : 'DRY RUN: simulated only, nothing sent. Add --send to submit.';
    const header: [string, string][] = [
        ['network', session.pin.key.toUpperCase()],
        ['market', `${session.market.symbol} ${session.market.market}`],
        ['account', `${acct.ref} (${shortAddr(acct.address)})`],
        ['action', plan.action],
        ...plan.lines,
        ['call', `${plan.fn} ${Object.entries(plan.args).map(([k, v]) => `--${k} ${v}`).join(' ')}`],
        ['mode', mode],
    ];
    if (opts.print) {
        process.stdout.write((opts.json ? toJson({ plan: header, command, argv }) : command) + '\n');
        return;
    }
    if (!opts.json) process.stderr.write(kv(header) + '\n\n');

    const result = await runStellar(argv, { quiet: !!opts.json });
    const stdout = result.stdout.trim();
    const link = /https:\/\/stellar\.expert\S+/.exec(result.stderr)?.[0];
    if (result.code !== 0) {
        const detail = result.stderr.trim().split('\n').slice(-3).join('\n');
        throw new Error(`stellar contract invoke failed (exit ${result.code})${opts.json ? `: ${detail}` : ''}`);
    }
    if (opts.buildOnly) {
        // `--build-only` emits an unsimulated envelope (no Soroban footprint or
        // resource fee). Assemble it here so what we print only needs
        // `stellar tx sign … | stellar tx send …`.
        const sim = await runStellar(['tx', 'simulate', stdout, ...session.net.cliArgs, ...acct.cliArgs, ...configDirArgs(opts)], { quiet: true });
        if (sim.code !== 0) throw new Error(`stellar tx simulate failed: ${sim.stderr.trim().split('\n').slice(-2).join(' ')}`);
        process.stdout.write(sim.stdout.trim() + '\n');
        return;
    }
    const outcome = {
        mode: opts.send ? 'sent' : 'simulated',
        returnValue: stdout,
        explorer: link,
        plan: header,
        preview: plan.preview,
        command,
    };
    if (opts.json) {
        process.stdout.write(toJson(outcome) + '\n');
        return;
    }
    const num = /^"?(\d+)"?$/.exec(stdout)?.[1];
    const idNote =
        plan.fn.startsWith('create') && num ? ` order id ${num}` :
        plan.fn.startsWith('cancel') && num ? ` refunded ${fmtAmount(BigInt(num), plan.decimals ?? 7)} escrow` :
        plan.fn === 'claim_credit' && num ? ` paid ${fmtAmount(BigInt(num), plan.decimals ?? 7)}` :
        stdout ? ` returned ${stdout}` : '';
    process.stdout.write(opts.send ? `sent:${idNote}${link ? `\n${link}` : ''}\n` : `simulation ok:${idNote} (would be allocated on send)\n`);
}

function orderPlan(fn: 'create_order', order: OrderParams): Pick<Plan, 'fn' | 'args'> {
    return {
        fn,
        args: {
            user: order.user,
            is_long: order.isLong,
            kind: String(order.kind),
            notional: order.notional.toString(),
            margin: order.margin.toString(),
            trigger_price: order.triggerPrice.toString(),
            price_bound: order.priceBound.toString(),
            expiration: String(order.expiration),
        },
    };
}

function previewLines(snap: Snapshot, position: MarketPosition, order: OrderParams, quote: string, base: string): { lines: [string, string][]; preview: unknown } {
    const check = previewOrder(snap.market, position, order, snap.price);
    if (check.outcome === 'gate') {
        const code = check.gate?.code;
        const hint = code === 721 ? ' — the position is inside its post-fill notional lock; retry in ~30s (see `unlocked notional` in `stellar zenex position`)' : '';
        throw new Error(`the fill engine rejects this order at the current state: ${check.gate?.message ?? 'rejected'}${code !== undefined ? ` (error ${code})` : ''}${hint}`);
    }
    const lines: [string, string][] = [];
    if (check.outcome === 'rests') {
        lines.push(['preview', `rests until a keeper can fill it${check.reason ? `: ${check.reason}` : ''}`]);
    } else {
        lines.push(['preview', `fills at ${fmtNum(check.executionPrice, 5)}; fees ${fmtNum(check.totalFees, 4)} ${quote} (base ${fmtNum(check.baseFee, 4)} + impact ${fmtNum(check.impactFee, 4)} + keeper ${fmtNum(check.execFee, 4)}); escrow ${fmtNum(check.escrowed, 4)} ${quote}${check.payout ? `; payout ${fmtNum(check.payout, 4)} ${quote}` : ''}`]);
        const p = check.position;
        if (p && p.notional > 0) {
            lines.push(['resulting position', `${fmtNum(p.notional)} ${quote} (${fmtNum(p.tokens, 4)} ${base}) at ${fmtNum(p.leverage)}x, liquidation ${fmtNum(p.liquidationPrice, 5)} (${fmtNum(p.liquidationDistancePercent)}% away), margin ${fmtNum(p.margin)} ${quote}`]);
        } else if (p) {
            lines.push(['resulting position', 'closed']);
        }
    }
    return { lines, preview: check };
}

function sizing(snap: Snapshot, opts: { size?: string; leverage?: string; margin?: string }, quote: string): { notional: bigint; margin: bigint; describe: string } {
    const d = snap.market.assetDecimals;
    if (!opts.size) throw new Error('--size <quote amount> is required (position size in USD, e.g. --size 50)');
    const notional = parseAmount(opts.size, d, 'size');
    let margin: bigint;
    let describe: string;
    if (opts.margin && opts.leverage) throw new Error('pass --leverage or --margin, not both');
    if (opts.margin) {
        margin = parseAmount(opts.margin, d, 'margin');
        describe = `margin ${fmtAmount(margin, d)} ${quote} (${fmtNum(Number(notional) / Number(margin))}x)`;
    } else if (opts.leverage) {
        const lev = parseLeverage(opts.leverage);
        margin = marginForLeverage(notional, lev);
        describe = `${fmtNum(Number(lev) / 10_000, 2)}x (margin ${fmtAmount(margin, d)} ${quote})`;
    } else {
        throw new Error('pass --leverage <x> or --margin <quote amount>');
    }
    return { notional, margin, describe };
}

export async function cmdOpen(opts: WriteOptions & SideOptions & { size?: string; leverage?: string; margin?: string }): Promise<void> {
    const s = await openSession(opts);
    const acct = requireAccount(s);
    const snap = await loadSnapshot(s);
    const isLong = side(opts);
    const bps = slippageBps(opts);
    const { notional, margin, describe } = sizing(snap, opts, s.market.quote);
    const intent = new OrderIntent(snap.market, acct.address, isLong, ttl(opts), bps);
    const order = intent.openMarket({ notional, margin, price: snap.price });
    const position = isLong ? snap.user!.long : snap.user!.short;
    const { lines, preview } = previewLines(snap, position, order, s.market.quote, s.market.base);
    const entry = isLong ? snap.price.ask : snap.price.bid;
    await execute(s, {
        action: `open ${isLong ? 'LONG' : 'SHORT'} ${fmtAmount(notional, snap.market.assetDecimals)} ${s.market.quote} at ${describe}${position.isOpen() ? ' (adds to the open position)' : ''}`,
        lines: [
            ['price', `bid ${fmtPrice(snap.price.bid)} / ask ${fmtPrice(snap.price.ask)}; entry side ${fmtPrice(entry)}`],
            ['price bound', `${isLong ? 'max' : 'min'} fill ${fmtPrice(order.priceBound)} (slippage ${fmtBps(bps)})`],
            ['expires', `ledger ${order.expiration} (${ttl(opts)} ledgers ≈ ${Math.round((ttl(opts) * 5) / 60)} min)`],
            ...lines,
        ],
        ...orderPlan('create_order', order),
        preview,
    }, opts);
}

export async function cmdClose(opts: WriteOptions & SideOptions & { size?: string; withdraw?: string }): Promise<void> {
    const s = await openSession(opts);
    const acct = requireAccount(s);
    const snap = await loadSnapshot(s);
    const isLong = side(opts);
    const bps = slippageBps(opts);
    const position = isLong ? snap.user!.long : snap.user!.short;
    if (!position.isOpen()) throw new Error(`no open ${isLong ? 'long' : 'short'} position to close`);
    const d = snap.market.assetDecimals;
    const intent = new OrderIntent(snap.market, acct.address, isLong, ttl(opts), bps);
    let order: OrderParams;
    let action: string;
    if (opts.size) {
        const notional = parseAmount(opts.size, d, 'size');
        const margin = opts.withdraw ? parseAmount(opts.withdraw, d, 'withdraw') : 0n;
        order = intent.decrease({ notional, margin, price: snap.price });
        action = `decrease ${isLong ? 'LONG' : 'SHORT'} by ${fmtAmount(notional, d)} ${s.market.quote} of ${fmtAmount(position.notional, d)}${margin ? `, withdraw ${fmtAmount(margin, d)} ${s.market.quote} margin` : ''}`;
    } else {
        if (opts.withdraw) throw new Error('--withdraw only applies to a partial close (--size); a full close returns all margin');
        order = intent.closePosition(snap.price);
        action = `close ${isLong ? 'LONG' : 'SHORT'} in full (${fmtAmount(position.notional, d)} ${s.market.quote})`;
    }
    const { lines, preview } = previewLines(snap, position, order, s.market.quote, s.market.base);
    await execute(s, {
        action,
        lines: [
            ['price', `bid ${fmtPrice(snap.price.bid)} / ask ${fmtPrice(snap.price.ask)}; exit side ${fmtPrice(isLong ? snap.price.bid : snap.price.ask)}`],
            ['price bound', `${isLong ? 'min' : 'max'} fill ${fmtPrice(order.priceBound)} (slippage ${fmtBps(bps)})`],
            ['expires', `ledger ${order.expiration}`],
            ...lines,
        ],
        ...orderPlan('create_order', order),
        preview,
    }, opts);
}

export async function cmdLimit(opts: WriteOptions & SideOptions & { size?: string; leverage?: string; margin?: string; at?: string }): Promise<void> {
    const s = await openSession(opts);
    const acct = requireAccount(s);
    const snap = await loadSnapshot(s);
    const isLong = side(opts);
    const bps = slippageBps(opts);
    if (!opts.at) throw new Error('--at <price> is required for a limit order');
    const triggerPrice = parsePrice(opts.at, 'limit price');
    const { notional, margin, describe } = sizing(snap, opts, s.market.quote);
    const intent = new OrderIntent(snap.market, acct.address, isLong, ttl(opts), bps);
    const order = intent.openLimit({ notional, margin, triggerPrice });
    const position = isLong ? snap.user!.long : snap.user!.short;
    const { lines, preview } = previewLines(snap, position, order, s.market.quote, s.market.base);
    const cmp = isLong ? 'at or below' : 'at or above';
    await execute(s, {
        action: `limit ${isLong ? 'LONG' : 'SHORT'} ${fmtAmount(notional, snap.market.assetDecimals)} ${s.market.quote} at ${describe}, fills ${cmp} ${fmtPrice(triggerPrice)}`,
        lines: [
            ['price now', `bid ${fmtPrice(snap.price.bid)} / ask ${fmtPrice(snap.price.ask)}`],
            ['price bound', `${isLong ? 'max' : 'min'} fill ${fmtPrice(order.priceBound)} (slippage ${fmtBps(bps)} past the trigger)`],
            ['expires', `ledger ${order.expiration} (${ttl(opts)} ledgers)`],
            ...lines,
        ],
        ...orderPlan('create_order', order),
        preview,
    }, opts);
}

async function exitOrder(kind: 'tp' | 'sl', opts: WriteOptions & SideOptions & { at?: string; size?: string }): Promise<void> {
    const s = await openSession(opts);
    const acct = requireAccount(s);
    const snap = await loadSnapshot(s);
    const isLong = side(opts);
    const bps = slippageBps(opts);
    if (!opts.at) throw new Error(`--at <price> is required for a ${kind === 'tp' ? 'take-profit' : 'stop-loss'}`);
    const triggerPrice = parsePrice(opts.at, 'trigger price');
    const position = isLong ? snap.user!.long : snap.user!.short;
    if (!position.isOpen()) throw new Error(`no open ${isLong ? 'long' : 'short'} position to attach an exit to`);
    const d = snap.market.assetDecimals;
    const notional = opts.size ? parseAmount(opts.size, d, 'size') : undefined;
    const intent = new OrderIntent(snap.market, acct.address, isLong, ttl(opts), bps);
    const order = kind === 'tp' ? intent.takeProfit({ triggerPrice, notional }) : intent.stopLoss({ triggerPrice, notional });
    const exit = isLong ? snap.price.bid : snap.price.ask;
    const favorable = kind === 'tp' ? (isLong ? triggerPrice > exit : triggerPrice < exit) : (isLong ? triggerPrice < exit : triggerPrice > exit);
    if (!favorable) {
        throw new Error(`a ${kind === 'tp' ? 'take-profit' : 'stop-loss'} on a ${isLong ? 'long' : 'short'} must sit ${kind === 'tp' ? (isLong ? 'above' : 'below') : (isLong ? 'below' : 'above')} the current exit price ${fmtPrice(exit)}`);
    }
    const { lines, preview } = previewLines(snap, position, order, s.market.quote, s.market.base);
    await execute(s, {
        action: `${kind === 'tp' ? 'take-profit' : 'stop-loss'} on ${isLong ? 'LONG' : 'SHORT'}: close ${notional ? `${fmtAmount(notional, d)} ${s.market.quote}` : 'in full'} when price crosses ${fmtPrice(triggerPrice)}`,
        lines: [
            ['price now', `bid ${fmtPrice(snap.price.bid)} / ask ${fmtPrice(snap.price.ask)}`],
            ['price bound', `${isLong ? 'min' : 'max'} fill ${fmtPrice(order.priceBound)} (slippage ${fmtBps(bps)} past the trigger)`],
            ['expires', `ledger ${order.expiration} (${ttl(opts)} ledgers; use a long --ttl for a standing exit)`],
            ...lines,
        ],
        ...orderPlan('create_order', order),
        preview,
    }, opts);
}

export const cmdTakeProfit = (opts: WriteOptions & SideOptions & { at?: string; size?: string }) => exitOrder('tp', opts);
export const cmdStopLoss = (opts: WriteOptions & SideOptions & { at?: string; size?: string }) => exitOrder('sl', opts);

export async function cmdMargin(action: 'add' | 'withdraw', amountText: string, opts: WriteOptions & SideOptions): Promise<void> {
    const s = await openSession(opts);
    const acct = requireAccount(s);
    const snap = await loadSnapshot(s);
    const isLong = side(opts);
    const d = snap.market.assetDecimals;
    const amount = parseAmount(amountText, d, 'amount');
    const position = isLong ? snap.user!.long : snap.user!.short;
    if (!position.isOpen()) throw new Error(`no open ${isLong ? 'long' : 'short'} position`);
    const intent = new OrderIntent(snap.market, acct.address, isLong, ttl(opts), 0n);
    const order = action === 'add' ? intent.addMargin(amount) : intent.withdrawMargin(amount);
    const { lines, preview } = previewLines(snap, position, order, s.market.quote, s.market.base);
    await execute(s, {
        action: `${action} ${fmtAmount(amount, d)} ${s.market.quote} margin ${action === 'add' ? 'to' : 'from'} the ${isLong ? 'LONG' : 'SHORT'} position`,
        lines: [['expires', `ledger ${order.expiration}`], ...lines],
        ...orderPlan('create_order', order),
        preview,
    }, opts);
}

export async function cmdCancel(opts: WriteOptions & { id?: string }): Promise<void> {
    const s = await openSession(opts);
    const acct = requireAccount(s);
    const snap = await loadSnapshot(s);
    if (!opts.id || !/^\d+$/.test(opts.id)) throw new Error('--id <order id> is required (see `stellar zenex orders`)');
    const id = Number(opts.id);
    const orders = await snap.user!.loadOrders(s.sdkNetwork);
    const hit = orders.find((o) => o.id === id);
    if (!hit) throw new Error(`order #${id} is not resting for ${acct.ref} (already filled, cancelled, or expired)`);
    const desc = describeOrder(hit, snap.market.assetDecimals, s.market.quote, snap.market.assetDecimals + snap.market.vaultDecimalsOffset);
    await execute(s, {
        action: `cancel ${desc.slice(0, 1)[0]} ${desc[2]} ${desc[3]} (escrow is refunded)`,
        lines: [],
        fn: hit.type === 'order' ? 'cancel_order' : 'cancel_vault_order',
        args: { user: acct.address, id: String(id) },
        decimals: snap.market.assetDecimals,
    }, opts);
}

export async function cmdClaim(opts: WriteOptions): Promise<void> {
    const s = await openSession(opts);
    const acct = requireAccount(s);
    const snap = await loadSnapshot(s);
    const credit = snap.user!.claimableCredit;
    if (credit <= 0n) throw new Error('nothing to claim');
    await execute(s, {
        action: `claim ${fmtAmount(credit, snap.market.assetDecimals)} ${s.market.quote} of credit`,
        lines: [],
        fn: 'claim_credit',
        args: { user: acct.address },
        decimals: snap.market.assetDecimals,
    }, opts);
}

export async function cmdVault(kind: 'deposit' | 'redeem', amountText: string | undefined, opts: WriteOptions & { all?: boolean }): Promise<void> {
    const s = await openSession(opts);
    const acct = requireAccount(s);
    const snap = await loadSnapshot(s);
    const d = snap.market.assetDecimals;
    const shareDecimals = d + snap.market.vaultDecimalsOffset;
    const bps = slippageBps(opts);
    let amount: bigint;
    if (kind === 'deposit') {
        if (!amountText) throw new Error('deposit <quote amount> is required');
        amount = parseAmount(amountText, d, 'deposit');
        if (amount < snap.market.config.minDeposit) {
            throw new Error(`deposit ${fmtAmount(amount, d)} ${s.market.quote} is below the vault minimum of ${fmtAmount(snap.market.config.minDeposit, d)} ${s.market.quote}`);
        }
    } else if (opts.all) {
        const { loadTokenBalance } = await import('@zenith-protocols/zenex-sdk');
        amount = await loadTokenBalance(s.sdkNetwork, s.market.vault, acct.address);
        if (amount <= 0n) throw new Error('no vault shares to redeem');
    } else {
        if (!amountText) throw new Error('redeem <shares> or --all is required');
        amount = parseAmount(amountText, shareDecimals, 'shares');
    }
    const vk = kind === 'deposit' ? VaultOrderKind.Deposit : VaultOrderKind.Redeem;
    const intent = VaultOrderIntent.create(snap.market, acct.address, vk, amount, bps, snap.price);
    const expected = intent.expectedOut(snap.market, snap.price);
    const outLabel = kind === 'deposit' ? `${fmtAmount(expected, shareDecimals, 6)} shares` : `${fmtAmount(expected, d)} ${s.market.quote}`;
    const minLabel = kind === 'deposit' ? `${fmtAmount(intent.minOut, shareDecimals, 6)} shares` : `${fmtAmount(intent.minOut, d)} ${s.market.quote}`;
    await execute(s, {
        action: kind === 'deposit' ? `deposit ${fmtAmount(amount, d)} ${s.market.quote} into the vault` : `redeem ${fmtAmount(amount, shareDecimals, 6)} vault shares`,
        lines: [
            ['expected', `${outLabel} at share price ${fmtNum(Number(snap.market.sharesToAssets(10n ** BigInt(shareDecimals), snap.price)) / 10 ** d, 6)}`],
            ['minimum out', `${minLabel} (slippage ${fmtBps(bps)}); a keeper fills it, cancel refunds the escrow`],
            ...(kind === 'redeem' && snap.market.config.redeemLock > 0n ? [['note', `redeems wait out a ${snap.market.config.redeemLock}s lock`] as [string, string]] : []),
        ],
        fn: 'create_vault_order',
        args: { user: acct.address, kind: String(vk), amount: amount.toString(), min_out: intent.minOut.toString() },
    }, opts);
}

export { ORDER_KIND_NAMES, OrderKind };

/** Add the collateral trustline to a classic account (`stellar tx new change-trust`). */
export async function cmdTrustline(opts: WriteOptions): Promise<void> {
    const s = await openSession(opts);
    const acct = requireAccount(s);
    const asset = await classicAssetOf(s.sdkNetwork, s.market.collateral);
    const argv = ['tx', 'new', 'change-trust', ...s.net.cliArgs, ...acct.cliArgs, ...configDirArgs(opts), '--line', asset.line, ...(opts.buildOnly ? ['--build-only'] : [])];
    const command = `stellar ${shellQuote(argv)}`;
    const header: [string, string][] = [
        ['network', s.pin.key.toUpperCase()],
        ['account', `${acct.ref} (${shortAddr(acct.address)})`],
        ['action', `add a trustline for ${asset.code} issued by ${asset.issuer} (the ${s.market.symbol} collateral)`],
        ['mode', opts.buildOnly ? 'BUILD ONLY: unsigned XDR on stdout' : opts.send ? 'SEND: signing and submitting' : 'DRY RUN: nothing sent. Add --send to submit.'],
    ];
    if (opts.print) {
        process.stdout.write((opts.json ? toJson({ plan: header, command, argv }) : command) + '\n');
        return;
    }
    if (!opts.json) process.stderr.write(kv(header) + '\n\n');
    if (!opts.send && !opts.buildOnly) {
        process.stdout.write(opts.json ? toJson({ mode: 'planned', asset, command }) + '\n' : `planned: ${command}\n`);
        return;
    }
    const result = await runStellar(argv, { quiet: !!opts.json });
    if (result.code !== 0) throw new Error(`stellar tx new change-trust failed (exit ${result.code})`);
    if (opts.buildOnly) {
        process.stdout.write(result.stdout.trim() + '\n');
        return;
    }
    const link = /https:\/\/stellar\.expert\S+/.exec(result.stderr)?.[0];
    process.stdout.write(opts.json ? toJson({ mode: 'sent', asset, explorer: link, command }) + '\n' : `sent: trustline for ${asset.line}${link ? `\n${link}` : ''}\n`);
}
