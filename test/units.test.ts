import { describe, expect, it } from 'vitest';
import { marginForLeverage, parseAmount, parseLeverage, parsePercentBps, parsePrice } from '../src/units.js';
import { parseToml } from '../src/stellar.js';
import { findMarket, NETWORKS, pinForPassphrase } from '../src/networks.js';

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

describe('stellar cli config', () => {
    it('reads the defaults and network files the CLI writes', () => {
        const cfg = parseToml('[defaults]\nnetwork = "mainnet"\nidentity = "bot"\n');
        expect(cfg['defaults']).toEqual({ network: 'mainnet', identity: 'bot' });
        const net = parseToml('rpc_url = "https://rpc.example"\nrpc_headers = []\nnetwork_passphrase = "Test SDF Network ; September 2015"\n');
        expect(net['']?.['rpc_url']).toBe('https://rpc.example');
        expect(net['']?.['network_passphrase']).toBe('Test SDF Network ; September 2015');
    });
});

describe('pinned networks', () => {
    it('maps passphrases to deployments and resolves markets by id, pair or contract', () => {
        expect(pinForPassphrase(NETWORKS.testnet.passphrase)?.key).toBe('testnet');
        expect(pinForPassphrase('Standalone Network ; February 2017')).toBeUndefined();
        const m = NETWORKS.mainnet.markets[0]!;
        expect(findMarket(NETWORKS.mainnet, 'XLM-USD')).toBe(m);
        expect(findMarket(NETWORKS.mainnet, m.market)).toBe(m);
        expect(findMarket(NETWORKS.mainnet, undefined)).toBe(m);
        expect(() => findMarket(NETWORKS.mainnet, 'btc-usd')).toThrow(/unknown market/);
    });
    it('pins contract addresses of the right shape', () => {
        for (const net of Object.values(NETWORKS)) {
            for (const m of net.markets) {
                for (const addr of [m.market, m.vault, m.collateral]) expect(addr).toMatch(/^C[A-Z2-7]{55}$/);
                expect(m.feedId).toMatch(/^0x0003[0-9a-f]{60}$/);
            }
        }
    });
});
