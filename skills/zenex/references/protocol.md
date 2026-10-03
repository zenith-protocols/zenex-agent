# The protocol behind the plugin

What `stellar zenex` encodes, for reading raw chain data or auditing a plan. Do not hand-build these calls for trading; the plugin exists so nobody has to.

## Deployments

| Network | Market XLM-USD | Collateral (USDC SAC) | Vault | API |
|---|---|---|---|---|
| mainnet | `CAOZCITWHWAXH5FRU4EULQ5EN2HMTCHICRNC4R5ZAOVD7XHCCQSJ42IB` | `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75` | `CB2MX4WXJHOHCTDTN5DCFC7G3TLFLOYLCRCINPK7G2A3EUVW2AYVA56N` | `https://api.zenex.trade` |
| testnet | `CCOIDO46A4HHBOQQSHKY3RC6BM6HE3V7UMYNICG7PA7ABS422W672F6U` | `CD4MP2QV4LABFU5OL6Y5RICCLQIX7TWT6T6J546EDYVUXHH6RS2V5S2O` | `CCKXT53FROOVQOMFWTOM5F3UHRXBX7CYAZKLPZ4GZ3WOD7XZBFQ2VNF4` | `https://api-testnet.zenex.trade` |

The plugin pins only the market contracts; `stellar zenex markets` prints them with the collateral and vault the API lists. Vault, collateral, feed id and decimals are read from the market contract itself (`get_vault`, `get_token`, `get_feed`). The full public record is at https://docs.zenex.trade/deployments.

## Units

| Quantity | Encoding | Example |
|---|---|---|
| sizes, margin, fees, balances | collateral token decimals (USDC: 7) | 50 USDC = `500000000` |
| prices (`trigger_price`, `price_bound`, report prices) | 18 decimals | 0.2150 = `215000000000000000` |
| vault shares | collateral decimals + 6 (13) | 1 share = `10000000000000` |
| slippage | basis points | 1% = `100` |
| expiration | ledger sequence number (≈5 s per ledger) | now + 60 ≈ 5 min |
| `FULL_CLOSE` | `2^127 − 1` as `notional` on a decrease | close the whole position whatever its size |

Configuration ratios in `get_config` (margins, fees, utilization caps) are 18-decimal fractions: `init_margin = 50000000000000000` is 5% (20× max leverage).

## Trader entry points on the market contract

All take primitive arguments, so `stellar contract invoke --id <market> … -- <fn> --help` generates the CLI from the on-chain spec.

| Function | Arguments | Notes |
|---|---|---|
| `create_order` | `user, is_long, kind:u32, notional, margin, trigger_price, price_bound, expiration:u32` → order id | escrows `margin + exec_fee` on an increase, `exec_fee` on a decrease; gated only by `user.require_auth()` |
| `cancel_order` | `user, id` → refunded escrow | |
| `create_vault_order` | `user, kind:u32 (0 deposit, 1 redeem), amount, min_out` → id | |
| `cancel_vault_order` | `user, id` | |
| `claim_credit` | `user` → paid amount | |
| `get_config`, `get_market_data`, `get_status`, `get_adl` | — | views; use `--send=no` |
| `get_position` | `user, is_long` | zeroed struct when none |
| `get_order` / `get_vault_order` | `user, id` | traps when absent |
| `get_order_counter` | `user` | next id; `1` means no order ever |
| `get_claimable_credit` | `user` | |

Order kinds: `0` market increase, `1` limit increase, `2` stop increase, `3` market decrease, `4` limit decrease (take-profit), `5` stop decrease (stop-loss). `trigger_price` is `0` for market kinds; `price_bound` is `0` for unbounded (never do that).

`price_bound` direction: an increase on a long or a decrease on a short is bounded from above (`price × (1 + slippage)`); a decrease on a long or an increase on a short from below (`price × (1 − slippage)`). For trigger kinds the bound is measured from the trigger price.

## Fills

Keepers call `execute_order(keeper, user, id, price_report)` with a signed Chainlink Data Streams report. The call is permissionless; `keeper` only names the reward recipient. A market order fills at the first verified price inside its bound, usually the next ledger. Atomic create-and-fill exists (`create_and_fill` on the router) but needs a report, which requires Data Streams credentials or the Zenex relay; a keypair bot does not need it.

Status: `0` active, `1` on-ice (opens blocked), `2` frozen, `3` delisted, `4` retired.

Market contract errors seen in practice: `713` equity below initial margin, `721` decrease exceeds unlocked notional (30 s lock after a fill), `731` order expired, `732` invalid order (minimums, bad combination), `782` stale price (keeper side).

## Source

- SDK (TypeScript, exact contract math): https://github.com/zenith-protocols/zenex-sdk-js
- Docs: https://docs.zenex.trade (`/technical` for every contract function and event)
