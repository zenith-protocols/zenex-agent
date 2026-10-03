# zenex-agent

Tooling for bots and AI agents that trade [Zenex](https://zenex.trade) perpetuals on Stellar.

- **`stellar zenex`** — a [Stellar CLI plugin](https://developers.stellar.org/docs/tools/cli/plugins). Human units in (`--size 50 --leverage 5`), exact contract calls out. It previews every order through the SDK's fill engine, prints a plan, and runs `stellar contract invoke`, so identities, networks and signing stay in the Stellar CLI. Nothing is sent without `--send`.
- **`skills/zenex`** — an [agent skill](https://skills.stellar.org) that teaches an AI agent to use it safely.

## Install

```bash
npm install -g @zenith-protocols/stellar-zenex   # `stellar-zenex` on PATH → `stellar zenex`
stellar zenex --help
```

From this checkout: `npm install && npm link`.

The skill, for Claude Code: `/plugin marketplace add zenith-protocols/zenex-agent`; for other agents: `npx skills add https://github.com/zenith-protocols/zenex-agent`.

## Use

```bash
stellar keys generate bot --network testnet --fund && stellar keys use bot && stellar network use testnet
stellar zenex trustline --send                    # classic account: USDC trustline, once
stellar zenex balance                             # XLM, USDC, vault shares, credit

stellar zenex price
stellar zenex market
stellar zenex open --long --size 50 --leverage 5  # plan + simulate
stellar zenex open --long --size 50 --leverage 5 --send --wait   # waits for the keeper, prints the position
stellar zenex tp --long --away 20 --ttl 17000 --send              # take-profit 20% above
stellar zenex sl --long --away 10 --ttl 17000 --send              # stop-loss 10% below
stellar zenex close --long --send --wait                          # sweeps the attached exits
stellar zenex history
```

Every write prints the plan (network, account, size, leverage, max fill price, expiry, fees and resulting position from the preview) and the exact `create_order` arguments. `--print` shows the `stellar contract invoke` line; `--build-only` emits a simulated, unsigned envelope for `stellar tx sign … | stellar tx send`; `--json` gives one object for programs.

Guardrails: slippage defaults to 1% and refuses more than 5% without `--force`; orders the fill engine would reject (too much leverage, inside the post-fill lock, below a minimum) never leave the machine; the network is named in capitals in every plan.

## How it resolves

Everything the Stellar CLI knows, the plugin asks it for: the network comes from `-n`, else `stellar env STELLAR_NETWORK` (the environment or `stellar network use`), else `testnet`, and its RPC and passphrase from `stellar network ls -l`; the account from `-s`, else `stellar env STELLAR_ACCOUNT`, and its address from `stellar keys address`. The built-in `mainnet` has no RPC, so mainnet needs one `stellar network add mainnet --rpc-url <url> --network-passphrase "Public Global Stellar Network ; September 2015"` (or `--rpc-url` + `--network-passphrase` on the call).

The plugin pins only the market contracts per network passphrase (`src/networks.ts`) and the Zenex API origin. Vault, collateral, feed id and decimals are read from the market contract; the pair name comes from the API's ticker and the quote symbol from the collateral asset itself. `-m` takes a contract address (any market, pinned or not) or the id the API lists (`xlm-usd`).

## Layout

```
bin/stellar-zenex.js      plugin entry
src/cli.ts                commands and flags
src/networks.ts           pinned market contracts per network
src/stellar.ts            asks the Stellar CLI for network/account, runs it
src/context.ts            session + chain snapshot + price
src/units.ts              every human ↔ atomic conversion
src/read.ts  src/write.ts the commands
src/api.ts  src/token.ts  Zenex HTTP API, collateral asset
skills/zenex/             SKILL.md + references
.claude-plugin/           Claude Code marketplace manifests
```

Built on `@zenith-protocols/zenex-sdk` (exact contract math) and `@stellar/stellar-sdk`. Node ≥ 20.

## Develop

```bash
npm install
npm run build
npm test
```

Testnet is the place to try things: `stellar keys generate … --fund` gives XLM, and testnet USDC comes from the Zenex testnet faucet in the app.
