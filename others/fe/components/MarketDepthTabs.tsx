"use client";

import { useState, type ReactNode } from "react";
import OrderBook from "@/components/OrderBook";
import Trades, { type DisplayTrade } from "@/components/Trades";
import type { OrderBookEntryDTO } from "@/lib/metanode-api";

type Tab = "book" | "trades";

type Props = {
  bids: OrderBookEntryDTO[];
  asks: OrderBookEntryDTO[];
  trades: DisplayTrade[];
  bookLoading?: boolean;
  tradesLoading?: boolean;
  markPriceUsd?: number;
  symbol?: string;
  className?: string;
};

export default function MarketDepthTabs({
  bids,
  asks,
  trades,
  bookLoading,
  tradesLoading,
  markPriceUsd = 0,
  symbol = "BTC",
  className = "",
}: Props) {
  const [tab, setTab] = useState<Tab>("book");

  return (
    <div
      className={`panel flex flex-col overflow-hidden ${className}`.trim()}
    >
      <div className="flex shrink-0 border-b border-panelBorder text-sm">
        <TabButton active={tab === "book"} onClick={() => setTab("book")}>
          订单簿
        </TabButton>
        <TabButton active={tab === "trades"} onClick={() => setTab("trades")}>
          最新成交
        </TabButton>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === "book" ? (
          <OrderBook
            bids={bids}
            asks={asks}
            loading={bookLoading}
            markPriceUsd={markPriceUsd}
            symbol={symbol}
            embedded
          />
        ) : (
          <Trades trades={trades} loading={tradesLoading} embedded />
        )}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`border-0 px-4 py-2.5 font-medium transition ${
        active
          ? "border-b-2 border-accent text-white"
          : "text-subtle hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}
