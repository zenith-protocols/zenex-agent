# `stellar zenex` command reference

Global options, accepted by every command:

| Flag | Meaning | Default |
|---|---|---|
| `-n, --network <name>` | Stellar CLI network name | `STELLAR_NETWORK`, then `stellar network use`, then `testnet` |
| `--rpc-url <url>` + `--network-passphrase <p>` | explicit network instead of a name | — |
| `-s, --source-account <id>` | Stellar CLI identity, `G…` address (reads only) or secret | `STELLAR_ACCOUNT`, then `stellar keys use` |
| `--config-dir <dir>` | Stellar CLI config directory | `~/.config/stellar` |
| `-m, --market <id>` | market id (`xlm-usd`), pair (`XLM-USD`) or contract | first pinned market |
| `--json` | machine output; atomic values as strings | text |

Write options, accepted by every write command:

| Flag | Meaning |
|---|---|
| `--send` | sign and submit through `stellar contract invoke`. Without it: plan + simulation only. |
| `--build-only` | print a simulated, unsigned envelope to stdout for `stellar tx sign --sign-with-key <id> \| stellar tx send` |
| `--print` | print the `stellar …` command line and stop |
| `--slippage <percent>` | maximum adverse slippage; default `1`; above `5` needs `--force` |
| `--ttl <ledgers>` | order lifetime; one ledger ≈ 5 s; default `60` |
| `--wait` | with `--send`: poll (every 3 s, up to the order's TTL or 2 min) until the order leaves the resting set, then print the position, or `expired unfilled` |
| `--force` | override the plugin's caps |

## Reads

| Command | Output |
|---|---|
| `markets` | pinned markets: id, pair, market contract, collateral contract, RPC in use |
| `price` | bid, ask, mid, spread, observation time |
| `market` | status, max leverage, minimums, max position, keeper fee, vault minimum deposit, per side: open interest, capacity left, utilization, funding/borrow/net rate per hour; vault assets and share price |
| `position [--long\|--short]` | per open side: size (USD and base), entry, margin, leverage, pnl and net pnl, equity, pending funding/borrowing, liquidation price with distance and health, close fee, withdrawable margin, unlocked notional, attached exit order ids |
| `orders` | resting trade and vault orders: id, side, kind, size, margin, trigger, price bound, expiry ledger |
| `balance` | USDC (or `NO TRUSTLINE`), XLM, vault shares with their USDC value, claimable credit |
| `history` | position lifecycles (opened, closed, side, size, leverage, entry, exit, net pnl, reason); `--fills` for individual fills; `--trades` for the market-wide tape; `--limit <n>`, `--cursor <c>` |
| `candles` | OHLC; `--res 1m\|5m\|15m\|1h\|4h\|1d` (default 1h), `--count <n>` (default 48), `--from`/`--to` unix seconds or ISO-8601 |

## Writes

| Command | Required | Optional | Builds |
|---|---|---|---|
| `trustline` | — | — | `stellar tx new change-trust --line USDC:<issuer>` |
| `open` | `--long\|--short`, `--size <usd>`, `--leverage <x>` or `--margin <usd>` | slippage, ttl | `create_order` kind 0 (market increase), bound = entry side × (1 ± slippage) |
| `close` | `--long\|--short` | `--size <usd>` for a partial close, `--withdraw <usd>` margin out with it | `create_order` kind 3 (market decrease); full close uses the `FULL_CLOSE` sentinel |
| `limit` | side, `--size`, leverage or margin, `--at <price>` or `--away <pct>` (below the ask for a long, above the bid for a short) | slippage, ttl | `create_order` kind 1 (limit increase); a long fills at or below, a short at or above |
| `tp` | side, `--at <price>` or `--away <pct>` (on the profitable side of the current exit price) | `--size <usd>` (default whole position) | `create_order` kind 4 (limit decrease); refused if the trigger is on the wrong side |
| `sl` | side, `--at <price>` or `--away <pct>` (on the losing side) | `--size <usd>` | `create_order` kind 5 (stop decrease); refused if the trigger is on the wrong side |
| `margin add <usd>` / `margin withdraw <usd>` | side | — | `create_order` with notional 0 |
| `cancel --id <n>` | id from `orders` | — | `cancel_order` or `cancel_vault_order`; escrow refunded |
| `claim` | — | — | `claim_credit` |
| `deposit <usd>` | amount ≥ vault minimum | slippage | `create_vault_order` kind 0 with `min_out` from the share price |
| `redeem <shares>` or `redeem --all` | — | slippage | `create_vault_order` kind 1 |

Every write prints a plan to stderr, then on stdout either `simulation ok: order id N (would be allocated on send)` or `sent: order id N` with an explorer link. With `--json` the whole outcome (plan, preview, return value, link, command) is one object on stdout.

The preview runs the identical order through the SDK's exact fill engine before anything is simulated or sent: outcome `fills` (execution price, fees, escrow, resulting position), `rests` (creates and waits), or an error naming the contract gate.

## JSON shapes

- `price --json`: `{ bid, ask, mid }` as 18-dec strings, `decimal: { bid, ask, mid }` as numbers, `observedAt`.
- `position --json`: `{ account, market, network, ledger, price: { bid, ask }, positions: [ { side, raw: { margin, notional, tokens, lockedNotional, unlocksAt, pricedAt, decreaseOrders }, estimate: { notional, tokens, margin, leverage, entryPrice, pnl, netPnl, netPnlPercent, equity, liquidationPrice, liquidationDistancePercent, healthFactor, closeFee, maxWithdrawableMargin, unlockedNotional, pendingFunding, pendingBorrowing } } ] }` — `estimate` values are human numbers.
- `orders --json`: `{ orders: [ { id, type: 'order' | 'vaultOrder', order: { … atomic fields … } } ] }`.
- `balance --json`: `{ collateral, hasTrustline, xlm, vaultShares, escrowedShares, escrowedDeposits, claimableCredit, decimals }` (atomic strings).
- write commands `--json`: `{ mode: 'simulated' | 'sent', returnValue, explorer, plan, preview, command }`.
- `history --json` / `--fills` / `--trades`: the API page `{ items, nextCursor }` verbatim (see `api.md`).
