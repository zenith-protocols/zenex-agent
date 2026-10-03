import { Networks } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { marginForLeverage, parseAmount, parseLeverage, parsePercentBps, parsePrice } from '../src/units.js';
import { parseNetworkList } from '../src/stellar.js';
import { DEPLOYMENTS, deploymentFor, isContractAddress } from '../src/networks.js';

describe('amounts', () => {
    it('parses quote amounts at 7 decimals', () => {
        expect(parseAmount('50', 7, 'size')).toBe(500000000n);
        expect(parseAmount('12.5', 7, 'size')).toBe(125000000n);
        expect(parseAmount('$1,000.25', 7, 'size')).toBe(10002500000n);
    });
    it('rejects floats, exponents and non-positive values', () => {
        expect(() => parseAmount('1e3', 7, 'size')).toThrow(/decimal amount/);
        expect(() => parseAmount('0', 7, 'size')).toThrow(/positive/);
        expect(() => parseAmount('-5', 7, 'size')).toThrow();
        expect(() => parseAmount('abc', 7, 'size')).toThrow(/decimal amount/);
    });
    it('parses prices at 18 decimals', () => {
        expect(parsePrice('0.2150')).toBe(215000000000000000n);
        expect(parsePrice('1')).toBe(10n ** 18n);
    });
    it('parses percent to bps', () => {
        expect(parsePercentBps('1')).toBe(100n);
        expect(parsePercentBps('0.5%')).toBe(50n);
        expect(parsePercentBps('0')).toBe(0n);
        expect(() => parsePercentBps('x')).toThrow(/percentage/);
    });
    it('parses leverage and sizes margin by it, rounding up', () => {
        expect(parseLeverage('5')).toBe(50000n);
        expect(parseLeverage('2.5x')).toBe(25000n);
        expect(() => parseLeverage('0.5')).toThrow(/at least 1x/);
        expect(marginForLeverage(500000000n, parseLeverage('5'))).toBe(100000000n);
        // 50 USDC at 3x = 16.6666667 USDC, rounded up to the atomic
        expect(marginForLeverage(500000000n, parseLeverage('3'))).toBe(166666667n);
    });
});

describe('stellar cli network list', () => {
    it('parses `stellar network ls -l`, keeping order so configured entries shadow built-ins', () => {
        const text = [
            'Name: mainnet', 'RPC url: https://rpc.example/', 'RPC headers: not set', `Network passphrase: ${Networks.PUBLIC}`, '',
            'Name: mainnet', 'RPC url: Bring Your Own: https://developers.stellar.org/docs/data/rpc/rpc-providers', 'RPC headers: not set', `Network passphrase: ${Networks.PUBLIC}`, '',
            'Name: testnet', 'RPC url: https://soroban-testnet.stellar.org/', 'RPC headers: not set', `Network passphrase: ${Networks.TESTNET}`,
        ].join('\n');
        const list = parseNetworkList(text);
        expect(list).toHaveLength(3);
        expect(list[0]).toEqual({ name: 'mainnet', rpc: 'https://rpc.example/', passphrase: Networks.PUBLIC });
        expect(list[1]?.rpc).toMatch(/^Bring Your Own/);
        expect(list.find((n) => n.name === 'testnet')?.passphrase).toBe(Networks.TESTNET);
    });
});

describe('pinned deployments', () => {
    it('are keyed by the SDK network passphrases', () => {
        expect(deploymentFor(Networks.PUBLIC).name).toBe('mainnet');
        expect(deploymentFor(Networks.TESTNET).name).toBe('testnet');
        expect(() => deploymentFor('Standalone Network ; February 2017')).toThrow(/mainnet and testnet only/);
    });
    it('pin only market contracts, of the right shape', () => {
        for (const dep of Object.values(DEPLOYMENTS)) {
            expect(dep.markets.length).toBeGreaterThan(0);
            for (const c of dep.markets) {
                expect(isContractAddress(c)).toBe(true);
                expect(c).toMatch(/^C[A-Z2-7]{55}$/);
            }
            expect(dep.api).toMatch(/^https:\/\//);
        }
    });
});
