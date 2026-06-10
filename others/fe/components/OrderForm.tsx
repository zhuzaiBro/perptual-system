"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatUnits } from "viem";
import { useAccount, useChainId, useReadContract, useSignTypedData } from "wagmi";
import { sepolia } from "wagmi/chains";
import {
  fetchMetanodeOpenQuote,
  hasMetanodeAuthSession,
  postMetanodeOrder,
} from "@/lib/metanode-api";
import {
  markPriceToUsd,
  type MetaNodeMarket,
} from "@/lib/metanode-markets";
import {
  buildMetaNodeOrder,
  orderTypedData,
  toCreateOrderBody,
  type OrderSide,
} from "@/lib/metanode-order";
import FundingRatePanel from "@/components/FundingRatePanel";
import { formatNumber } from "@/lib/format";
import {
  buildLeverageOptions,
  chainMinMarginUsd,
  clampLeverage,
  formatLeverageLabel,
  loadStoredLeverage,
  marginRequiredUsd,
  parseMaxLeverage,
  resolveMarketRisk,
  saveStoredLeverage,
} from "@/lib/leverage";
import type { PerpMarketDTO } from "@/lib/metanode-api";
import { metaNodeDealerAbi, resolveDealerAddress } from "@/lib/metanodeDealer";

export type CloseDraft = {
  perp: `0x${string}`;
  size: string;
  priceUsd: string;
  side: OrderSide;
};

type OpenPriceMode = "system" | "manual";

function formatOpenPriceSource(source: string): string {
  switch (source) {
    case "best_ask":
      return "订单簿卖一";
    case "best_bid":
      return "订单簿买一";
    case "orderbook_mid":
      return "订单簿中间价";
    case "chain_mark":
      return "链上标记价";
    case "spot_index":
      return "现货指数价";
    case "mark_fallback":
      return "标记价（本地）";
    default:
      return source || "系统价";
  }
}

type Props = {
  markets: MetaNodeMarket[];
  selectedPerp: `0x${string}`;
  onSelectPerp: (address: `0x${string}`) => void;
  markPriceRaw?: string;
  indexPriceUsd?: number;
  /** 交易页已选合约时可隐藏市场下拉 */
  hideMarketSelect?: boolean;
  /** 含链上杠杆配置的市场信息（来自 /markets） */
  marketRisk?: PerpMarketDTO;
  closeDraft?: CloseDraft | null;
  onCloseDraftApplied?: () => void;
  onOrderSubmitted?: () => void;
};

export default function OrderForm({
  markets,
  selectedPerp,
  onSelectPerp,
  markPriceRaw,
  indexPriceUsd = 0,
  hideMarketSelect = false,
  marketRisk,
  closeDraft,
  onCloseDraftApplied,
  onOrderSubmitted,
}: Props) {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { signTypedDataAsync } = useSignTypedData();

  const dealerAddress = resolveDealerAddress();
  const [side, setSide] = useState<OrderSide>("long");
  const [price, setPrice] = useState("");
  const [openPriceSource, setOpenPriceSource] = useState<string>("");
  const [openPriceMode, setOpenPriceMode] = useState<OpenPriceMode>("system");
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const markUsd = useMemo(() => markPriceToUsd(markPriceRaw), [markPriceRaw]);
  const [panelMode, setPanelMode] = useState<"open" | "close">("open");
  const isCloseMode = panelMode === "close" || Boolean(closeDraft);
  const onSepolia = chainId === sepolia.id;
  const sessionOk = Boolean(address) && hasMetanodeAuthSession(address);

  const selectedMarket = markets.find(
    (m) => m.address.toLowerCase() === selectedPerp.toLowerCase()
  );
  const risk = resolveMarketRisk(marketRisk);
  const maxLeverageNum = parseMaxLeverage(risk.maxLeverage);
  const leverageOptions = useMemo(
    () => buildLeverageOptions(maxLeverageNum),
    [maxLeverageNum]
  );
  const [leverage, setLeverage] = useState(10);

  useEffect(() => {
    if (isCloseMode) return;
    setLeverage(loadStoredLeverage(selectedPerp, maxLeverageNum));
  }, [selectedPerp, maxLeverageNum, isCloseMode]);

  const handleLeverageChange = (lev: number) => {
    const next = clampLeverage(lev, maxLeverageNum);
    setLeverage(next);
    saveStoredLeverage(selectedPerp, next);
  };

  useEffect(() => {
    if (!closeDraft) return;
    setPanelMode("close");
    setSide(closeDraft.side);
    setAmount(closeDraft.size);
    setPrice(closeDraft.priceUsd);
    setOpenPriceSource("close");
    onCloseDraftApplied?.();
  }, [closeDraft, onCloseDraftApplied]);

  const refreshSystemQuote = useCallback(async () => {
    setQuoteLoading(true);
    try {
      const resp = await fetchMetanodeOpenQuote(selectedPerp, side);
      if (resp.code === 0 && resp.quote?.priceUsd) {
        setPrice(resp.quote.priceUsd);
        setOpenPriceSource(resp.quote.source ?? "");
        return;
      }
      if (markUsd > 0) {
        setPrice(formatNumber(markUsd, 2));
        setOpenPriceSource("mark_fallback");
      }
    } catch {
      if (markUsd > 0) {
        setPrice(formatNumber(markUsd, 2));
        setOpenPriceSource("mark_fallback");
      }
    } finally {
      setQuoteLoading(false);
    }
  }, [selectedPerp, side, markUsd]);

  useEffect(() => {
    if (isCloseMode || openPriceMode !== "system") return;
    void refreshSystemQuote();
  }, [isCloseMode, openPriceMode, refreshSystemQuote]);

  const useSystemOpenPrice = !isCloseMode && openPriceMode === "system";

  const notional = useMemo(() => {
    const p = Number(price) || markUsd || 0;
    const a = Number(amount) || 0;
    return p * a;
  }, [price, amount, markUsd]);

  const { data: creditData } = useReadContract({
    address: dealerAddress,
    abi: metaNodeDealerAbi,
    functionName: "getCreditOf",
    args: address ? [address] : undefined,
    chainId: sepolia.id,
    query: { enabled: Boolean(address && onSepolia) },
  });

  const dealerCreditHuman = useMemo(() => {
    if (!creditData) return null;
    const raw = (creditData as readonly [bigint, ...unknown[]])[0];
    return Number(formatUnits(raw, 6));
  }, [creditData]);

  const marginRequired = useMemo(
    () => (isCloseMode ? 0 : marginRequiredUsd(notional, leverage)),
    [isCloseMode, notional, leverage]
  );

  const chainMinMargin = useMemo(
    () =>
      isCloseMode ? 0 : chainMinMarginUsd(notional, risk.initialMarginPct),
    [isCloseMode, notional, risk.initialMarginPct]
  );

  const creditInsufficient = useMemo(() => {
    if (isCloseMode || dealerCreditHuman == null || marginRequired <= 0) {
      return false;
    }
    return dealerCreditHuman < marginRequired;
  }, [isCloseMode, dealerCreditHuman, marginRequired]);

  const leverageTooLowForChain = useMemo(() => {
    if (isCloseMode || marginRequired <= 0 || chainMinMargin <= 0) return false;
    return marginRequired < chainMinMargin - 1e-6;
  }, [isCloseMode, marginRequired, chainMinMargin]);

  const submit = useCallback(async () => {
    setErr(null);
    setMsg(null);
    if (!address || !isConnected) {
      setErr("请先连接钱包");
      return;
    }
    if (!onSepolia) {
      setErr("请切换到 Sepolia");
      return;
    }
    if (!sessionOk) {
      setErr("MetaNode 登录未完成，请等待签名或刷新");
      return;
    }
    if (!amount.trim() || !price.trim()) {
      setErr("请填写数量与价格");
      return;
    }
    if (!isCloseMode && leverage > maxLeverageNum) {
      setErr(`杠杆不能超过该合约最大 ${maxLeverageNum}x`);
      return;
    }
    if (!isCloseMode && creditInsufficient) {
      setErr(
        `Dealer 保证金不足：需要约 ${formatNumber(marginRequired, 2)} USDC（${leverage}x）`
      );
      return;
    }
    if (!isCloseMode && leverageTooLowForChain) {
      setErr(
        `所选杠杆过高：${leverage}x 保证金低于链上最低要求（约 ${formatNumber(chainMinMargin, 2)} USDC）`
      );
      return;
    }

    setSubmitting(true);
    try {
      const order = buildMetaNodeOrder({
        perp: selectedPerp,
        signer: address,
        side,
        size: amount.trim(),
        priceUsd: price.trim(),
      });
      const typed = orderTypedData(order);
      const signature = await signTypedDataAsync(typed);
      const resp = await postMetanodeOrder(toCreateOrderBody(order, signature));
      if (resp.code !== 0) {
        setErr(resp.message || `下单失败 code=${resp.code}`);
        return;
      }
      setMsg(
        resp.orderId
          ? `订单已提交：${resp.orderId.slice(0, 10)}…`
          : "订单已提交，等待撮合"
      );
      onOrderSubmitted?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }, [
    address,
    isConnected,
    onSepolia,
    sessionOk,
    amount,
    price,
    selectedPerp,
    side,
    signTypedDataAsync,
    onOrderSubmitted,
    isCloseMode,
    leverage,
    maxLeverageNum,
    marginRequired,
    creditInsufficient,
    leverageTooLowForChain,
  ]);

  const priceNum = Number(price) || 0;

  return (
    <div className="panel lg:sticky lg:top-[72px]">
      <div className="flex border-b border-panelBorder text-sm">
        <button
          type="button"
          onClick={() => setPanelMode("open")}
          className={`flex-1 border-0 py-3 font-medium ${
            panelMode === "open"
              ? "border-b-2 border-accent text-white"
              : "text-subtle"
          }`}
        >
          开仓
        </button>
        <button
          type="button"
          onClick={() => setPanelMode("close")}
          className={`flex-1 border-0 py-3 font-medium ${
            panelMode === "close"
              ? "border-b-2 border-accent text-white"
              : "text-subtle"
          }`}
        >
          平仓
        </button>
      </div>

      <div className="space-y-4 px-4 pb-4 pt-3 text-sm">
        {!hideMarketSelect ? (
          <label className="block text-xs text-subtle">
            市场
            <select
              value={selectedPerp}
              onChange={(e) => onSelectPerp(e.target.value as `0x${string}`)}
              className="mt-1 w-full rounded-lg border border-panelBorder bg-elevated px-3 py-2 text-sm text-foreground outline-none"
            >
              {markets.map((m) => (
                <option key={m.address} value={m.address}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <div className="space-y-1 text-xs text-subtle">
            <div>
              {selectedMarket?.name ?? "—"} ·{" "}
              {useSystemOpenPrice ? "开仓系统价" : "开仓限价"}
            </div>
            {maxLeverageNum > 0 ? (
              <p className="text-[11px] text-faint">
                链上最大 {formatLeverageLabel(risk.maxLeverage)}
                {risk.initialMarginPct
                  ? ` · 初始保证金率 ${risk.initialMarginPct}%`
                  : ""}
              </p>
            ) : null}
          </div>
        )}

        {!isCloseMode && maxLeverageNum > 0 ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs text-subtle">
              <span>杠杆倍数</span>
              <span className="font-mono text-accent">{leverage}x</span>
            </div>
            <div className="flex flex-wrap gap-1">
              {leverageOptions.map((lev) => (
                <button
                  key={lev}
                  type="button"
                  onClick={() => handleLeverageChange(lev)}
                  className={`min-w-[2.5rem] rounded-md px-2 py-1.5 text-xs font-semibold transition ${
                    leverage === lev
                      ? "bg-accent text-black"
                      : "bg-elevated text-muted hover:text-foreground"
                  }`}
                >
                  {lev}x
                </button>
              ))}
            </div>
            <p className="text-[10px] leading-relaxed text-faint">
              按所选杠杆计算占用保证金；撮合仍按限价×数量全额名义成交。
            </p>
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-1 rounded-lg bg-elevated p-1">
          <button
            type="button"
            onClick={() => setSide("long")}
            className={`rounded-md py-2.5 text-sm font-semibold transition ${
              side === "long"
                ? "bg-buy text-black"
                : "text-subtle hover:text-foreground"
            }`}
          >
            买入 / 做多
          </button>
          <button
            type="button"
            onClick={() => setSide("short")}
            className={`rounded-md py-2.5 text-sm font-semibold transition ${
              side === "short"
                ? "bg-sell text-white"
                : "text-subtle hover:text-foreground"
            }`}
          >
            卖出 / 做空
          </button>
        </div>

        {!isCloseMode ? (
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-elevated p-1 text-xs">
            <button
              type="button"
              onClick={() => {
                setOpenPriceMode("system");
              }}
              className={`rounded-md py-2 font-medium transition ${
                openPriceMode === "system"
                  ? "bg-panelBorder text-foreground"
                  : "text-subtle hover:text-foreground"
              }`}
            >
              系统价
            </button>
            <button
              type="button"
              onClick={() => {
                setOpenPriceMode("manual");
                if (!price.trim() && markUsd > 0) {
                  setPrice(formatNumber(markUsd, 2));
                }
              }}
              className={`rounded-md py-2 font-medium transition ${
                openPriceMode === "manual"
                  ? "bg-panelBorder text-foreground"
                  : "text-subtle hover:text-foreground"
              }`}
            >
              限价
            </button>
          </div>
        ) : null}

        {useSystemOpenPrice ? (
          <div className="rounded-lg border border-panelBorder bg-elevated px-3 py-3 text-center">
            <div className="flex items-center justify-center gap-2 text-[11px] text-subtle">
              <span>开仓价格（系统查询）</span>
              <button
                type="button"
                disabled={quoteLoading}
                onClick={() => void refreshSystemQuote()}
                className="rounded border-0 bg-transparent px-1 text-accent hover:underline disabled:opacity-50"
              >
                {quoteLoading ? "刷新中…" : "刷新"}
              </button>
            </div>
            <div
              className={`mt-1 font-mono text-2xl font-semibold ${
                side === "long" ? "text-buy" : "text-sell"
              }`}
            >
              {priceNum > 0 ? formatNumber(priceNum, 2) : "—"}
            </div>
            <div className="mt-1 text-[10px] text-subtle">USDT</div>
            {openPriceSource ? (
              <p className="mt-2 text-[10px] leading-relaxed text-subtle">
                {side === "long" ? "做多" : "做空"} ·{" "}
                {formatOpenPriceSource(openPriceSource)}
                <br />
                默认：做多取卖一，做空取买一
              </p>
            ) : null}
          </div>
        ) : (
          <label className="block text-xs text-subtle">
            <div className="mb-1.5 flex items-center justify-between">
              <span>{isCloseMode ? "平仓限价" : "开仓限价"}</span>
              <span>USDT</span>
            </div>
            <input
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              inputMode="decimal"
              placeholder={markUsd > 0 ? formatNumber(markUsd, 2) : "65000.00"}
              className="w-full rounded-lg border border-panelBorder bg-elevated px-3 py-2.5 text-center font-mono text-lg text-foreground outline-none focus:border-accent/50"
            />
            {!isCloseMode && markUsd > 0 ? (
              <button
                type="button"
                onClick={() => setPrice(formatNumber(markUsd, 2))}
                className="mt-1.5 w-full rounded border border-panelBorder bg-surface py-1 text-[10px] text-muted hover:bg-panelBorder"
              >
                填入当前标记价 {formatNumber(markUsd, 2)}
              </button>
            ) : null}
          </label>
        )}

        <div className="flex items-center justify-between text-xs text-subtle">
          <span>标记价</span>
          <span className="font-mono text-foreground">
            {markUsd > 0 ? formatNumber(markUsd, 2) : "—"}
          </span>
        </div>
        {indexPriceUsd > 0 ? (
          <div className="flex items-center justify-between text-xs text-subtle">
            <span>指数价</span>
            <span className="font-mono text-foreground">
              {formatNumber(indexPriceUsd, 2)}
            </span>
          </div>
        ) : null}

        <div className="rounded-lg border border-panelBorder bg-elevated px-3 py-2.5">
          <FundingRatePanel perp={selectedPerp} compact />
        </div>

        <label className="block text-xs text-subtle">
          <div className="mb-1.5 flex justify-between text-subtle">
            <span>数量</span>
            <span>{selectedMarket?.symbol ?? "BTC"}</span>
          </div>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.01"
            className="w-full rounded-lg border border-panelBorder bg-elevated px-3 py-2.5 text-sm text-foreground outline-none focus:border-accent/50"
          />
        </label>

        <div className="rounded-lg border border-panelBorder bg-elevated px-3 py-2 text-xs text-subtle">
          <div className="flex justify-between">
            <span>名义价值</span>
            <span className="font-mono text-foreground">
              {notional > 0 ? `${formatNumber(notional, 2)} USD` : "—"}
            </span>
          </div>
          {!isCloseMode && notional > 0 ? (
            <>
              <div className="mt-1.5 flex justify-between">
                <span>保证金（{leverage}x）</span>
                <span className="font-mono text-accent">
                  {formatNumber(marginRequired, 2)} USD
                </span>
              </div>
              {chainMinMargin > 0 ? (
                <div className="mt-1 flex justify-between text-[11px] text-faint">
                  <span>链上最低保证金</span>
                  <span className="font-mono">
                    {formatNumber(chainMinMargin, 2)} USD
                  </span>
                </div>
              ) : null}
            </>
          ) : null}
        </div>

        {/* Dealer 保证金余额 */}
        {address && onSepolia && (
          <div className={`rounded-lg border px-3 py-2 text-xs ${
            creditInsufficient
              ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
              : "border-panelBorder bg-elevated text-subtle"
          }`}>
            <div className="flex items-center justify-between">
              <span>Dealer 链上保证金</span>
              <span className={`font-mono ${creditInsufficient ? "text-amber-200" : "text-foreground"}`}>
                {dealerCreditHuman != null
                  ? `${formatNumber(dealerCreditHuman, 2)} USDC`
                  : "读取中…"}
              </span>
            </div>
            {creditInsufficient && (
              <p className="mt-1 leading-relaxed">
                保证金不足：{leverage}x 需约{" "}
                <span className="font-mono">{formatNumber(marginRequired, 2)}</span>{" "}
                USDC，请先在「账户」页存入链上保证金。
              </p>
            )}
            {leverageTooLowForChain && !creditInsufficient && (
              <p className="mt-1 leading-relaxed text-amber-300/90">
                杠杆过高：请降至 ≤{" "}
                {formatNumber(notional / chainMinMargin, 1)}x 或增加数量。
              </p>
            )}
          </div>
        )}

        {panelMode === "close" && !closeDraft ? (
          <p className="text-[11px] text-amber-400/90">
            请在下方的「仓位」列表中点击平仓，或切换至「开仓」。
          </p>
        ) : useSystemOpenPrice ? (
          <p className="text-[11px] leading-relaxed text-subtle">
            系统价由后端按订单簿查询（做多=卖一、做空=买一），切换方向会自动刷新。
          </p>
        ) : (
          <p className="text-[11px] leading-relaxed text-subtle">
            限价由您自行填写，将按该价格签名挂单；可与系统价不一致。
          </p>
        )}

        {err ? <p className="text-xs text-red-400">{err}</p> : null}
        {msg ? <p className="text-xs text-emerald-400">{msg}</p> : null}

        <button
          type="button"
          disabled={
            submitting ||
            !isConnected ||
            (panelMode === "close" && !closeDraft && !amount) ||
            (!isCloseMode && (creditInsufficient || leverageTooLowForChain))
          }
          onClick={() => void submit()}
          className={`w-full rounded-lg py-3.5 text-base font-bold disabled:opacity-45 ${
            side === "long" ? "bg-buy text-black" : "bg-sell text-white"
          }`}
        >
          {submitting
            ? "签名并提交…"
            : isCloseMode
              ? side === "long"
                ? "平空 / 买入"
                : "平多 / 卖出"
              : side === "long"
                ? "开多"
                : "开空"}
        </button>
      </div>
    </div>
  );
}
