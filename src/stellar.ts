/**
 * The Stellar CLI owns networks, identities and signing. This module asks
 * it for what it resolved (`stellar env`, `stellar network ls -l`,
 * `stellar keys address`) instead of re-reading its configuration, and runs
 * it as a subprocess for every transaction. No key ever enters this process.
 */
import { spawn } from 'node:child_process';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { deploymentFor, type Deployment } from './networks.js';

export interface GlobalOptions {
    network?: string;
    rpcUrl?: string;
    networkPassphrase?: string;
    sourceAccount?: string;
    configDir?: string;
}

export interface ResolvedNetwork {
    /** The Zenex deployment on this network. */
    dep: Deployment;
    /** Name as the Stellar CLI knows it, when resolved by name. */
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

export function configDirArgs(opts: GlobalOptions): string[] {
    return opts.configDir ? ['--config-dir', opts.configDir] : [];
}

/** `stellar env NAME`: the value the CLI resolved from the environment or its `use` defaults, or undefined. */
async function cliEnv(name: string, opts: GlobalOptions): Promise<string | undefined> {
    const { stdout, code } = await runStellar(['env', name, ...configDirArgs(opts)], { quiet: true });
    const value = stdout.trim();
    return code === 0 && value !== '' ? value : undefined;
}

/** `stellar network ls -l`, parsed: every configured and built-in network the CLI knows. Configured entries come first and shadow built-ins. */
export async function listNetworks(opts: GlobalOptions): Promise<{ name: string; rpc: string; passphrase: string }[]> {
    const { stdout, code, stderr } = await runStellar(['network', 'ls', '-l', ...configDirArgs(opts)], { quiet: true });
    if (code !== 0) throw new Error(`stellar network ls failed: ${stderr.trim()}`);
    return parseNetworkList(stdout);
}

export function parseNetworkList(text: string): { name: string; rpc: string; passphrase: string }[] {
    const out: { name: string; rpc: string; passphrase: string }[] = [];
    let current: { name?: string; rpc?: string; passphrase?: string } = {};
    const flush = () => {
        if (current.name && current.rpc !== undefined && current.passphrase) {
            out.push({ name: current.name, rpc: current.rpc, passphrase: current.passphrase });
        }
        current = {};
    };
    for (const line of text.split('\n')) {
        const m = /^(Name|RPC url|Network passphrase):\s*(.*)$/.exec(line.trim());
        if (!m) continue;
        const [, key, value] = m;
        if (key === 'Name') {
            flush();
            current.name = value;
        } else if (key === 'RPC url') current.rpc = (value ?? '').trim();
        else if (key === 'Network passphrase') current.passphrase = (value ?? '').trim();
    }
    flush();
    return out;
}

/** Resolve the network exactly as the Stellar CLI would, then find the Zenex deployment on it. */
export async function resolveNetwork(opts: GlobalOptions): Promise<ResolvedNetwork> {
    const explicitRpc = opts.rpcUrl ?? process.env['STELLAR_RPC_URL'];
    const explicitPassphrase = opts.networkPassphrase ?? process.env['STELLAR_NETWORK_PASSPHRASE'];
    if (explicitRpc && explicitPassphrase) {
        return {
            dep: deploymentFor(explicitPassphrase),
            name: undefined,
            rpc: explicitRpc,
            passphrase: explicitPassphrase,
            cliArgs: ['--rpc-url', explicitRpc, '--network-passphrase', explicitPassphrase],
        };
    }
    if (explicitRpc || explicitPassphrase) {
        throw new Error('--rpc-url and --network-passphrase go together');
    }

    const name = opts.network ?? (await cliEnv('STELLAR_NETWORK', opts)) ?? 'testnet';
    const entry = (await listNetworks(opts)).find((n) => n.name === name);
    if (!entry) {
        throw new Error(
            `the Stellar CLI knows no network "${name}": \`stellar network ls\`, or \`stellar network add ${name} --rpc-url … --network-passphrase …\``,
        );
    }
    if (!/^https?:\/\//.test(entry.rpc)) {
        throw new Error(
            `network "${name}" has no RPC configured (${entry.rpc}). Configure one: \`stellar network add ${name} --rpc-url <url> --network-passphrase "${entry.passphrase}"\``,
        );
    }
    return { dep: deploymentFor(entry.passphrase), name, rpc: entry.rpc, passphrase: entry.passphrase, cliArgs: ['--network', name] };
}

/** Resolve the signing account exactly as the Stellar CLI would, and its public address. */
export async function resolveAccount(opts: GlobalOptions): Promise<ResolvedAccount> {
    const ref = opts.sourceAccount ?? (await cliEnv('STELLAR_ACCOUNT', opts));
    if (!ref) {
        throw new Error('no account: pass --source-account <identity|G…>, set STELLAR_ACCOUNT, or run `stellar keys use <identity>`');
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
        throw new Error(`could not resolve identity "${ref}" (stellar keys address): ${address || 'no such identity'}`);
    }
    return address;
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
