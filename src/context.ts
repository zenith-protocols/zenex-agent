/**
 * One resolved session: the network and account the Stellar CLI would use,
 * the pinned market, and a fresh chain snapshot plus display price. Every
 * command starts here so reads and writes agree on the same ledger.
 */
import { Market, MarketUser, Price, type MarketContracts } from '@zenith-protocols/zenex-sdk';
import { fetchTicker, type Ticker } from './api.js';
import { findMarket, type MarketPin, type NetworkPin } from './networks.js';
import { resolveAccount, resolveNetwork, type GlobalOptions, type ResolvedAccount, type ResolvedNetwork } from './stellar.js';

export interface SessionOptions extends GlobalOptions {
    market?: string;
    /** Allow reads without an account (e.g. `price`, `market`). */
    anonymous?: boolean;
}

export interface Session {
    net: ResolvedNetwork;
    pin: NetworkPin;
    market: MarketPin;
    /** Undefined only when `anonymous` and nothing is configured. */
    account: ResolvedAccount | undefined;
    sdkNetwork: { rpc: string; passphrase: string };
}

export async function openSession(opts: SessionOptions): Promise<Session> {
    const net = resolveNetwork(opts);
    const market = findMarket(net.pin, opts.market);
    let account: ResolvedAccount | undefined;
    try {
        account = await resolveAccount(opts);
    } catch (err) {
        if (!opts.anonymous) throw err;
    }
    return { net, pin: net.pin, market, account, sdkNetwork: { rpc: net.rpc, passphrase: net.passphrase } };
}

export interface Snapshot {
    contracts: MarketContracts;
    market: Market;
    user: MarketUser | undefined;
    ticker: Ticker;
    price: Price;
}

/** Load the market (and the session account, when there is one) at one ledger, with the live display price. */
export async function loadSnapshot(session: Session, opts: { withUser?: boolean } = {}): Promise<Snapshot> {
    const wantUser = opts.withUser ?? true;
    const [contracts, ticker] = await Promise.all([
        Market.resolveContracts(session.sdkNetwork, session.market.market),
        fetchTicker(session.pin, session.market),
    ]);
    const price = new Price(BigInt(ticker.bid), BigInt(ticker.ask), BigInt(ticker.observationsTimestamp));
    if (wantUser && session.account) {
        const { market, user } = await Market.loadWithUser(session.sdkNetwork, contracts, session.account.address);
        return { contracts, market, user, ticker, price };
    }
    const market = await Market.load(session.sdkNetwork, contracts);
    return { contracts, market, user: undefined, ticker, price };
}

export function requireAccount(session: Session): ResolvedAccount {
    if (!session.account) {
        throw new Error('this command needs an account: pass --source-account <identity> or run `stellar keys use <identity>`');
    }
    return session.account;
}
