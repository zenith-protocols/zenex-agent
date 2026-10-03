---
name: zenex
description: Trade and monitor Zenex perpetuals (XLM-USD on Stellar, mainnet and testnet) through the `stellar zenex` CLI plugin — prices, candles, market state, positions, history, and orders (open, close, limit, take-profit, stop-loss, cancel, vault deposit/redeem) in human units, with a dry-run plan and fill preview before anything is sent. Use whenever a user wants a bot or an agent to trade, size, hedge, or watch Zenex, or asks about their Zenex position.
user-invocable: true
argument-hint: "[what to do on Zenex]"
---

# Zenex from the Stellar CLI

Zenex is a perpetual-futures DEX on Stellar. Positions are collateralised in USDC, sized in USD, and filled by keepers at a Chainlink-verified price. You never compute protocol units yourself: `stellar zenex` takes human amounts, derives the exact contract call, previews it through the same fill engine the chain runs, and hands the transaction to the Stellar CLI to sign and submit. Keys, networks and signing stay in `stellar`.

## Setup

```bash
stellar --version                     # Stellar CLI ≥ 23 (https://developers.stellar.org/docs/tools/cli)
npm install -g @zenith-protocols/stellar-zenex   # puts `stellar-zenex` on PATH → `stellar zenex …`
stellar zenex --help
```

Identity and network come from the Stellar CLI. Set defaults once, or pass `-s` / `-n` on every call:

```bash
stellar keys generate bot --network testnet --fund    # new identity (testnet: funded by friendbot)
stellar keys use bot
stellar network use testnet                            # or mainnet
```

A trading account needs **XLM** (network fees), the **USDC trustline**, and **USDC**:

```bash
stellar zenex trustline --send        # adds the collateral trustline (classic accounts only, once)
stellar zenex balance                 # shows XLM, USDC, vault shares, claimable credit
```

Mainnet: the Stellar CLI's built-in `mainnet` has no RPC; the plugin falls back to a public one. For your own, `stellar network add mainnet --rpc-url <url> --network-passphrase "Public Global Stellar Network ; September 2015"`.

## Rules

1. **Never hand-build a `create_order`.** Sizes are 7-decimal, prices 18-decimal, `price_bound` flips direction by side and kind — the plugin encodes all of it. If a command is missing, say so instead of calling the contract directly.
2. **Dry-run first.** Every write command without `--send` prints the plan (network, account, size, leverage, max fill price, expiry, preview with fees and liquidation price) and only simulates. Read it. Then add `--send`.
3. **Mainnet is real money.** Before any `--send` with `-n mainnet`, state the plan to the user and get a yes, unless they already authorised this exact trade. Say which network you are on in every status update.
4. **One action, then look.** After a send, wait ~10 s and run `stellar zenex position` (or `orders`) before deciding the next step. Keepers fill market orders within a ledger or two; never re-send a market order because the position has not updated yet.
5. **Keep slippage honest.** Default 1%. The plugin refuses `--slippage` above 5% without `--force`; do not pass `--force` unless the user asked for it.
6. **Parse with `--json`**, print with the default text. Atomic values in JSON are strings; human values are in the text output.
7. **Never print or log secrets.** Refer to accounts by identity name or public key.
8. **Respect the API**: price polling is fine every few seconds; history and candles are rate limited (100/min per IP).

## Commands

Read (no signing):

```bash
stellar zenex markets                      # pinned markets on the resolved network
stellar zenex price                        # bid / ask / mid
stellar zenex market                       # open interest, rates per hour, capacity, limits
stellar zenex position [--long|--short]    # size, entry, leverage, pnl, liquidation price, health
stellar zenex orders                       # resting orders with ids
stellar zenex balance
stellar zenex history [--fills] [--trades] [--limit 20]
stellar zenex candles --res 1h --count 48  # 1m 5m 15m 1h 4h 1d
```

Write (plan + simulate; add `--send` to submit):

```bash
stellar zenex open --long --size 50 --leverage 5            # 50 USD long at 5x (margin 10 USDC)
stellar zenex open --short --size 100 --margin 25           # size it by margin instead
stellar zenex close --long                                  # full close
stellar zenex close --long --size 20 --withdraw 2           # partial close, withdraw margin
stellar zenex limit --long --size 50 --leverage 3 --at 0.20 --ttl 2000
stellar zenex tp --long --at 0.26 --ttl 17000               # take-profit, standing for ~1 day
stellar zenex sl --long --at 0.19 --ttl 17000               # stop-loss
stellar zenex margin add 5 --long
stellar zenex cancel --id 8
stellar zenex deposit 100 / stellar zenex redeem --all      # LP vault
stellar zenex claim                                         # pay out claimable credit
```

Common flags: `-n <network>`, `-s <identity>`, `-m <market>`, `--slippage <pct>`, `--ttl <ledgers>` (≈5 s each, default 60), `--json`, `--print` (show the `stellar contract invoke` line), `--build-only` (unsigned XDR for `stellar tx sign --sign-with-key <id> | stellar tx send`).

A position can be read for any public key without a key: `stellar zenex position -s G…`.

## How fills work

- `open`/`close` create a *market order* that a keeper fills at the next verified price, usually within one ledger (~5 s). `price bound` in the plan is the worst price you accept; past it the order rests until the price comes back or it expires (`--ttl`).
- `limit`, `tp`, `sl` rest until the trigger price is crossed, then fill with the same slippage bound measured from the trigger. Give them a long `--ttl`.
- The preview says `fills` (with fees, execution price, resulting position) or `rests` (legitimate: waits for a keeper or a trigger). A rejected preview means the order can never fill at the current state; the message carries the contract error.
- Fees per fill: base + impact + a flat keeper fee (0.01 USDC) escrowed with the order. Funding and borrowing accrue hourly; `market` shows the rates, `position` shows what is pending.
- A freshly filled increase is locked for ~30 s (`unlocked notional` in `position`); a decrease inside the lock is rejected with error 721 — wait and retry.
- The vault: `deposit` needs the minimum shown in `market`; `redeem` waits out a lock (1 h on current markets) before a keeper fills it. Both rest in `orders` meanwhile and can be cancelled.

## Reading the numbers

- `size` is notional in USD (USDC); the base amount (XLM) is shown next to it.
- `leverage` = size / margin; `market` shows the maximum. Opening above it fails the preview (error 713).
- `liquidation price` and `health` (equity ÷ maintenance margin; below 1 is liquidatable) come from the exact contract math at the current price.
- Rates are **percent per hour**. `funding (pays)` means that side currently pays funding to the other.

## Errors you will meet

| Message | Meaning | Do |
|---|---|---|
| `error 713` equity below initial margin | too much leverage or too little margin | lower `--leverage` or raise `--margin` |
| `error 721` exceeds unlocked notional | decrease inside the 30 s post-fill lock | wait, retry |
| `error 732` invalid order | below a minimum (see `market`) or a bad combination | fix the amount |
| `slippage … above the 5% cap` | plugin guardrail | ask the user; `--force` only on their say-so |
| `NO TRUSTLINE` in `balance` | classic account cannot hold USDC yet | `stellar zenex trustline --send` |
| `no account` | nothing configured | `-s <identity>` or `stellar keys use` |
| `stellar contract invoke failed` | the chain rejected the transaction | read the diagnostic lines above it; do not retry blindly |

## References

- `references/commands.md` — every command and flag.
- `references/protocol.md` — the contract surface and encodings behind the plugin, for when you must read raw chain data.
- `references/api.md` — the public HTTP endpoints (prices, candles, history).
