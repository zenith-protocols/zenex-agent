/**
 * The collateral is a Stellar Asset Contract wrapping a classic asset
 * (`USDC:G…`). A classic account needs a trustline to that asset before it
 * can hold collateral, so a fresh bot account's first mainnet step is here.
 */
import { Contract, scValToNative, xdr } from '@stellar/stellar-sdk';
import { simulateAndParse } from '@zenith-protocols/zenex-sdk';

export interface ClassicAsset {
    code: string;
    issuer: string;
    /** `CODE:ISSUER`, the form `stellar tx new change-trust --line` takes. */
    line: string;
}

/** Resolve the classic asset behind a SAC from its `name()` (`"USDC:GA5Z…"`). */
export async function classicAssetOf(network: { rpc: string; passphrase: string }, sac: string): Promise<ClassicAsset> {
    const op = new Contract(sac).call('name').toXDR('base64');
    const { result } = await simulateAndParse(network, op, (retval: string) => scValToNative(xdr.ScVal.fromXDR(retval, 'base64')) as string);
    const [code, issuer] = result.split(':');
    if (!code || !issuer) throw new Error(`collateral ${sac} is not a classic-asset SAC (name "${result}")`);
    return { code, issuer, line: `${code}:${issuer}` };
}

export function isMissingTrustline(err: unknown): boolean {
    return err instanceof Error && /trustline is missing/i.test(err.message);
}
