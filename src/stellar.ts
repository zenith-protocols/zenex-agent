/**
 * The Stellar CLI is the source of truth for networks, identities and
 * signing. This module reads the same configuration the CLI reads
 * (`~/.config/stellar`, the `STELLAR_*` environment) so `stellar zenex`
 * resolves exactly what `stellar contract invoke` would, and runs the CLI
 * as a subprocess for every transaction. No key ever enters this process.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { NETWORKS, pinForPassphrase, type NetworkPin } from './networks.js';

/** Built-in networks of the Stellar CLI (`stellar network ls`). */
const BUILTIN: Record<string, { rpc: string | undefined; passphrase: string }> = {
    testnet: { rpc: NETWORKS.testnet.defaultRpc, passphrase: NETWORKS.testnet.passphrase },
    mainnet: { rpc: undefined, passphrase: NETWORKS.mainnet.passphrase },
    futurenet: { rpc: 'https://rpc-futurenet.stellar.org:443', passphrase: 'Test SDF Future Network ; October 2022' },
    local: { rpc: 'http://localhost:8000/rpc', passphrase: 'Standalone Network ; February 2017' },
};

export interface GlobalOptions {
    network?: string;
    rpcUrl?: string;
    networkPassphrase?: string;
    sourceAccount?: string;
    configDir?: string;
}

export interface ResolvedNetwork {
    /** The Zenex deployment on this network. */
    pin: NetworkPin;
    /** Name as the Stellar CLI knows it, when it does. */
    name: string | undefined;
    rpc: string;
    passphrase: string;
    /** Arguments that make the Stellar CLI resolve the same network. */
    cliArgs: string[];
}

export interface ResolvedAccount {
    /** What the user passed or configured: an identity name, G-address or secret. */
    ref: string;
    /** The public key the contract sees as `user`. */
    address: string;
    /** Arguments that make the Stellar CLI sign with the same account. */
    cliArgs: string[];
}

/** The Stellar CLI config directory: `--config-dir`, `$XDG_CONFIG_HOME/stellar`, or `~/.config/stellar`. */
export function configDir(opts: GlobalOptions): string {
    if (opts.configDir) return opts.configDir;
    const xdg = process.env['XDG_CONFIG_HOME'];
    return xdg ? join(xdg, 'stellar') : join(homedir(), '.config', 'stellar');
}

/**
 * The tiny TOML subset the CLI writes: `key = "string"`, `key = 123`,
 * `key = []`, and `[section]` headers. Enough to read defaults and networks.
 */
export function parseToml(text: string): Record<string, Record<string, string>> {
    const out: Record<string, Record<string, string>> = { '': {} };
    let section = '';
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (line === '' || line.startsWith('#')) continue;
        const header = /^\[([^\]]+)\]$/.exec(line);
        if (header) {
            section = header[1] ?? '';
            out[section] ??= {};
            continue;
        }
        const kv = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
        if (!kv) continue;
        let value = (kv[2] ?? '').trim();
        if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
        (out[section] ??= {})[kv[1] ?? ''] = value;
    }
    return out;
}

function readTomlFile(path: string): Record<string, Record<string, string>> | undefined {
    if (!existsSync(path)) return undefined;
    return parseToml(readFileSync(path, 'utf8'));
}

function defaults(opts: GlobalOptions): { network?: string; identity?: string } {
    const cfg = readTomlFile(join(configDir(opts), 'config.toml'));
    return {
        network: cfg?.['defaults']?.['network'],
        identity: cfg?.['defaults']?.['identity'],
    };
}

/** Resolve the network the way the Stellar CLI does, then find the Zenex deployment on it. */
export function resolveNetwork(opts: GlobalOptions): ResolvedNetwork {
    const env = process.env;
    const explicitRpc = opts.rpcUrl ?? env['STELLAR_RPC_URL'];
    const explicitPassphrase = opts.networkPassphrase ?? env['STELLAR_NETWORK_PASSPHRASE'];

    if (explicitRpc && explicitPassphrase) {
        const pin = pinForPassphrase(explicitPassphrase);
        if (!pin) throw unsupported(explicitPassphrase);
        return {
            pin,
            name: undefined,
            rpc: explicitRpc,
            passphrase: explicitPassphrase,
            cliArgs: ['--rpc-url', explicitRpc, '--network-passphrase', explicitPassphrase],
        };
    }

    const name = opts.network ?? env['STELLAR_NETWORK'] ?? defaults(opts).network ?? 'testnet';
    const file = readTomlFile(join(configDir(opts), 'network', `${name}.toml`));
    let rpc = file?.['']?.['rpc_url'];
    let passphrase = file?.['']?.['network_passphrase'];
    if (!file) {
        const builtin = BUILTIN[name];
        if (!builtin) {
            throw new Error(
                `unknown network "${name}": add it with \`stellar network add ${name} --rpc-url … --network-passphrase …\` or pass --network mainnet|testnet`,
            );
        }
        rpc = builtin.rpc;
        passphrase = builtin.passphrase;
    }
    if (!passphrase) throw new Error(`network "${name}" has no network_passphrase configured`);
    const pin = pinForPassphrase(passphrase);
    if (!pin) throw unsupported(passphrase);

    // The CLI's built-in mainnet has no RPC ("bring your own"). Fall back to
    // the pinned public endpoint and hand the CLI the explicit pair so it
    // resolves without a `stellar network add`.
    if (!rpc) {
        rpc = pin.defaultRpc;
        return { pin, name, rpc, passphrase, cliArgs: ['--rpc-url', rpc, '--network-passphrase', passphrase] };
    }
    return { pin, name, rpc, passphrase, cliArgs: ['--network', name] };
}

function unsupported(passphrase: string): Error {
    return new Error(`Zenex is deployed on mainnet and testnet only (network passphrase "${passphrase}")`);
}

/** Resolve the signing account the way the Stellar CLI does, and its public address. */
export async function resolveAccount(opts: GlobalOptions): Promise<ResolvedAccount> {
    const ref = opts.sourceAccount ?? process.env['STELLAR_ACCOUNT'] ?? defaults(opts).identity;
    if (!ref) {
        throw new Error(
            'no account: pass --source-account <identity|G…>, set STELLAR_ACCOUNT, or run `stellar keys use <identity>`',
        );
    }
    return { ref, address: await addressOf(ref, opts), cliArgs: ['--source-account', ref] };
}

/** The public key behind an identity name, G-address, or secret seed. */
export async function addressOf(ref: string, opts: GlobalOptions): Promise<string> {
    if (StrKey.isValidEd25519PublicKey(ref)) return ref;
    if (StrKey.isValidEd25519SecretSeed(ref)) return Keypair.fromSecret(ref).publicKey();
    const { stdout } = await runStellar(['keys', 'address', ref, ...configDirArgs(opts)], { quiet: true });
    const address = stdout.trim();
    if (!StrKey.isValidEd25519PublicKey(address)) {
        throw new Error(`could not resolve identity "${ref}" (stellar keys address): ${address}`);
    }
    return address;
}

export function configDirArgs(opts: GlobalOptions): string[] {
    return opts.configDir ? ['--config-dir', opts.configDir] : [];
}

export interface RunResult {
    stdout: string;
    stderr: string;
    code: number;
}

/**
 * Run the Stellar CLI. stdout is captured (return values, XDR); stderr is
 * captured and, unless `quiet`, echoed live so the CLI's own progress lines
 * (signing, explorer link, events) reach the terminal.
 */
export function runStellar(args: string[], options: { quiet?: boolean } = {}): Promise<RunResult> {
    const bin = process.env['STELLAR_BIN'] ?? 'stellar';
    return new Promise((resolve, reject) => {
        const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
        child.stderr.on('data', (chunk: Buffer) => {
            const text = chunk.toString();
            stderr += text;
            if (!options.quiet) process.stderr.write(text);
        });
        child.on('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'ENOENT') {
                reject(new Error(`"${bin}" not found: install the Stellar CLI (https://developers.stellar.org/docs/tools/cli) or set STELLAR_BIN`));
            } else reject(err);
        });
        child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    });
}

/** Render an argv for display, quoting only what the shell would need. */
export function shellQuote(args: string[]): string {
    return args.map((a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
}
