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
stellar zenex open --long --size 50 --leverage 5 --send
stellar zenex position
stellar zenex tp --long --at 0.26 --ttl 17000 --send
stellar zenex close --long --send
stellar zenex history
```

Every write prints the plan (network, account, size, leverage, max fill price, expiry, fees and resulting position from the preview) and the exact `create_order` arguments. `--print` shows the `stellar contract invoke` line; `--build-only` emits a simulated, unsigned envelope for `stellar tx sign … | stellar tx send`; `--json` gives one object for programs.

Guardrails: slippage defaults to 1% and refuses more than 5% without `--force`; orders the fill engine would reject (too much leverage, inside the post-fill lock, below a minimum) never leave the machine; the network is named in capitals in every plan.

## How it resolves

Network: `-n`, else `STELLAR_NETWORK`, else `stellar network use`, else `testnet`; `~/.config/stellar/network/<name>.toml` supplies the RPC, and the built-in `mainnet` (which has none) falls back to a public endpoint. Account: `-s`, else `STELLAR_ACCOUNT`, else `stellar keys use`; the address comes from `stellar keys address`. Markets are pinned per network in `src/networks.ts` — a new market is a new release.

## Layout

```
bin/stellar-zenex.js      plugin entry
src/cli.ts                commands and flags
src/networks.ts           pinned deployments
src/stellar.ts            Stellar CLI config resolution and subprocess
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
