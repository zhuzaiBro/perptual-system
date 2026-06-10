"use client";

import FundingRatePanel from "@/components/FundingRatePanel";
import { formatNumber } from "@/lib/format";
import { formatLeverageLabel, resolveMarketRisk } from "@/lib/leverage";
import { markPriceToUsd } from "@/lib/metanode-markets";
import type { PerpMarketDTO } from "@/lib/metanode-api";

type Props = {
  market: PerpMarketDTO | undefined;
  indexPriceUsd: number;
  /** 订单簿多空数量比（0–100，无数据为 undefined） */
  bidSharePct?: number;
};

export default function FuturesContractBar({
  market,
  indexPriceUsd,
  bidSharePct,
}: Props) {
  const markUsd = markPriceToUsd(market?.markPrice);
  const indexUsd =
    indexPriceUsd > 0 ? indexPriceUsd : markPriceToUsd(market?.indexPrice);
  const lastUsd = indexUsd > 0 ? indexUsd : markUsd;
  const spread =
    markUsd > 0 && indexUsd > 0
      ? Math.abs(markUsd - indexUsd)
      : 0;
  const risk = resolveMarketRisk(market);
  const leverageLabel = formatLeverageLabel(risk.maxLeverage);

  return (
    <div className="border-b border-panelBorder bg-surface px-3 py-3 sm:px-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs text-subtle">
            <span className="rounded bg-elevated px-2 py-0.5 font-medium text-muted">
              永续
            </span>
            <span className="text-muted">USDC 保证金</span>
            <span className="text-faint">·</span>
            <span className="text-emerald-400">Sepolia</span>
            {leverageLabel !== "—" ? (
              <>
                <span className="text-faint">·</span>
                <span className="rounded bg-accent/10 px-2 py-0.5 font-semibold text-accent">
                  {leverageLabel}
                </span>
              </>
            ) : null}
          </div>
          <h1 className="mt-1 text-lg font-bold text-white sm:text-xl">
            {market?.name ?? "—"}
          </h1>
          <div className="mt-2 flex items-baseline gap-3">
            <span
              className={`font-mono text-3xl font-semibold tracking-tight sm:text-4xl ${
                lastUsd > 0 ? "text-foreground" : "text-subtle"
              }`}
            >
              {lastUsd > 0 ? formatNumber(lastUsd, 2) : "—"}
            </span>
            <span className="text-sm text-subtle">USDT</span>
          </div>
          <p className="mt-1 text-[11px] text-muted">
            最新价优先展示现货指数（Coinbase/OKX/Binance 加权）；下单使用系统开仓价
          </p>
        </div>

        <div className="flex flex-wrap gap-6 text-xs sm:gap-8 sm:text-sm">
          <Stat
            label="最大杠杆"
            value={leverageLabel}
            accent={leverageLabel !== "—"}
          />
          <Stat
            label="初始保证金"
            value={
              risk.initialMarginPct ? `${risk.initialMarginPct}%` : "—"
            }
          />
          <Stat
            label="维持保证金"
            value={
              risk.maintenanceMarginPct
                ? `${risk.maintenanceMarginPct}%`
                : "—"
            }
          />
          <Stat label="标记价格" value={formatNumber(markUsd, 2)} accent />
          <Stat label="指数价格" value={formatNumber(indexUsd, 2)} />
          <Stat
            label="标记 − 指数"
            value={spread > 0 ? formatNumber(spread, 2) : "—"}
          />
          {market?.address ? (
            <FundingRatePanel perp={market.address} />
          ) : null}
          {bidSharePct != null ? (
            <Stat
              label="盘口多空"
              value={`买 ${formatNumber(bidSharePct, 0)}% / 卖 ${formatNumber(100 - bidSharePct, 0)}%`}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
  muted,
}: {
  label: string;
  value: string;
  accent?: boolean;
  muted?: boolean;
}) {
  return (
    <div>
      <div className="text-subtle">{label}</div>
      <div
        className={`mt-0.5 font-mono font-medium ${
          accent ? "text-accent" : muted ? "text-yellow-500" : "text-foreground"
        }`}
      >
        {value}
      </div>
    </div>
  );
}
