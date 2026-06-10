"use client";

import { useMemo } from "react";
import { formatNumber } from "@/lib/format";
import { markPriceToUsd, paperToSize } from "@/lib/metanode-markets";
import type { OrderBookEntryDTO } from "@/lib/metanode-api";

type Level = { price: number; amount: number };

type Props = {
  bids: OrderBookEntryDTO[];
  asks: OrderBookEntryDTO[];
  loading?: boolean;
  markPriceUsd?: number;
  symbol?: string;
  /** 嵌入 Tab 面板时不重复外框标题 */
  embedded?: boolean;
};

function toLevels(entries: OrderBookEntryDTO[]): Level[] {
  return entries.map((e) => ({
    price: markPriceToUsd(e.price),
    amount: Math.abs(paperToSize(e.amount)),
  }));
}

function withCumulative(levels: Level[]): Array<Level & { total: number }> {
  let sum = 0;
  return levels.map((row) => {
    sum += row.amount;
    return { ...row, total: sum };
  });
}

export default function OrderBook({
  bids,
  asks,
  loading = false,
  markPriceUsd = 0,
  symbol = "BTC",
  embedded = false,
}: Props) {
  const { askRows, bidRows, bidSharePct } = useMemo(() => {
    const askLevels = toLevels(asks).filter((r) => r.price > 0 && r.amount > 0);
    const bidLevels = toLevels(bids).filter((r) => r.price > 0 && r.amount > 0);
    const askSum = askLevels.reduce((s, r) => s + r.amount, 0);
    const bidSum = bidLevels.reduce((s, r) => s + r.amount, 0);
    const total = askSum + bidSum;
    const pct = total > 0 ? (bidSum / total) * 100 : undefined;
    return {
      askRows: withCumulative(askLevels),
      bidRows: withCumulative(bidLevels),
      bidSharePct: pct,
    };
  }, [asks, bids]);

  const body = (
      <div className="px-4 pb-4 pt-2 text-xs text-muted">
        {loading ? (
          <p className="py-6 text-center text-subtle">加载中…</p>
        ) : askRows.length === 0 && bidRows.length === 0 ? (
          <p className="py-6 text-center text-subtle">
            暂无挂单（下单后将出现在此）
          </p>
        ) : (
          <>
            <div className="grid grid-cols-3 text-[11px] text-subtle">
              <span>委托价 (USDT)</span>
              <span className="text-right">数量 ({symbol})</span>
              <span className="text-right">累计</span>
            </div>
            {bidSharePct != null ? (
              <div className="mt-3 flex h-6 overflow-hidden rounded text-[10px] font-semibold">
                <div
                  className="flex items-center justify-center bg-buy/25 text-buy"
                  style={{ width: `${bidSharePct}%` }}
                >
                  B {formatNumber(bidSharePct, 0)}%
                </div>
                <div
                  className="flex flex-1 items-center justify-center bg-sell/25 text-sell"
                >
                  {formatNumber(100 - bidSharePct, 0)}% S
                </div>
              </div>
            ) : null}
            <div className="mt-3 space-y-1">
              {askRows
                .slice()
                .reverse()
                .map((row, index) => (
                  <div
                    key={`ask-${row.price}-${index}`}
                    className="grid grid-cols-3 text-sell"
                  >
                    <span>{formatNumber(row.price, 2)}</span>
                    <span className="text-right">
                      {formatNumber(row.amount, 4)}
                    </span>
                    <span className="text-right">
                      {formatNumber(row.total, 4)}
                    </span>
                  </div>
                ))}
              <div className="my-2 flex items-center justify-center gap-2 border-y border-panelBorder py-2">
                <span className="font-mono text-sm font-semibold text-accent">
                  {formatNumber(markPriceUsd, 2)}
                </span>
                <span className="text-[10px] text-muted">标记价</span>
              </div>
              {bidRows.map((row, index) => (
                <div
                  key={`bid-${row.price}-${index}`}
                  className="grid grid-cols-3 text-buy"
                >
                  <span>{formatNumber(row.price, 2)}</span>
                  <span className="text-right">
                    {formatNumber(row.amount, 4)}
                  </span>
                  <span className="text-right">
                    {formatNumber(row.total, 4)}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
  );

  if (embedded) return body;

  return (
    <div className="panel">
      <div className="flex items-center justify-between gap-2 px-4 pt-3">
        <div className="panel-header border-0 p-0">订单簿</div>
        <span className="text-[10px] text-emerald-400/80">内存撮合簿</span>
      </div>
      {body}
    </div>
  );
}

/** 买盘数量占比，供合约信息条展示 */
export function orderBookBidShare(
  bids: OrderBookEntryDTO[],
  asks: OrderBookEntryDTO[]
): number | undefined {
  let bidSum = 0;
  let askSum = 0;
  for (const e of bids) {
    bidSum += Math.abs(paperToSize(e.amount));
  }
  for (const e of asks) {
    askSum += Math.abs(paperToSize(e.amount));
  }
  const t = bidSum + askSum;
  if (t <= 0) return undefined;
  return (bidSum / t) * 100;
}
