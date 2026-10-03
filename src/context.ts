/**
 * One resolved session: the network and account the Stellar CLI resolved,
 * the market contract, and a fresh chain snapshot plus display price. Every
 * command starts here so reads and writes agree on the same ledger.
 */
import { Market, MarketUser, Price, type MarketContracts } from '@zenith-protocols/zenex-sdk';
import { apiMarketFor, fetchApiMarkets, fetchTicker, type Ticker } from './api.js';
import { isContractAddress, type Deployment } from './networks.js';
import { resolveAccount, resolveNetwork, type GlobalOptions, type ResolvedAccount, type ResolvedNetwork } from './stellar.js';
import { classicAssetOf } from './token.js';

export interface SessionOptions extends GlobalOptions {
    market?: string;
    /** Allow reads without an account (e.g. `price`, `market`). */
    anonymous?: boolean;
}

export interface Session {
    net: ResolvedNetwork;
    dep: Deployment;
    /** The market contract every call goes to. */
    marketContract: string;
    /** Undefined only when `anonymous` and nothing is configured. */
    account: ResolvedAccount | undefined;
    sdkNetwork: { rpc: string; passphrase: string };
}

export async function openSession(opts: SessionOptions): Promise<Session> {
    const net = await resolveNetwork(opts);
    const marketContract = await resolveMarket(net.dep, opts.market);
    let account: ResolvedAccount | undefined;
    try {
        account = await resolveAccount(opts);
    } catch (err) {
        if (!opts.anonymous) throw err;
    }
    return { net, dep: net.dep, marketContract, account, sdkNetwork: { rpc: net.rpc, passphrase: net.passphrase } };
}

/** A market by contract address (any), or by the id / chart symbol the API lists it under. */
async function resolveMarket(dep: Deployment, ref: string | undefined): Promise<string> {
    if (ref === undefined) {
        const first = dep.markets[0];
        if (!first) throw new Error(`no market pinned for ${dep.name}`);
        return first;
    }
    if (isContractAddress(ref)) return ref;
    const needle = ref.toLowerCase();
    const listed = await fetchApiMarkets(dep.api);
    const hit = listed.find((m) => m.id.toLowerCase() === needle || m.chartSymbol.toLowerCase() === needle || m.id.replace('-', '').toLowerCase() === needle);
    if (!hit) throw new Error(`unknown market "${ref}" on ${dep.name}; known: ${listed.map((m) => m.id).join(', ')} (or pass a contract address)`);
    return hit.trading;
}

/** Display names, derived rather than pinned: the quote symbol from the collateral asset, the pair from the API's market id. */
export interface Labels {
    /** `XLM-USD` */
    symbol: string;
    /** `XLM` */
    base: string;
    /** `USDC` */
    quote: string;
    /** The API's id for history routes (`xlm-usd`). */
    marketId: string;
    /** `0x…` hex of the market's feed anchor. */
    feedId: string;
}

export interface Snapshot {
    contracts: MarketContracts;
    market: Market;
    user: MarketUser | undefined;
    ticker: Ticker;
    price: Price;
    labels: Labels;
}

/** Load the market (and the session account, when there is one) at one ledger, with the live display price. */
export async function loadSnapshot(session: Session, opts: { withUser?: boolean } = {}): Promise<Snapshot> {
    const wantUser = opts.withUser ?? true;
    const contracts = await Market.resolveContracts(session.sdkNetwork, session.marketContract);
    const [loaded, asset] = await Promise.all([
        wantUser && session.account
            ? Market.loadWithUser(session.sdkNetwork, contracts, session.account.address)
            : Market.load(session.sdkNetwork, contracts).then((market) => ({ market, user: undefined as MarketUser | undefined })),
        classicAssetOf(session.sdkNetwork, contracts.token).catch(() => undefined),
    ]);
    const feedId = `0x${loaded.market.feedId.toString('hex')}`;
    const ticker = await fetchTicker(session.dep.api, feedId);
    const price = new Price(BigInt(ticker.bid), BigInt(ticker.ask), BigInt(ticker.observationsTimestamp));
    const [base = 'BASE', quoteFromId = 'USD'] = ticker.marketId.toUpperCase().split('-');
    const labels: Labels = {
        symbol: `${base}-${quoteFromId}`,
        base,
        quote: asset?.code ?? quoteFromId,
        marketId: ticker.marketId,
        feedId,
    };
    return { contracts, market: loaded.market, user: loaded.user, ticker, price, labels };
}

/** The API's chart symbol for the session market (candles only). */
export async function chartSymbolFor(session: Session): Promise<string> {
    const listed = await apiMarketFor(session.dep.api, session.marketContract);
    if (!listed) throw new Error(`${session.dep.api} lists no candles for market ${session.marketContract}`);
    return listed.chartSymbol;
}

export function requireAccount(session: Session): ResolvedAccount {
    if (!session.account) {
        throw new Error('this command needs an account: pass --source-account <identity> or run `stellar keys use <identity>`');
    }
    return session.account;
}
