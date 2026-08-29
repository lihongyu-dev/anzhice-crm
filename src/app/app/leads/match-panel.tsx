"use client";

import { useState } from "react";
import type { MatchReport, ProductMatch, MatchStatus } from "@/lib/match/engine";
import type { QualSource } from "@/lib/match/queries";

/**
 * 资质匹配面板。展开线索卡片后按需加载。
 *
 * ## 三条展示原则，对应引擎的三条设计原则
 *
 * ① **「不知道」和「不满足」必须视觉可分。**
 *    引擎里 unknown 绝不当 fail 处理，UI 也不能把两者画成一样 ——
 *    否则信息不全的客户看起来就像被拒了，而他们恰恰最该被追问。
 *
 * ② **缺失字段清单排在最前面，不排在最后。**
 *    这份清单的实际用途是「下一通电话先问什么」，它是行动项，不是补充说明。
 *    车上扫一眼要先看到该问什么，而不是先看五个产品的详细判定。
 *
 * ③ **免责声明不可折叠、不可关闭。**
 *    引擎的 disclaimer 字段是随结果一起返回的，这里必须原样展示。
 *    撮合方无牌照 —— 这是法律边界，不是 UI 品味问题。
 */

const STATUS_STYLE: Record<MatchStatus, { label: string; cls: string; dot: string }> = {
  eligible: {
    label: "可尝试",
    cls: "bg-emerald-50 text-emerald-800 ring-emerald-200",
    dot: "bg-emerald-500",
  },
  need_info: {
    label: "待补信息",
    cls: "bg-amber-50 text-amber-800 ring-amber-200",
    dot: "bg-amber-500",
  },
  not_eligible: {
    label: "不满足公开条件",
    cls: "bg-slate-100 text-slate-600 ring-slate-200",
    dot: "bg-slate-400",
  },
};

/** 资质数据来源提示。让人一眼知道这判定基于什么质量的数据 */
const SOURCE_HINT: Record<QualSource, { text: string; cls: string }> = {
  verified: {
    text: "关键字段已人工确认",
    cls: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  },
  extracted: {
    text: "AI 抽取，未人工确认",
    cls: "bg-amber-50 text-amber-700 ring-amber-200",
  },
  empty: {
    text: "尚无资质记录，以下为「该问什么」清单",
    cls: "bg-sky-50 text-sky-700 ring-sky-200",
  },
};

type MatchData = {
  leadId: number;
  source: QualSource;
  verifiedFields: string[];
  reviewFields: string[];
  qualUpdatedAt: string | null;
  report: MatchReport;
};

function ProductRow({ m }: { m: ProductMatch }) {
  const [open, setOpen] = useState(false);
  const s = STATUS_STYLE[m.status];

  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${s.dot}`} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-slate-900">
            {m.productName}
          </span>
          <span className="mt-0.5 block text-xs text-slate-500">
            {m.status === "not_eligible" && m.blockers.length > 0
              ? m.blockers[0].reason
              : m.status === "need_info"
                ? `缺 ${m.missing.length} 项`
                : "公开条件均满足"}
          </span>
        </span>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ring-1 ${s.cls}`}>
          {s.label}
        </span>
        <span className="shrink-0 text-xs text-slate-400">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="space-y-2 border-t border-slate-100 px-3 py-2.5">
          {/*
            逐项判定。fail 在前、unknown 在中、pass 在后 ——
            人看这块是为了找问题，不是为了确认哪些通过了。
          */}
          <ul className="space-y-1">
            {[
              ...m.checks.filter((c) => c.status === "fail"),
              ...m.checks.filter((c) => c.status === "unknown"),
              ...m.checks.filter((c) => c.status === "pass"),
            ].map((c, i) => (
              <li key={`${c.field}-${i}`} className="flex gap-2 text-xs">
                <span
                  className={
                    c.status === "fail"
                      ? "shrink-0 text-rose-600"
                      : c.status === "unknown"
                        ? "shrink-0 text-amber-600"
                        : "shrink-0 text-emerald-600"
                  }
                >
                  {c.status === "fail" ? "✕" : c.status === "unknown" ? "?" : "✓"}
                </span>
                <span className="text-slate-500">{c.label}</span>
                <span className="min-w-0 flex-1 text-slate-700">{c.reason}</span>
              </li>
            ))}
          </ul>

          <p className="border-t border-slate-100 pt-2 text-xs text-slate-500">
            {m.referenceRate}
          </p>
          {m.notes && <p className="text-xs text-slate-400">{m.notes}</p>}
        </div>
      )}
    </div>
  );
}

export default function MatchPanel({ leadId }: { leadId: number }) {
  const [data, setData] = useState<MatchData | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setErr(null);
    setBusy(true);
    try {
      const r = await fetch(`/api/leads/${leadId}/match`);
      const j = await r.json().catch(() => null);
      if (!r.ok) {
        setErr(j?.error?.message ?? "加载匹配结果失败");
        return;
      }
      setData(j);
    } catch {
      setErr("网络错误");
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return (
      <div>
        <button
          onClick={load}
          disabled={busy}
          className="w-full rounded-lg bg-white px-3 py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-300 disabled:opacity-50"
        >
          {busy ? "匹配中…" : "看能推哪些产品"}
        </button>
        {err && (
          <p className="mt-2 rounded-lg bg-rose-50 p-2 text-xs text-rose-700">{err}</p>
        )}
      </div>
    );
  }

  const { report, source, reviewFields } = data;
  const hint = SOURCE_HINT[source];

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`rounded-full px-2 py-0.5 text-xs ring-1 ${hint.cls}`}>
          {hint.text}
        </span>
        <span className="text-xs text-slate-400">
          可尝试 {report.summary.eligible} · 待补 {report.summary.needInfo} · 不满足{" "}
          {report.summary.notEligible}
        </span>
      </div>

      {reviewFields.length > 0 && (
        <p className="rounded-lg bg-orange-50 p-2 text-xs text-orange-800">
          需复核字段：{reviewFields.join("、")} —— 交叉校验发现异常，建议打电话确认
        </p>
      )}

      {/*
        「下一通电话问什么」放在产品列表之前。
        这是整个面板唯一的行动项，其余都是判定依据。
      */}
      {report.topMissingFields.length > 0 && (
        <div className="rounded-lg bg-slate-900 p-3">
          <p className="text-xs font-medium text-slate-300">下一通电话先问</p>
          <ol className="mt-1.5 space-y-1">
            {report.topMissingFields.slice(0, 4).map((f, i) => (
              <li key={f.field} className="flex items-baseline gap-2 text-sm text-white">
                <span className="text-xs text-slate-500">{i + 1}</span>
                <span className="flex-1">{f.label}</span>
                <span className="text-xs text-slate-400">
                  影响 {f.count} 款
                </span>
              </li>
            ))}
          </ol>
          <p className="mt-2 text-xs text-slate-500">
            按影响产品数排序 —— 问第一个能同时推进最多款判定
          </p>
        </div>
      )}

      <div className="space-y-1.5">
        {report.matches.map((m) => (
          <ProductRow key={m.productId} m={m} />
        ))}
      </div>

      {/* 引擎随结果返回的免责声明，原样展示，不折叠 */}
      <p className="rounded-lg bg-slate-50 p-2 text-xs leading-relaxed text-slate-500">
        {report.disclaimer}
      </p>
    </div>
  );
}
