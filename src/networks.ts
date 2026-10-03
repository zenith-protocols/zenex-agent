/**
 * Where Zenex is deployed. Only the market contracts are pinned — everything
 * else is read from the chain (vault, collateral, feed, decimals) or from
 * the Stellar CLI (RPC, passphrase). A new market or a redeploy is a new
 * release of this package.
 *
 * Keyed by network passphrase, which is what the Stellar CLI resolves a
 * network name to. The Zenex API origin is the one off-chain thing per
 * network: display prices, candles and indexed history live there.
 */
import { Networks, StrKey } from '@stellar/stellar-sdk';

export interface Deployment {
    /** Human name, for messages. */
    name: 'mainnet' | 'testnet';
    /** Zenex API origin: prices, candles, history. */
    api: string;
    /** Market contracts, the first being the default. */
    markets: string[];
}

export const DEPLOYMENTS: Record<string, Deployment> = {
    [Networks.PUBLIC]: {
        name: 'mainnet',
        api: 'https://api.zenex.trade',
        markets: ['CAOZCITWHWAXH5FRU4EULQ5EN2HMTCHICRNC4R5ZAOVD7XHCCQSJ42IB'],
    },
    [Networks.TESTNET]: {
        name: 'testnet',
        api: 'https://api-testnet.zenex.trade',
        markets: ['CCOIDO46A4HHBOQQSHKY3RC6BM6HE3V7UMYNICG7PA7ABS422W672F6U'],
    },
};

/** The Zenex deployment on a network, by passphrase. */
export function deploymentFor(passphrase: string): Deployment {
    const dep = DEPLOYMENTS[passphrase];
    if (!dep) {
        const known = Object.values(DEPLOYMENTS).map((d) => d.name).join(' and ');
        throw new Error(`Zenex is deployed on ${known} only (network passphrase "${passphrase}")`);
    }
    return dep;
}

export function isContractAddress(ref: string): boolean {
    return StrKey.isValidContract(ref);
}
