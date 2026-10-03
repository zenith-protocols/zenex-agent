/**
 * `stellar zenex` — a Stellar CLI plugin. Any executable named `stellar-zenex`
 * on PATH is reachable as `stellar zenex …`; the Stellar CLI itself keeps the
 * identities, networks and signing.
 */
import { Command, Option } from 'commander';
import { cmdBalance, cmdCandles, cmdHistory, cmdMarket, cmdMarkets, cmdOrders, cmdPosition, cmdPrice } from './read.js';
import { cmdCancel, cmdClaim, cmdClose, cmdLimit, cmdMargin, cmdOpen, cmdStopLoss, cmdTakeProfit, cmdTrustline, cmdVault } from './write.js';

const VERSION = '0.1.0';

function globals(cmd: Command): Command {
    return cmd
        .option('-n, --network <name>', 'Stellar CLI network name (default: STELLAR_NETWORK or `stellar network use`)')
        .option('--rpc-url <url>', 'RPC endpoint (with --network-passphrase)')
        .option('--network-passphrase <passphrase>', 'network passphrase (with --rpc-url)')
        .option('-s, --source-account <identity>', 'Stellar CLI identity, G-address or secret (default: STELLAR_ACCOUNT or `stellar keys use`)')
        .option('--config-dir <dir>', 'Stellar CLI config directory')
        .option('-m, --market <id>', 'market id, pair or contract (default: the first pinned market, xlm-usd)')
        .option('--json', 'machine-readable output (atomic values as strings)');
}

function writeFlags(cmd: Command): Command {
    return globals(cmd)
        .option('--send', 'sign and submit (default: plan + simulate only)')
        .option('--build-only', 'print the unsigned transaction XDR for `stellar tx sign | stellar tx send`')
        .option('--print', 'print the `stellar contract invoke` command and stop')
        .option('--slippage <percent>', 'max adverse slippage in percent (default 1; above 5 needs --force)')
        .option('--ttl <ledgers>', 'order lifetime in ledgers, ~5s each (default 60)')
        .option('--force', 'override the safety caps');
}

function sideFlags(cmd: Command): Command {
    return cmd.option('--long', 'the long side').option('--short', 'the short side');
}

function sizeFlags(cmd: Command): Command {
    return cmd
        .requiredOption('--size <quote>', 'position size in quote currency (USD), e.g. 50')
        .option('--leverage <x>', 'leverage, e.g. 5 (margin = size / leverage)')
        .option('--margin <quote>', 'margin to post instead of --leverage');
}

export async function main(argv: string[]): Promise<void> {
    const program = new Command('stellar zenex')
        .description('Trade Zenex perpetuals from the Stellar CLI. Human units in, exact contract calls out; keys and signing stay in `stellar`.')
        .version(VERSION)
        .configureHelp({ sortSubcommands: false })
        .showHelpAfterError();

    // Reads
    globals(program.command('markets').description('pinned markets on the resolved network')).action(cmdMarkets);
    globals(program.command('price').description('live bid / ask / mid for the market')).action(cmdPrice);
    globals(program.command('market').description('market state: open interest, rates, capacity, limits')).action(cmdMarket);
    sideFlags(globals(program.command('position').description('your open position(s): size, leverage, pnl, liquidation price'))).action(cmdPosition);
    globals(program.command('orders').description('your resting orders (trade and vault)')).action(cmdOrders);
    globals(program.command('balance').description('collateral, XLM, vault shares and claimable credit')).action(cmdBalance);
    globals(program.command('history').description('your closed and open position lifecycles (indexed)'))
        .option('--fills', 'individual fills instead of lifecycles')
        .option('--trades', 'the whole market\'s recent fills instead of yours')
        .option('--limit <n>', 'rows (default 20, max 200)')
        .option('--cursor <cursor>', 'next page cursor from the previous call')
        .action(cmdHistory);
    globals(program.command('candles').description('OHLC candles'))
        .option('--res <resolution>', '1m 5m 15m 1h 4h 1d (default 1h)')
        .option('--count <n>', 'how many candles back from --to (default 48)')
        .option('--from <time>', 'unix seconds or ISO-8601')
        .option('--to <time>', 'unix seconds or ISO-8601 (default now)')
        .action(cmdCandles);

    // Writes
    writeFlags(program.command('trustline').description('add the collateral trustline a fresh classic account needs before it can hold USDC')).action(cmdTrustline);
    sizeFlags(sideFlags(writeFlags(program.command('open').description('open or increase a position at market')))).action(cmdOpen);
    sideFlags(writeFlags(program.command('close').description('close a position at market (fully, or --size for part)')))
        .option('--size <quote>', 'notional to close; omit for a full close')
        .option('--withdraw <quote>', 'margin to withdraw with a partial close')
        .action(cmdClose);
    sizeFlags(sideFlags(writeFlags(program.command('limit').description('open when the price reaches a level'))))
        .requiredOption('--at <price>', 'limit price in quote (a long fills at or below, a short at or above)')
        .action(cmdLimit);
    sideFlags(writeFlags(program.command('tp').description('take-profit: close when the price moves in your favour to a level')))
        .requiredOption('--at <price>', 'trigger price')
        .option('--size <quote>', 'notional to close; omit for the whole position')
        .action(cmdTakeProfit);
    sideFlags(writeFlags(program.command('sl').description('stop-loss: close when the price moves against you to a level')))
        .requiredOption('--at <price>', 'trigger price')
        .option('--size <quote>', 'notional to close; omit for the whole position')
        .action(cmdStopLoss);
    const margin = program.command('margin').description('add or withdraw margin on an open position');
    sideFlags(writeFlags(margin.command('add <quote>').description('add margin'))).action((amount: string, opts) => cmdMargin('add', amount, opts));
    sideFlags(writeFlags(margin.command('withdraw <quote>').description('withdraw margin'))).action((amount: string, opts) => cmdMargin('withdraw', amount, opts));
    writeFlags(program.command('cancel').description('cancel a resting order; the escrow is refunded'))
        .requiredOption('--id <id>', 'order id from `stellar zenex orders`')
        .action(cmdCancel);
    writeFlags(program.command('claim').description('pay out your claimable credit')).action(cmdClaim);
    writeFlags(program.command('deposit <quote>').description('deposit collateral into the LP vault (a keeper fills it)')).action((amount: string, opts) => cmdVault('deposit', amount, opts));
    writeFlags(program.command('redeem [shares]').description('redeem vault shares for collateral'))
        .addOption(new Option('--all', 'redeem every share you hold'))
        .action((amount: string | undefined, opts) => cmdVault('redeem', amount, opts));

    await program.parseAsync(argv);
}
