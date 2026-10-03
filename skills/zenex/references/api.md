# Public HTTP API

Origins: `https://api.zenex.trade` (mainnet), `https://api-testnet.zenex.trade` (testnet). No key. Read routes are limited to 100 requests per minute per IP; price routes have no limiter but sit behind a 200-per-10-s edge rule. CORS `*` on reads.

| Route | Returns | Plugin command |
|---|---|---|
| `GET /v1/config` | router, fee forwarder, markets (contracts, feed id, decimals), smart-account config | — (addresses are pinned in the plugin) |
| `GET /v1/prices/tickers` | per market: `price`, `bid`, `ask` as 18-decimal strings, `observationsTimestamp` | `price` |
| `GET /v1/prices/udf/history?symbol=XLMUSD&resolution=60&from=&to=` | TradingView UDF bars `{s,t,o,h,l,c}`; resolutions `1 5 15 60 240 1D` | `candles` |
| `GET /v1/markets/{id}/trades?limit=&cursor=` | anonymised fill tape | `history --trades` |
| `GET /v1/markets/{id}/observations?from=&to=&bucketSeconds=` | price, open interest, funding and borrowing rates over time | — |
| `GET /v1/markets/{id}/rates` | current rates | — |
| `GET /v1/accounts/{G…}/trade/fills?market=&limit=&cursor=` | your fills with fees and pnl (`…Atomic` strings, 7-dec; prices 18-dec) | `history --fills` |
| `GET /v1/accounts/{G…}/trade/lifecycles` | your positions from open to close (`size`, `leverage`, `entryPrice`, `exitPrice` as decimal strings; pnl atomic) | `history` |
| `GET /v1/accounts/{G…}/trade/orders` | your orders as indexed | — |
| `GET /v1/accounts/{G…}/vault/orders`, `/vault/fills` | vault activity | — |
| `GET /v1/leaderboards/rolling/{window}` | rolling pnl leaderboards | — |

Pagination: `limit` (max 200) and an opaque `nextCursor` to pass back as `cursor`.

What the API does **not** serve: signed price reports (fills need one; keepers hold Data Streams credentials) and the live position itself — read that from the chain with `stellar zenex position`, which is exact.
