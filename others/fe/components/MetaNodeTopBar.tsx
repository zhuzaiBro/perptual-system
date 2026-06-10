"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { formatNumber } from "@/lib/format";
import { markPriceToUsd } from "@/lib/metanode-markets";
import type { PerpMarketDTO } from "@/lib/metanode-api";
import type { RealtimeStatus } from "@/lib/useMarketQuotesRealtime";
import { ChevronDownIcon } from "@heroicons/react/24/outline";
import { ConnectButton } from "@rainbow-me/rainbowkit";

type Props = {
  markets: PerpMarketDTO[];
  selectedPerp: string;
  onSelectPerp: (address: string) => void;
  onOpenProfile?: () => void;
  indexPriceUsd?: number;
  realtimeStatus?: RealtimeStatus;
  /** 交易页由 FuturesContractBar 展示行情时隐藏顶栏重复字段 */
  compact?: boolean;
};

export default function MetaNodeTopBar({
  markets,
  selectedPerp,
  onSelectPerp,
  onOpenProfile,
  indexPriceUsd = 0,
  realtimeStatus = "disabled",
  compact = false,
}: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const current = markets.find(
    (m) => m.address.toLowerCase() === selectedPerp.toLowerCase()
  );
  const markUsd = markPriceToUsd(current?.markPrice);
  const indexUsd =
    indexPriceUsd > 0 ? indexPriceUsd : markPriceToUsd(current?.indexPrice);
  const live = realtimeStatus === "subscribed";
  const displayName = current?.name ?? "—";

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div className="fixed left-0 right-0 top-0 z-40 border-b border-panelBorder bg-surface px-3 py-2 md:px-6 md:py-3">
      <div className="flex items-center justify-between gap-3 md:justify-start md:gap-4">
        <Link
          href="/positions"
          className="shrink-0 rounded-lg bg-elevated px-3 py-2 text-xs font-semibold text-foreground hover:bg-panelBorder md:text-sm"
        >
          持仓
        </Link>
        {onOpenProfile ? (
          <button
            type="button"
            onClick={onOpenProfile}
            className="shrink-0 rounded-lg bg-elevated px-3 py-2 text-xs font-semibold text-foreground hover:bg-panelBorder md:text-sm"
          >
            账户
          </button>
        ) : null}

        <div ref={containerRef} className="relative shrink-0">
          <button
            type="button"
            onClick={() => setIsOpen(!isOpen)}
            className="flex items-center gap-2 rounded-lg border-0 bg-elevated p-1 transition hover:bg-panelBorder md:gap-3 md:p-2"
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-xs font-bold text-black md:h-10 md:w-10 md:text-sm">
              {(current?.name.split("-")[0] ?? "?").slice(0, 1)}
            </div>
            <div className="text-left">
              <div className="flex items-center gap-1 md:gap-2">
                <div className="text-sm font-bold text-white md:text-lg">
                  {displayName}
                </div>
                <ChevronDownIcon
                  className={`h-3 w-3 text-muted transition md:h-4 md:w-4 ${isOpen ? "rotate-180" : ""}`}
                />
              </div>
              <div className="text-[10px] text-emerald-400/90 md:text-xs">
                Sepolia 链上
              </div>
            </div>
          </button>

          {isOpen ? (
            <div className="absolute left-0 top-full z-50 mt-2 w-[min(90vw,420px)] rounded-lg border border-panelBorder bg-panel shadow-2xl">
              <div className="border-b border-panelBorder px-3 py-2 text-xs text-subtle">
                MetaNode 永续（链上 MarkPrice）
              </div>
              <div className="max-h-[360px] overflow-y-auto">
                {markets.map((m) => {
                  const selected =
                    m.address.toLowerCase() === selectedPerp.toLowerCase();
                  return (
                    <button
                      key={m.address}
                      type="button"
                      onClick={() => {
                        onSelectPerp(m.address);
                        setIsOpen(false);
                      }}
                      className={`flex w-full items-center justify-between border-0 px-4 py-3 text-sm transition hover:bg-panelBorder ${
                        selected ? "bg-elevated" : "bg-transparent"
                      }`}
                    >
                      <span className="font-medium text-white">{m.name}</span>
                      <span className="font-mono text-muted">
                        {formatNumber(markPriceToUsd(m.markPrice), 2)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>

        <div className="flex flex-col items-end md:hidden">
          <div className="text-sm font-semibold text-accent">
            {formatNumber(markUsd, 2)}
          </div>
          <div className="text-[10px] text-muted">标记价 USDC</div>
        </div>

        <div
          className={`hidden flex-1 flex-wrap items-center gap-8 text-sm text-muted md:flex ${compact ? "!hidden" : ""}`}
        >
          <div>
            <div className="text-xs text-subtle">标记价格</div>
            <div className="text-lg font-semibold text-accent">
              {formatNumber(markUsd, 2)}
            </div>
          </div>
          <div>
            <div className="flex items-center gap-1.5 text-xs text-subtle">
              指数价格
              {live ? (
                <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">
                  LIVE
                </span>
              ) : null}
            </div>
            <div className="text-lg font-semibold text-foreground">
              {formatNumber(indexUsd, 2)}
            </div>
          </div>
          <div>
            <div className="text-xs text-subtle">资金费率指数</div>
            <div className="text-sm font-medium text-yellow-500">
              {current?.fundingRate && current.fundingRate !== "0"
                ? current.fundingRate
                : "—"}
            </div>
          </div>
          <div>
            <div className="text-xs text-subtle">合约</div>
            <div className="max-w-[140px] truncate font-mono text-[11px] text-muted">
              {selectedPerp.slice(0, 10)}…
            </div>
          </div>
        </div>

        <div className="hidden md:ml-auto md:block">
          <ConnectButton />
        </div>
        <div className="md:hidden">
          <ConnectButton
            showBalance={false}
            accountStatus="avatar"
            chainStatus="none"
          />
        </div>
      </div>
    </div>
  );
}
