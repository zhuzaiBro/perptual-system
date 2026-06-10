"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import {
  ColorType,
  CrosshairMode,
  UTCTimestamp,
  createChart,
  CandlestickSeries,
  HistogramSeries,
  ISeriesApi
} from "lightweight-charts";
import { KlinePoint } from "@/lib/types";
import { formatNumber, formatPercent } from "@/lib/format";
import { 
  ChartBarIcon, 
  Cog6ToothIcon, 
  ArrowsPointingOutIcon,
  PencilSquareIcon,
  CursorArrowRaysIcon
} from "@heroicons/react/24/outline";

type Option = {
  label: string;
  value: string;
};

type Props = {
  data: KlinePoint[];
  loading: boolean;
  error: string | null;
  resolution: string;
  onResolutionChange: (value: string) => void;
  options: Option[];
};

export default function Chart({
  data,
  loading,
  error,
  resolution,
  onResolutionChange,
  options
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ReturnType<typeof createChart> | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);

  const [hoverData, setHoverData] = useState<{
    open: number;
    high: number;
    low: number;
    close: number;
    change: number;
  } | null>(null);

  const latestData = useMemo(() => {
    if (!data.length) return null;
    const last = data[data.length - 1];
    const prev = data.length > 1 ? data[data.length - 2] : last;
    const change = prev.close ? (last.close - prev.close) / prev.close : 0;
    return {
      open: last.open,
      high: last.high,
      low: last.low,
      close: last.close,
      change
    };
  }, [data]);

  const displayData = hoverData || latestData;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const chart = createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: "#0c1220" },
        textColor: "#94a3b8",
        fontFamily: "system-ui"
      },
      grid: {
        vertLines: { color: "#1d2538" },
        horzLines: { color: "#1d2538" }
      },
      rightPriceScale: {
        borderColor: "#1d2538",
        scaleMargins: {
          top: 0.1,
          bottom: 0.2
        }
      },
      timeScale: {
        borderColor: "#1d2538",
        timeVisible: true,
        secondsVisible: false
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          labelBackgroundColor: "#1e293b"
        },
        horzLine: {
          labelBackgroundColor: "#1e293b"
        }
      }
    });

    chartRef.current = chart;
    
    // Candlestick Series
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderUpColor: "#22c55e",
      borderDownColor: "#ef4444",
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
      priceScaleId: 'right'
    });
    seriesRef.current = series;

    // Volume Series
    const volumeSeries = chart.addSeries(HistogramSeries, {
      color: "#3b82f6",
      priceFormat: {
        type: "volume"
      },
      priceScaleId: "", // Overlay
      scaleMargins: {
        top: 0.8,
        bottom: 0
      }
    });
    volumeSeriesRef.current = volumeSeries;

    // Crosshair move handler
    chart.subscribeCrosshairMove((param) => {
      if (
        param.time &&
        param.seriesData.has(series) &&
        param.point
      ) {
        const data = param.seriesData.get(series) as {
          open: number;
          high: number;
          low: number;
          close: number;
        } | undefined;
        
        if (data) {
          // Calculate change percentage from open (approximation for intra-candle)
          // Ideally we need previous close for exact change, but open-close diff is common for single candle inspect
          const change = (data.close - data.open) / data.open;
          setHoverData({ ...data, change });
        }
      } else {
        setHoverData(null);
      }
    });

    const resize = () => {
      chart.applyOptions({
        width: container.clientWidth,
        height: container.clientHeight
      });
    };
    resize();

    const observer = new ResizeObserver(resize);
    observer.observe(container);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!seriesRef.current) {
      return;
    }
    const mapped = data.map((item) => ({
      time: item.time as UTCTimestamp,
      open: item.open,
      high: item.high,
      low: item.low,
      close: item.close
    }));
    seriesRef.current.setData(mapped);

    if (volumeSeriesRef.current) {
      const volumeMapped = data.map((item) => ({
        time: item.time as UTCTimestamp,
        value: item.volume,
        color: item.close >= item.open ? "#22c55e80" : "#ef444480"
      }));
      volumeSeriesRef.current.setData(volumeMapped);
    }

    // Only fit content on first load or significant change, but for now we do it always
    // Better strategy: only if user hasn't scrolled
    // chartRef.current?.timeScale().fitContent(); 
    // Let's keep fitContent for now to ensure data is visible
    if (data.length > 0) {
        // chartRef.current?.timeScale().fitContent();
    }
  }, [data]);

  return (
    <div className="panel flex h-[500px] flex-col">
      {/* Top Toolbar */}
      <div className="flex items-center justify-between border-b border-panelBorder px-3 py-2">
        <div className="flex items-center gap-1">
          <span className="mr-2 text-xs font-semibold text-subtle">Time</span>
          {options.map((option) => (
            <button
              key={option.value}
              onClick={() => onResolutionChange(option.value)}
              className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
                option.value === resolution
                  ? "bg-accent text-black"
                  : "text-subtle hover:text-foreground"
              }`}
            >
              {option.label}
            </button>
          ))}
          <div className="mx-2 h-4 w-px bg-panelBorder" />
          <button className="rounded p-1 bg-elevated border-0 text-subtle hover:text-foreground">
             <ChartBarIcon className="h-4 w-4" />
          </button>
        </div>
        <div className="flex items-center gap-2">
           <button className="rounded p-1 bg-elevated border-0 text-subtle hover:text-foreground">
             <Cog6ToothIcon className="h-4 w-4" />
          </button>
          <button className="rounded p-1 bg-elevated border-0 text-subtle hover:text-foreground">
             <ArrowsPointingOutIcon className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Main Chart Area */}
      <div className="relative flex flex-1 overflow-hidden">
        {/* Left Toolbar (Fake) */}
        <div className="flex w-10 flex-col items-center gap-4 border-r border-panelBorder py-4">
             <button className="text-accent cursor-default"><CursorArrowRaysIcon className="h-5 w-5" /></button>
             <button className="text-subtle bg-elevated border-0 rounded-lg p-1 hover:text-foreground cursor-not-allowed"><PencilSquareIcon className="h-5 w-5" /></button>
             {/* Add more fake icons here to mimic TradingView */}
             <div className="h-px w-4 bg-panelBorder" />
        </div>

        {/* Chart Container */}
        <div className="relative flex-1 bg-surface">
           {/* Floating Info Panel */}
           {displayData && (
             <div className="absolute left-3 top-2 z-10 flex gap-4 text-xs font-medium select-none pointer-events-none">
                <span className="text-subtle">开=<span className={displayData.change >= 0 ? "text-buy" : "text-sell"}>{formatNumber(displayData.open, 2)}</span></span>
                <span className="text-subtle">高=<span className={displayData.change >= 0 ? "text-buy" : "text-sell"}>{formatNumber(displayData.high, 2)}</span></span>
                <span className="text-subtle">低=<span className={displayData.change >= 0 ? "text-buy" : "text-sell"}>{formatNumber(displayData.low, 2)}</span></span>
                <span className="text-subtle">收=<span className={displayData.change >= 0 ? "text-buy" : "text-sell"}>{formatNumber(displayData.close, 2)}</span></span>
                <span className={displayData.change >= 0 ? "text-buy" : "text-sell"}>
                   {formatNumber(displayData.close - displayData.open, 2)} ({formatPercent(displayData.change)})
                </span>
             </div>
           )}

           <div ref={containerRef} className="h-full w-full" />
           
           {loading && (
            <div className="absolute inset-0 flex items-center justify-center bg-elevated text-xs text-foreground">
              K线加载中...
            </div>
           )}
           {error && (
            <div className="absolute bottom-10 left-1/2 -translate-x-1/2 rounded bg-red-900/80 px-3 py-2 text-xs text-white">
              {error}
            </div>
           )}
        </div>
      </div>
    </div>
  );
}
