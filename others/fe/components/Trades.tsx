"use client";

import { formatNumber, formatTime } from "@/lib/format";

export type DisplayTrade = {
  price: number;
  size: number;
  ts: number;
  side: "BUY" | "SELL";
  txHash?: string;
};

type Props = {
  trades: DisplayTrade[];
  loading?: boolean;
  embedded?: boolean;
};

export default function Trades({ trades, loading = false, embedded = false }: Props) {
  const body = (
      <div className="px-4 pb-4 pt-2 text-xs text-muted">
        <div className="grid grid-cols-3 text-[11px] text-subtle">
          <span>价格</span>
          <span className="text-right">数量</span>
          <span className="text-right">时间</span>
        </div>
        <div className="mt-3 space-y-1">
          {loading ? (
            <div className="py-4 text-center text-subtle">加载中…</div>
          ) : (
            trades.map((trade, index) => (
              <div
                key={`${trade.ts}-${trade.price}-${index}`}
                className={`grid grid-cols-3 ${
                  trade.side === "BUY" ? "text-buy" : "text-sell"
                }`}
              >
                <span>{formatNumber(trade.price, 2)}</span>
                <span className="text-right">
                  {formatNumber(trade.size, 4)}
                </span>
                <span className="text-right text-muted">
                  {formatTime(trade.ts * 1000)}
                </span>
              </div>
            ))
          )}
          {!loading && trades.length === 0 && (
            <div className="py-4 text-center text-subtle">
              暂无链上成交记录
            </div>
          )}
        </div>
      </div>
  );

  if (embedded) return body;

  return (
    <div className="panel">
      <div className="flex items-center justify-between gap-2 px-4 pt-3">
        <div className="panel-header border-0 p-0">最新成交</div>
        <span className="text-[10px] text-emerald-400/80">链上撮合</span>
      </div>
      {body}
    </div>
  );
}
