"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  NUMERIC_META,
  BOOLEAN_META,
  COMPANY_TYPE_OPTIONS,
  INCOME_BASIS_OPTIONS,
} from "@/lib/gold/fields";
import type { ApproxNumber, ExtractionResult } from "@/lib/extract/types";

/**
 * 抽取与复核面板。粘一段微信对话 → 结构化资质草稿 → 人工确认 → 落库。
 *
 * ## 为什么复核是这个功能的主体，而不是抽取
 *
 * 抽取只是一次 API 调用，UI 上就一个按钮。这个组件 80% 的篇幅在复核，
 * 因为**未经人工确认的模型输出不能用于资质判断** ——
 * 99.7% 的准确率意味着每 300 个字段判定错 1 个，而没人知道错的是哪个。
 * 复核动作是资质从"草稿"变成"判断依据"的唯一通道。
 *
 * ## 三条界面决定
 *
 * ① **每个字段旁边显示模型引用的客户原话。**
 *    复核的本质是"核对"，不是"审阅"。没有原文对照，人只能凭感觉点确认，
 *    那这道关卡就是假的。原话来自 ApproxNumber.rawText（prompt 铁律 3 强制）。
 *
 * ② **待复核字段（交叉校验命中）排在最前面并标红。**
 *    validate.ts 已经用确定性代码找出了可疑字段，这个信息必须顶到最上面 ——
 *    它是最高性价比的复核起点。
 *
 * ③ **模糊值不允许一键填成精确值。**
 *    模型说「36~47（估）」时，界面显示区间，人要么保留区间，要么打电话问清了
 *    再填精确值。UI 上不提供"取中间值"这种便捷操作 ——
 *    那是把编造包装成效率。
 */

type ExtractResponse = {
  ok: true;
  reused: boolean;
  interactionId: number;
  extractionRunId: number;
  qualificationId: number;
  status: string;
  data: ExtractionResult;
  violations: { field: string; kind: string; detail: string }[];
  reviewFields: string[];
  latencyMs: number;
  costCny: string | null;
  model: string;
  promptVersion: string;
};

/** 数值字段的可编辑状态。用字符串存，避免受控 input 上的 NaN 抖动 */
type NumDraft = {
  value: string;
  min: string;
  max: string;
  isApproximate: boolean;
  rawText: string;
};

const EMPTY_NUM: NumDraft = {
  value: "",
  min: "",
  max: "",
  isApproximate: false,
  rawText: "",
};

function toDraft(v: ApproxNumber | null | undefined): NumDraft {
  if (!v) return { ...EMPTY_NUM };
  return {
    value: v.value === null ? "" : String(v.value),
    min: v.min === null ? "" : String(v.min),
    max: v.max === null ? "" : String(v.max),
    isApproximate: v.isApproximate,
    rawText: v.rawText ?? "",
  };
}

function num(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * 草稿 → ApproxNumber。全空视为「未提及」返回 null。
 *
 * 注意 value 与 min/max 都空但 rawText 有内容时仍返回 null ——
 * 只有原话没有数值就是没有数值信息（标注规范：「信用卡刷了不少」→ 留空）。
 */
function fromDraft(d: NumDraft): ApproxNumber | null {
  const value = num(d.value);
  const min = num(d.min);
  const max = num(d.max);
  if (value === null && min === null && max === null) return null;
  return {
    value,
    min: min ?? value,
    max: max ?? value,
    isApproximate: d.isApproximate,
    rawText: d.rawText.trim(),
  };
}

/** 三态布尔：未提及 / 是 / 否 */
function TriToggle({
  value,
  onChange,
}: {
  value: boolean | null;
  onChange: (v: boolean | null) => void;
}) {
  const opts: { v: boolean | null; label: string }[] = [
    { v: null, label: "未提及" },
    { v: true, label: "是" },
    { v: false, label: "否" },
  ];
  return (
    <div className="flex gap-1">
      {opts.map((o) => (
        <button
          key={String(o.v)}
          type="button"
          onClick={() => onChange(o.v)}
          className={[
            "rounded-md px-2 py-1 text-xs ring-1",
            value === o.v
              ? "bg-slate-900 text-white ring-slate-900"
              : "bg-white text-slate-600 ring-slate-200",
          ].join(" ")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function EvidenceLine({ raw }: { raw: string }) {
  if (!raw) {
    return (
      <p className="mt-1 text-xs text-slate-400">
        无原文引用 —— 模型没给依据，这条要特别小心
      </p>
    );
  }
  return (
    <p className="mt-1 text-xs text-slate-500">
      客户原话：<span className="text-slate-700">「{raw}」</span>
    </p>
  );
}

export default function ExtractPanel({ leadId }: { leadId: number }) {
  const router = useRouter();
  const [rawText, setRawText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<ExtractResponse | null>(null);
  const [saved, setSaved] = useState(false);

  // 复核草稿
  const [nums, setNums] = useState<Record<string, NumDraft>>({});
  const [bools, setBools] = useState<Record<string, boolean | null>>({});
  const [age, setAge] = useState("");
  const [city, setCity] = useState("");
  const [companyType, setCompanyType] = useState<string>("");
  const [incomeBasis, setIncomeBasis] = useState<string>("");
  const [checked, setChecked] = useState<Set<string>>(new Set());

  function loadDrafts(d: ExtractionResult) {
    const n: Record<string, NumDraft> = {};
    for (const m of NUMERIC_META) {
      n[m.key] = toDraft(d[m.key] as ApproxNumber | null);
    }
    setNums(n);
    const b: Record<string, boolean | null> = {};
    for (const m of BOOLEAN_META) b[m.key] = d[m.key] ?? null;
    setBools(b);
    setAge(d.age === null ? "" : String(d.age));
    setCity(d.city ?? "");
    setCompanyType(d.companyType ?? "");
    setIncomeBasis(d.incomeBasis ?? "");
    setChecked(new Set());
    setSaved(false);
  }

  async function extract() {
    setErr(null);
    setBusy(true);
    try {
      const r = await fetch(`/api/leads/${leadId}/extract`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rawText }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok) {
        setErr(j?.error?.message ?? "抽取失败");
        return;
      }
      setRes(j);
      loadDrafts(j.data);
    } catch {
      setErr("网络错误");
    } finally {
      setBusy(false);
    }
  }

  async function saveReview() {
    if (!res) return;
    setErr(null);
    setBusy(true);
    try {
      const patch: Record<string, unknown> = {};
      for (const m of NUMERIC_META) patch[m.key] = fromDraft(nums[m.key] ?? EMPTY_NUM);
      for (const m of BOOLEAN_META) patch[m.key] = bools[m.key] ?? null;
      patch.age = num(age);
      patch.city = city.trim() || null;
      patch.companyType = companyType || null;
      patch.incomeBasis = incomeBasis || null;

      const r = await fetch(`/api/leads/${leadId}/extract`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          qualificationId: res.qualificationId,
          patch,
          verifiedFields: [...checked],
        }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok) {
        setErr(j?.error?.message ?? "保存失败");
        return;
      }
      setSaved(true);
      /** 刷新后 MatchPanel 重新拉取，能看到 verified 标记与新判定 */
      router.refresh();
    } catch {
      setErr("网络错误");
    } finally {
      setBusy(false);
    }
  }

  const toggle = (k: string) =>
    setChecked((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  const review = new Set(res?.reviewFields ?? []);

  /** 待复核的排前面 —— 它们是最高性价比的复核起点 */
  const numericOrdered = [
    ...NUMERIC_META.filter((m) => review.has(m.key)),
    ...NUMERIC_META.filter((m) => !review.has(m.key)),
  ];

  if (!res) {
    return (
      <div className="space-y-2">
        <label className="block text-xs text-slate-500">
          粘贴微信对话原文 → AI 抽取资质
        </label>
        <textarea
          value={rawText}
          onChange={(e) => setRawText(e.target.value)}
          rows={4}
          placeholder="把和客户的聊天记录整段粘进来，多轮、口语、错别字都没关系"
          className="w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm"
        />
        <button
          onClick={extract}
          disabled={busy || rawText.trim().length < 10}
          className="w-full rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? "抽取中…（约 5-15 秒）" : "AI 抽取资质"}
        </button>
        <p className="text-xs text-slate-400">
          抽取结果是**草稿**，需逐字段核对后才会用于产品匹配
        </p>
        {err && (
          <p className="rounded-lg bg-rose-50 p-2 text-xs text-rose-700">{err}</p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-indigo-700 ring-1 ring-indigo-200">
          {res.reused ? "复用已有抽取（未重复计费）" : `抽取完成 ${res.latencyMs}ms`}
        </span>
        <span className="text-slate-400">
          {res.model} · {res.promptVersion}
          {res.costCny && ` · ¥${res.costCny}`}
        </span>
      </div>

      {res.status === "degraded" && (
        <p className="rounded-lg bg-amber-50 p-2 text-xs text-amber-800">
          交叉校验发现异常，部分字段已降级为待复核 —— 下面标红的字段优先核对
        </p>
      )}

      {res.violations.length > 0 && (
        <ul className="space-y-1 rounded-lg bg-orange-50 p-2">
          {res.violations.map((v, i) => (
            <li key={i} className="text-xs text-orange-800">
              <span className="font-medium">{v.field}</span>：{v.detail}
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-2.5">
        {numericOrdered.map((m) => {
          const d = nums[m.key] ?? EMPTY_NUM;
          const flagged = review.has(m.key);
          return (
            <div
              key={m.key}
              className={[
                "rounded-lg border p-2.5",
                flagged ? "border-orange-300 bg-orange-50/40" : "border-slate-200 bg-white",
              ].join(" ")}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <span className="text-sm font-medium text-slate-900">{m.label}</span>
                  {m.hard && (
                    <span className="ml-1 rounded bg-slate-900 px-1 text-[10px] text-white">
                      硬阈值
                    </span>
                  )}
                  {flagged && (
                    <span className="ml-1 text-xs text-orange-700">待复核</span>
                  )}
                </div>
                <label className="flex shrink-0 items-center gap-1 text-xs text-slate-600">
                  <input
                    type="checkbox"
                    checked={checked.has(m.key)}
                    onChange={() => toggle(m.key)}
                    className="h-4 w-4"
                  />
                  已核对
                </label>
              </div>

              <EvidenceLine raw={d.rawText} />

              <div className="mt-1.5 grid grid-cols-3 gap-1.5">
                <input
                  value={d.value}
                  onChange={(e) =>
                    setNums((s) => ({ ...s, [m.key]: { ...d, value: e.target.value } }))
                  }
                  placeholder="精确值"
                  inputMode="numeric"
                  className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                />
                <input
                  value={d.min}
                  onChange={(e) =>
                    setNums((s) => ({ ...s, [m.key]: { ...d, min: e.target.value } }))
                  }
                  placeholder="下界"
                  inputMode="numeric"
                  className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                />
                <input
                  value={d.max}
                  onChange={(e) =>
                    setNums((s) => ({ ...s, [m.key]: { ...d, max: e.target.value } }))
                  }
                  placeholder="上界"
                  inputMode="numeric"
                  className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                />
              </div>

              <label className="mt-1.5 flex items-center gap-1.5 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={d.isApproximate}
                  onChange={(e) =>
                    setNums((s) => ({
                      ...s,
                      [m.key]: { ...d, isApproximate: e.target.checked },
                    }))
                  }
                  className="h-3.5 w-3.5"
                />
                模糊值（判断时按下界取，宁可少推一单）
              </label>

              <p className="mt-1 text-[11px] leading-relaxed text-slate-400">{m.hint}</p>

              {m.key === "monthlyIncome" && (
                <div className="mt-1.5">
                  <span className="text-xs text-slate-500">收入口径</span>
                  <div className="mt-1 flex gap-1">
                    {[{ value: "", label: "未提及" }, ...INCOME_BASIS_OPTIONS].map((o) => (
                      <button
                        key={o.value}
                        type="button"
                        onClick={() => setIncomeBasis(o.value)}
                        className={[
                          "rounded-md px-2 py-1 text-xs ring-1",
                          incomeBasis === o.value
                            ? "bg-slate-900 text-white ring-slate-900"
                            : "bg-white text-slate-600 ring-slate-200",
                        ].join(" ")}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {BOOLEAN_META.map((m) => (
          <div
            key={m.key}
            className="rounded-lg border border-slate-200 bg-white p-2.5"
          >
            <div className="flex items-start justify-between gap-2">
              <span className="text-sm font-medium text-slate-900">{m.label}</span>
              <label className="flex shrink-0 items-center gap-1 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={checked.has(m.key)}
                  onChange={() => toggle(m.key)}
                  className="h-4 w-4"
                />
                已核对
              </label>
            </div>
            <div className="mt-1.5">
              <TriToggle
                value={bools[m.key] ?? null}
                onChange={(v) => setBools((s) => ({ ...s, [m.key]: v }))}
              />
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-slate-400">{m.hint}</p>
          </div>
        ))}

        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-lg border border-slate-200 bg-white p-2.5">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-slate-900">年龄</span>
              <label className="flex items-center gap-1 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={checked.has("age")}
                  onChange={() => toggle("age")}
                  className="h-4 w-4"
                />
                已核对
              </label>
            </div>
            <input
              value={age}
              onChange={(e) => setAge(e.target.value)}
              inputMode="numeric"
              placeholder="未提及"
              className="mt-1.5 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            />
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-2.5">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-slate-900">城市</span>
              <label className="flex items-center gap-1 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={checked.has("city")}
                  onChange={() => toggle("city")}
                  className="h-4 w-4"
                />
                已核对
              </label>
            </div>
            <input
              value={city}
              onChange={(e) => setCity(e.target.value)}
              placeholder="未提及"
              className="mt-1.5 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            />
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-2.5">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-slate-900">单位性质</span>
            <label className="flex items-center gap-1 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={checked.has("companyType")}
                onChange={() => toggle("companyType")}
                className="h-4 w-4"
              />
              已核对
            </label>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {[{ value: "", label: "未提及" }, ...COMPANY_TYPE_OPTIONS].map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => setCompanyType(o.value)}
                className={[
                  "rounded-md px-2 py-1 text-xs ring-1",
                  companyType === o.value
                    ? "bg-slate-900 text-white ring-slate-900"
                    : "bg-white text-slate-600 ring-slate-200",
                ].join(" ")}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {err && <p className="rounded-lg bg-rose-50 p-2 text-xs text-rose-700">{err}</p>}

      {saved ? (
        <div className="space-y-2">
          <p className="rounded-lg bg-emerald-50 p-2 text-sm text-emerald-800">
            已保存。已核对 {checked.size} 个字段 —— 只有这些会被当作判断依据。
          </p>
          <button
            onClick={() => {
              setRes(null);
              setRawText("");
            }}
            className="w-full rounded-lg bg-white px-3 py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-300"
          >
            再抽取一段对话
          </button>
        </div>
      ) : (
        <>
          <button
            onClick={saveReview}
            disabled={busy}
            className="w-full rounded-lg bg-indigo-600 px-3 py-2.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? "保存中…" : `保存复核结果（已勾 ${checked.size} 项）`}
          </button>
          <p className="text-xs text-slate-400">
            没勾「已核对」的字段仍会存下来，但规则引擎会当作未确认数据处理
          </p>
        </>
      )}
    </div>
  );
}
