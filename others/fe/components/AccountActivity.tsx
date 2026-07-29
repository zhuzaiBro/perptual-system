"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount } from "wagmi";
import {
  fetchMetanodeOrders,
  fetchMetanodeTraderTrades,
  type OrderDTO,
  type TradeRecordDTO,
} from "@/lib/metanode-api";
import {
  markPriceToUsd,
  paperToSize,
  SEPOLIA_METANODE_MARKETS,
} from "@/lib/metanode-markets";
import { formatNumber } from "@/lib/format";

type Props = {
  mode: "orders" | "trades";
  selectedPerp: string;
  refreshKey?: number;
};

const POLL_MS = 5_000;

function marketName(perp: string): string {
  return (
    SEPOLIA_METANODE_MARKETS.find(
      (market) => market.address.toLowerCase() === perp.toLowerCase()
    )?.name ?? `${perp.slice(0, 6)}…${perp.slice(-4)}`
  );
}

function orderPriceUsd(order: OrderDTO): number {
  try {
    const paper = BigInt(order.paperAmount);
    const credit = BigInt(order.creditAmount);
    const absPaper = paper < 0n ? -paper : paper;
    const absCredit = credit < 0n ? -credit : credit;
    if (absPaper === 0n) return 0;
    return Number(absCredit) / 1e6 / (Number(absPaper) / 1e18);
  } catch {
    return 0;
  }
}

function formatDateTime(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "—";
  return new Date(timestamp * 1_000).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function shortId(value: string): string {
  if (!value) return "—";
  if (value.length <= 14) return value;
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function statusLabel(status: number): string {
  if (status === 0) return "待成交";
  if (status === 1) return "部分成交";
  if (status === 2) return "已成交";
  if (status === 3) return "已取消";
  return `状态 ${status}`;
}

export default function AccountActivity({
  mode,
  selectedPerp,
  refreshKey = 0,
}: Props) {
  const { address, isConnected } = useAccount();
  const [orders, setOrders] = useState<OrderDTO[]>([]);
  const [trades, setTrades] = useState<TradeRecordDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!address || !isConnected) {
      setOrders([]);
      setTrades([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [orderResp, tradeResp] = await Promise.all([
        fetchMetanodeOrders(address, selectedPerp),
        fetchMetanodeTraderTrades(address, selectedPerp, 50),
      ]);
      if (orderResp.code !== 0) {
        throw new Error(orderResp.message || "委托加载失败");
      }
      if (tradeResp.code !== 0) {
        throw new Error(tradeResp.message || "成交加载失败");
      }
      setOrders(orderResp.orders ?? []);
      setTrades(tradeResp.trades ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [address, isConnected, selectedPerp]);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(id);
  }, [load, refreshKey]);

  const currentOrders = useMemo(
    () => orders.filter((order) => order.status === 0 || order.status === 1),
    [orders]
  );

  const orderById = useMemo(
    () => new Map(orders.map((order) => [order.orderId.toLowerCase(), order])),
    [orders]
  );

  const emptyMessage =
    mode === "orders"
      ? "暂无当前委托（签名并提交后会显示在这里）"
      : "暂无成交记录（订单撮合并完成链上结算后会显示）";

  return (
    <div className="min-h-[108px]">
      <div className="flex items-center justify-between px-4 pt-2">
        <span className="text-[11px] text-subtle">
          {mode === "orders"
            ? `当前市场委托 ${currentOrders.length} 笔`
            : `当前市场成交 ${trades.length} 笔`}
        </span>
        <button
          type="button"
          disabled={loading || !isConnected}
          onClick={() => void load()}
          className="rounded-md border border-panelBorder px-2 py-1 text-[11px] text-subtle hover:bg-white/5 disabled:opacity-50"
        >
          {loading ? "刷新中…" : "刷新"}
        </button>
      </div>

      <div className="overflow-x-auto px-4 pb-4 pt-2 text-xs">
        {!isConnected ? (
          <p className="py-4 text-subtle">连接钱包后查看账户交易记录</p>
        ) : error ? (
          <p className="py-4 text-red-400">{error}</p>
        ) : mode === "orders" && currentOrders.length > 0 ? (
          <OrdersTable orders={currentOrders} />
        ) : mode === "trades" && trades.length > 0 ? (
          <TradesTable
            address={address ?? ""}
            trades={trades}
            orderById={orderById}
          />
        ) : (
          <p className="py-4 text-subtle">{loading ? "加载中…" : emptyMessage}</p>
        )}
      </div>
    </div>
  );
}

function OrdersTable({ orders }: { orders: OrderDTO[] }) {
  return (
    <div className="min-w-[920px]">
      <div className="grid grid-cols-[1.2fr_.7fr_1fr_1fr_1fr_1fr_1.3fr_1.2fr] text-[11px] text-subtle">
        <span>市场</span>
        <span>方向</span>
        <span className="text-right">委托价</span>
        <span className="text-right">委托数量</span>
        <span className="text-right">已成交</span>
        <span className="text-right">剩余</span>
        <span className="text-right">状态 / 时间</span>
        <span className="text-right">订单号</span>
      </div>
      <div className="mt-3 space-y-2">
        {orders.map((order) => {
          const size = Math.abs(paperToSize(order.paperAmount));
          const filled = Math.abs(paperToSize(order.filledAmount || "0"));
          const isLong = paperToSize(order.paperAmount) > 0;
          return (
            <div
              key={order.orderId}
              className="grid grid-cols-[1.2fr_.7fr_1fr_1fr_1fr_1fr_1.3fr_1.2fr] items-center text-foreground"
            >
              <span>{marketName(order.perp)}</span>
              <span className={isLong ? "text-buy" : "text-sell"}>
                {isLong ? "买进 / 做多" : "卖出 / 做空"}
              </span>
              <span className="text-right font-mono">
                {formatNumber(orderPriceUsd(order), 2)}
              </span>
              <span className="text-right font-mono">
                {formatNumber(size, 4)}
              </span>
              <span className="text-right font-mono">
                {formatNumber(filled, 4)}
              </span>
              <span className="text-right font-mono">
                {formatNumber(Math.max(0, size - filled), 4)}
              </span>
              <span className="text-right">
                <span className={order.status === 1 ? "text-amber-300" : "text-accent"}>
                  {statusLabel(order.status)}
                </span>
                <span className="ml-2 text-[10px] text-subtle">
                  {formatDateTime(order.createTime)}
                </span>
              </span>
              <span className="text-right font-mono text-subtle" title={order.orderId}>
                {shortId(order.orderId)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TradesTable({
  address,
  trades,
  orderById,
}: {
  address: string;
  trades: TradeRecordDTO[];
  orderById: Map<string, OrderDTO>;
}) {
  const account = address.toLowerCase();
  return (
    <div className="min-w-[900px]">
      <div className="grid grid-cols-[1.2fr_.8fr_1fr_1fr_.8fr_1.4fr_1.2fr] text-[11px] text-subtle">
        <span>市场</span>
        <span>方向</span>
        <span className="text-right">成交价</span>
        <span className="text-right">成交数量</span>
        <span className="text-right">角色</span>
        <span className="text-right">成交时间</span>
        <span className="text-right">交易哈希</span>
      </div>
      <div className="mt-3 space-y-2">
        {trades.map((trade) => {
          const isTaker = trade.taker.toLowerCase() === account;
          const ownOrderId = isTaker ? trade.takerOrderId : trade.makerOrderId;
          const ownOrder = orderById.get(ownOrderId.toLowerCase());
          const isLong = ownOrder ? paperToSize(ownOrder.paperAmount) > 0 : null;
          return (
            <div
              key={trade.tradeId}
              className="grid grid-cols-[1.2fr_.8fr_1fr_1fr_.8fr_1.4fr_1.2fr] items-center text-foreground"
            >
              <span>{marketName(trade.perp)}</span>
              <span className={isLong === true ? "text-buy" : isLong === false ? "text-sell" : "text-subtle"}>
                {isLong === true ? "做多" : isLong === false ? "做空" : "—"}
              </span>
              <span className="text-right font-mono">
                {formatNumber(markPriceToUsd(trade.price), 2)}
              </span>
              <span className="text-right font-mono">
                {formatNumber(Math.abs(paperToSize(trade.paperAmount)), 4)}
              </span>
              <span className="text-right text-subtle">
                {isTaker ? "Taker" : "Maker"}
              </span>
              <span className="text-right text-subtle">
                {formatDateTime(trade.createTime)}
              </span>
              <span className="text-right font-mono">
                {trade.txHash ? (
                  <a
                    href={`https://sepolia.etherscan.io/tx/${trade.txHash}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent hover:underline"
                    title={trade.txHash}
                  >
                    {shortId(trade.txHash)}
                  </a>
                ) : (
                  <span className="text-subtle">结算中</span>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
