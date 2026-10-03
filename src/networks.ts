/**
 * Pinned Zenex deployments. One entry per Stellar network the protocol is
 * deployed on; a new market or a redeploy is a new release of this package.
 *
 * Addresses mirror the public deployment records (docs.zenex.trade/deployments
 * and GET /v1/config on each network's API). They are pinned here on purpose:
 * the plugin never has to trust a network call to know where the market is.
 */

export interface MarketPin {
    /** Short id used on the command line and by the read API (`xlm-usd`). */
    id: string;
    /** Display pair. */
    symbol: string;
    /** Base asset symbol (what a position is sized in). */
    base: string;
    /** Quote / collateral symbol (what sizes, margin and fees are quoted in). */
    quote: string;
    /** Market contract. Every trader call goes here. */
    market: string;
    /** Strategy vault paired with the market (LP side). */
    vault: string;
    /** Collateral token contract (SAC). */
    collateral: string;
    /** TradingView-style chart symbol the candle endpoint takes. */
    chartSymbol: string;
    /** Chainlink Data Streams feed id the market is anchored to. */
    feedId: string;
}

export interface NetworkPin {
    key: 'mainnet' | 'testnet';
    passphrase: string;
    /** Public RPC used when the Stellar CLI network has none configured. */
    defaultRpc: string;
    /** Zenex API origin: prices, candles, history. */
    api: string;
    /** Explorer base for links. */
    explorer: string;
    markets: MarketPin[];
}

export const MAINNET_PASSPHRASE = 'Public Global Stellar Network ; September 2015';
export const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';

export const NETWORKS: Record<'mainnet' | 'testnet', NetworkPin> = {
    mainnet: {
        key: 'mainnet',
        passphrase: MAINNET_PASSPHRASE,
        defaultRpc: 'https://soroban-rpc.mainnet.stellar.gateway.fm',
        api: 'https://api.zenex.trade',
        explorer: 'https://stellar.expert/explorer/public',
        markets: [
            {
                id: 'xlm-usd',
                symbol: 'XLM-USD',
                base: 'XLM',
                quote: 'USDC',
                market: 'CAOZCITWHWAXH5FRU4EULQ5EN2HMTCHICRNC4R5ZAOVD7XHCCQSJ42IB',
                vault: 'CB2MX4WXJHOHCTDTN5DCFC7G3TLFLOYLCRCINPK7G2A3EUVW2AYVA56N',
                collateral: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
                chartSymbol: 'XLMUSD',
                feedId: '0x000358cb12b1f5bbeca8b5b4666025a40b15520af1f82516ee2fb9a335055e9a',
            },
        ],
    },
    testnet: {
        key: 'testnet',
        passphrase: TESTNET_PASSPHRASE,
        defaultRpc: 'https://soroban-testnet.stellar.org',
        api: 'https://api-testnet.zenex.trade',
        explorer: 'https://stellar.expert/explorer/testnet',
        markets: [
            {
                id: 'xlm-usd',
                symbol: 'XLM-USD',
                base: 'XLM',
                quote: 'USDC',
                market: 'CCOIDO46A4HHBOQQSHKY3RC6BM6HE3V7UMYNICG7PA7ABS422W672F6U',
                vault: 'CCKXT53FROOVQOMFWTOM5F3UHRXBX7CYAZKLPZ4GZ3WOD7XZBFQ2VNF4',
                collateral: 'CD4MP2QV4LABFU5OL6Y5RICCLQIX7TWT6T6J546EDYVUXHH6RS2V5S2O',
                chartSymbol: 'XLMUSD',
                feedId: '0x000358cb12b1f5bbeca8b5b4666025a40b15520af1f82516ee2fb9a335055e9a',
            },
        ],
    },
};

/** Map a network passphrase to the Zenex deployment on it, if any. */
export function pinForPassphrase(passphrase: string): NetworkPin | undefined {
    return Object.values(NETWORKS).find((n) => n.passphrase === passphrase);
}

/** Resolve a market by id, symbol, or contract address (case-insensitive on names). */
export function findMarket(pin: NetworkPin, ref: string | undefined): MarketPin {
    if (ref === undefined) {
        const first = pin.markets[0];
        if (first === undefined) throw new Error(`no markets pinned for ${pin.key}`);
        return first;
    }
    const needle = ref.toLowerCase();
    const hit = pin.markets.find(
        (m) =>
            m.id === needle ||
            m.symbol.toLowerCase() === needle ||
            m.chartSymbol.toLowerCase() === needle ||
            m.market === ref,
    );
    if (hit === undefined) {
        const known = pin.markets.map((m) => m.id).join(', ');
        throw new Error(`unknown market "${ref}" on ${pin.key}; known: ${known}`);
    }
    return hit;
}
