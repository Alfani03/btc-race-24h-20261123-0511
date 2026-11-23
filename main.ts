// BTC race bot: slow trend-follower, long only, one position, few trades.
//
// Why this shape (measured on the dev window before writing it):
// - Dev window: cbBTC drifts up +3.64% in 24h (58,957 -> 61,102), but 1-minute
//   noise is ~8 bps against a trend of only ~0.25 bps per minute, and 177 of
//   1,440 bars are flat. Buy-and-hold makes +$32.17 with 1 trade; the fast
//   EMA-cross baseline loses -$114.83 on 76 whipsaw trades. Every extra round
//   trip costs ~30-46 bps at these pool depths, so trading often is what loses.
// - So: enter ONCE on a slow, confirmed uptrend, then hold through the noise
//   and exit only on a real breakdown. No re-entry churn: after an exit the bot
//   waits 240 bars before it may enter again.
// - Entry: EMA(30) above EMA(120) on 1-minute closes AND the 60-minute return
//   positive AND the close above EMA(120). All three must agree, so a
//   one-minute spike cannot trigger a buy, and a lagging cross after a sharp
//   drop cannot either.
// - Exit (whole position, retried every bar while the reason holds, so a
//   rejected sell is sent again): the close falls 3% below the highest close
//   since entry (trailing stop), OR the 240-minute return drops below -2%
//   (sustained breakdown), OR equity falls 12% below its peak (catastrophic
//   backstop, far inside the race guardrail of 25% max drawdown).
// - Guardrail probe: if no fill has happened by bar 1200 and the last 60
//   minutes are not in freefall (return above -1%), buy half the cash. A
//   steady downtrend window would otherwise leave the bot with zero trades,
//   which ranks below every entry that meets the 1-trade bar even at $0 PnL.
// - Sizing: a normal entry spends all cash (100% of equity); the probe spends
//   half. One order per reply at most, far under the 16-order cap.
// - Protocol: agent-fun/bars-replay/v1. hello, then one batch per minute, then
//   done. Every batch gets exactly one reply echoing its seq; orders decided
//   on a batch fill at the next bar's open. No network, no wall clock, no
//   randomness, no files: fully deterministic, same bars give same orders.
// - Flat bars (open = high = low = close) are ordinary bars: they update the
//   EMAs with an unchanged close. A minute with no CBBTC bar updates nothing
//   and sends no order on stale data.

import { createInterface } from "node:readline";

const SYMBOL = "CBBTC";
// Slippage cap per order, measured from the latest close: 3% is far above a
// normal 1-minute move (largest in dev: 0.72%) but stops a fill at a wild gap.
const MAX_SLIPPAGE_BPS = 300;
const FAST_SPAN = 30;
const SLOW_SPAN = 120;
const TRAIL_BPS = 300; // exit when close is 3% below the peak since entry
const EXIT_R240_BPS = -200; // exit when the 240-minute return is below -2%
const EQUITY_DD_BPS = 1200; // exit when equity is 12% below its peak
const REENTRY_COOLDOWN = 240; // bars to wait after an exit before re-entering
const PROBE_BAR = 1200; // late probe so a downtrend window still trades once
const PROBE_R60_BPS = -100; // probe only if the 60-minute return is above -1%

interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

function newEma(span: number): Ema {
  return { span, warm: [], value: null };
}

// Seed with the mean of the first `span` closes, then move 2 / (span + 1) of
// the way to each new close. Pure float64, deterministic.
function emaStep(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) {
    let sum = 0;
    for (const x of e.warm) sum += x;
    e.value = sum / e.span;
  }
}

interface HelloMsg {
  type: string;
  symbols: { symbol: string; price_scale: number; qty_scale: number }[];
  capital: { quote_units: string };
  warmup_bars?: number;
}

interface BarMsg {
  symbol: string;
  o: string;
  h: string;
  l: string;
  c: string;
}

interface FillMsg {
  client_id: string;
  side: string;
  status: string;
}

interface AccountMsg {
  cash_quote_units: string;
  positions: { symbol: string; qty: string; cost_quote_units: string }[];
  equity_quote_units: string;
}

interface BatchMsg {
  type: string;
  seq: number;
  bars: BarMsg[];
  fills: FillMsg[];
  account: AccountMsg;
}

type Order =
  | {
      side: "buy";
      client_id: string;
      symbol: string;
      notional_quote_units: string;
      max_slippage_bps: number;
    }
  | {
      side: "sell";
      client_id: string;
      symbol: string;
      qty: string;
      max_slippage_bps: number;
    };

let priceScale = 5;
let warmupBars = 0;
let orderCounter = 0;
let everTraded = false;
let barsSinceExit = 1000000;
let peakCloseSinceEntry: number | null = null;
let peakEquity: bigint | null = null;

const closes: number[] = [];
const fastEma = newEma(FAST_SPAN);
const slowEma = newEma(SLOW_SPAN);

// Return over `lookback` bars in basis points, or null without enough bars.
function returnBps(lookback: number): number | null {
  if (closes.length <= lookback) return null;
  const now = closes[closes.length - 1];
  const then = closes[closes.length - 1 - lookback];
  if (then <= 0) return null;
  return ((now - then) / then) * 10000;
}

function nextClientId(prefix: string): string {
  orderCounter += 1;
  return prefix + String(orderCounter);
}

function decide(batch: BatchMsg): Order[] {
  const bar = batch.bars.find((b) => b.symbol === SYMBOL);
  const cash = BigInt(batch.account.cash_quote_units);
  const equity = BigInt(batch.account.equity_quote_units);
  const held = batch.account.positions.find((p) => p.symbol === SYMBOL);
  const heldQty = held === undefined ? 0n : BigInt(held.qty);

  if (peakEquity === null || equity > peakEquity) peakEquity = equity;

  // A fill in this batch tells us what actually happened to our last orders.
  for (const fill of batch.fills) {
    if (fill.status !== "filled") continue;
    everTraded = true;
    if (fill.side === "sell") {
      barsSinceExit = 0;
      peakCloseSinceEntry = null;
    }
  }
  barsSinceExit += 1;

  // No bar for our symbol this minute: nothing to update, no order.
  if (bar === undefined) return [];
  const close = Number(bar.c) / 10 ** priceScale;
  if (!(close > 0)) return [];
  closes.push(close);
  emaStep(fastEma, close);
  emaStep(slowEma, close);

  if (batch.seq < warmupBars) return [];

  // Holding: track the peak close since entry and check the three exits.
  if (heldQty > 0n) {
    if (peakCloseSinceEntry === null || close > peakCloseSinceEntry) {
      peakCloseSinceEntry = close;
    }
    const trailHit =
      peakCloseSinceEntry !== null &&
      close < peakCloseSinceEntry * (1 - TRAIL_BPS / 10000);
    const r240 = returnBps(240);
    const breakdownHit = r240 !== null && r240 < EXIT_R240_BPS;
    const ddHit =
      peakEquity !== null && equity * 10000n < peakEquity * BigInt(10000 - EQUITY_DD_BPS);
    if (trailHit || breakdownHit || ddHit) {
      return [
        {
          side: "sell",
          client_id: nextClientId("s"),
          symbol: SYMBOL,
          qty: heldQty.toString(),
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        },
      ];
    }
    return [];
  }

  // Flat: no position. Peak resets while flat.
  peakCloseSinceEntry = null;
  if (barsSinceExit < REENTRY_COOLDOWN) return [];

  const r60 = returnBps(60);
  // Three-way agreement: fast EMA above slow EMA, the 60-minute return
  // positive, AND the close above the slow EMA itself. The last leg matters
  // after a sharp drop, when the fast EMA can still sit above the slow one
  // on lag alone while the price is already under its long trend line; buying
  // there is buying a falling knife. Verified in simulation: it leaves the
  // dev entry (bar 122) and PnL (+$31.28) unchanged, it only vetoes entries
  // whose price has already broken down.
  const trendUp =
    fastEma.value !== null &&
    slowEma.value !== null &&
    fastEma.value > slowEma.value &&
    close > slowEma.value &&
    r60 !== null &&
    r60 > 0;
  if (trendUp) {
    if (cash < 1000000n) return []; // below the $1 minimum notional
    return [
      {
        side: "buy",
        client_id: nextClientId("b"),
        symbol: SYMBOL,
        notional_quote_units: cash.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      },
    ];
  }

  // Late probe: never traded by bar 1200 and not in freefall -> buy half the
  // cash, so the entry still meets the race's minimum of 1 trade.
  if (!everTraded && batch.seq >= PROBE_BAR && r60 !== null && r60 > PROBE_R60_BPS) {
    const half = cash / 2n;
    if (half < 1000000n) return [];
    return [
      {
        side: "buy",
        client_id: nextClientId("p"),
        symbol: SYMBOL,
        notional_quote_units: half.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      },
    ];
  }
  return [];
}

async function main(): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() === "") continue;
    const msg = JSON.parse(line) as HelloMsg | BatchMsg | { type: string };
    if (msg.type === "hello") {
      const hello = msg as HelloMsg;
      const sym = hello.symbols.find((s) => s.symbol === SYMBOL);
      if (sym !== undefined) priceScale = sym.price_scale;
      warmupBars = hello.warmup_bars ?? 0;
    } else if (msg.type === "batch") {
      const batch = msg as BatchMsg;
      const orders = decide(batch);
      process.stdout.write(
        JSON.stringify({ type: "reply", seq: batch.seq, orders }) + "\n",
      );
    } else if (msg.type === "done") {
      break;
    }
  }
  process.exit(0);
}

main().catch(() => process.exit(1));
