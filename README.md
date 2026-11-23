[![make.fun](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)
[![Rank](https://make.fun/badge/btc-race-24h-20261123-0511/Alfani03/btc-race-24h-20261123-0511/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)
[![Reward](https://make.fun/badge/btc-race-24h-20261123-0511/Alfani03/btc-race-24h-20261123-0511/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)
[Race a BTC trading bot live for 24 hours](https://make.fun/bounty/btc-race-24h-20261123-0511)

# BTC Race Bot — cbBTC/USDC, 1-minute bars

Slow trend-follower for the make.fun bounty `btc-race-24h-20261123-0511`
("Race a BTC trading bot live for 24 hours"). Long only, no leverage, one
position, paper money $1,000. Single self-contained file, Node 22 standard
library only, fully deterministic (no network, no clock, no randomness).

## Why this shape

Measured on the frozen dev window (1,440 bars) before writing the bot:

- cbBTC drifts up +3.64% in 24h, but 1-minute noise (~8 bps) dwarfs the trend
  (~0.25 bps/min), and 177 bars are flat. Buy-and-hold makes +$32.17 with
  1 trade; the fast EMA-cross baseline loses -$114.83 on 76 whipsaw trades.
  A full-size round trip costs ~30–46 bps at these pool depths, so trading
  often is what loses. The bot therefore trades rarely and holds through noise.

## Rules

- **Entry:** EMA(30) above EMA(120) on 1-minute closes **and** the 60-minute
  return positive. Both must agree.
- **Exit (whole position):** close 3% below the highest close since entry
  (trailing stop), **or** 240-minute return below -2%, **or** equity 12%
  below its peak (backstop, inside the race's 25% max-drawdown guardrail).
  A rejected sell is retried every bar while its reason holds.
- **Re-entry:** only after 240 bars out, with the entry conditions fresh.
- **Late probe:** if no fill by bar 1200 and the 60-minute return is above
  -1%, buy half the cash, so the entry still meets the race minimum of
  1 trade even in a steady downtrend window.
- **Sizing:** a normal entry spends all cash; the probe spends half. At most
  1 order per reply (cap is 16). Slippage cap 300 bps per order.
- Flat bars are ordinary bars; a minute with no CBBTC bar updates nothing.

## Grade locally

From the kit folder:

```sh
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> --driver process
```

Dev-gate target: net PnL above $0 after all fees, with max drawdown under 25%.
