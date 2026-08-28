"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  NUMERIC_META,
  BOOLEAN_META,
  COMPANY_TYPE_OPTIONS,
  INCOME_BASIS_OPTIONS,
  type GoldAnswer,
} from "@/lib/gold/fields";
import type { GoldStats } from "@/lib/gold/queries";

/**
 * 标注表单。
 *
 * 四个设计决定，都来自《标注规范 v1.0》，不要为了省事改掉：
 *
 * ① 数值字段用「未提及 / 精确 / 模糊」三选，而不是直接给 value/min/max 输入框。
 *    选「模糊」时 value 强制为 null —— 规范第 2 节的硬规则由 UI 保证，
 *    而不是靠标注人记得。
 *
 * ② 布尔字段是三个并排按钮（是/否/未提及），不用勾选框。
 *    勾选框天然只有两态，null 会被误当 false，
 *    而 null 与 false 的区分正是「空值判定正确率」这个核心指标的判定基础。
 *
 * ③ 所有字段初始为「未填」（mode/val = null），不预选任何选项。
 *    2026-08-27 首版曾把「未提及」作为默认选中态，问题是分不清
 *    「我判断这条对话没提」和「我忘了填」—— 两者对 gold 质量的影响完全不同。
 *    现在必须显式点过才算填，提交时校验拦截。
 *    为避免逐条点击的摩擦，提供「其余全标未提及」一键补齐。
 *
 * ④ 规范口径默认折叠，点 ? 展开。翻文档会导致凭记忆标，
 *    但常驻两行灰字在十几个字段上堆积会变成视觉噪声。
 */

type NumMode = "none" | "exact" | "approx";

type NumState = {
  /** null = 尚未填写。见设计决定 ③ */
  mode: NumMode | null;
  value: string;
  min: string;
  max: string;
  rawText: string;
};

/** "none" = 显式判断为未提及；null = 尚未填写 */
type BoolVal = true | false | "none";

const emptyNum = (): NumState => ({
  mode: null,
  value: "",
  min: "",
  max: "",
  rawText: "",
});

const freshNums = () =>
  Object.fromEntries(NUMERIC_META.map((m) => [m.key, emptyNum()])) as Record<
    string,
    NumState
  >;

const freshBools = () =>
  Object.fromEntries(BOOLEAN_META.map((m) => [m.key, null])) as Record<
    string,
    BoolVal | null
  >;

export default function LabelForm({
  setName,
  stats,
}: {
  setName: string;
  stats: GoldStats;
}) {
  const router = useRouter();

  const [rawText, setRawText] = useState("");
  const [origin, setOrigin] = useState<"real" | "synthetic" | null>(null);
  const [nums, setNums] = useState<Record<string, NumState>>(freshNums);
  const [bools, setBools] = useState<Record<string, BoolVal | null>>(freshBools);
  const [incomeBasis, setIncomeBasis] = useState<string | null>(null);
  const [age, setAge] = useState("");
  const [city, setCity] = useState("");
  const [companyType, setCompanyType] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [hasCorrection, setHasCorrection] = useState(false);
  const [pendingReview, setPendingReview] = useState(false);

  const [openHints, setOpenHints] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null
  );

  const toggleHint = (k: string) =>
    setOpenHints((p) => ({ ...p, [k]: !p[k] }));

  /** 未填字段数，显示在底部操作条上 */
  const unsetCount =
    NUMERIC_META.filter((m) => nums[m.key].mode === null).length +
    BOOLEAN_META.filter((m) => bools[m.key] === null).length;

  /** 一键把所有未填字段标为「显式未提及」，减少逐条点击的摩擦 */
  function markRestUnmentioned() {
    setNums((prev) => {
      const next = { ...prev };
      for (const m of NUMERIC_META) {
        if (next[m.key].mode === null) {
          next[m.key] = { ...next[m.key], mode: "none" };
        }
      }
      return next;
    });
    setBools((prev) => {
      const next = { ...prev };
      for (const m of BOOLEAN_META) {
        if (next[m.key] === null) next[m.key] = "none";
      }
      return next;
    });
  }

  function reset() {
    setRawText("");
    setOrigin(null);
    setNums(freshNums());
    setBools(freshBools());
    setIncomeBasis(null);
    setAge("");
    setCity("");
    setCompanyType(null);
    setNote("");
    setHasCorrection(false);
    setPendingReview(false);
    setOpenHints({});
  }

  function buildAnswer(): { answer: GoldAnswer } | { error: string } {
    // 设计决定 ③：未显式填写的字段一律拦截，不静默当作未提及
    const unsetNum = NUMERIC_META.filter((m) => nums[m.key].mode === null);
    const unsetBool = BOOLEAN_META.filter((m) => bools[m.key] === null);
    if (unsetNum.length || unsetBool.length) {
      const names = [...unsetNum, ...unsetBool].map((m) => m.label);
      return {
        error: `还有 ${names.length} 个字段没填：${names.slice(0, 3).join("、")}${
          names.length > 3 ? "…" : ""
        }。确认没提到就点「其余全标未提及」`,
      };
    }

    const answer: Record<string, unknown> = {};

    for (const m of NUMERIC_META) {
      const s = nums[m.key];
      if (s.mode === "none") {
        answer[m.key] = null;
        continue;
      }
      if (!s.rawText.trim()) {
        return { error: `「${m.label}」填了值但没填原文片段` };
      }
      if (s.mode === "exact") {
        const v = Number(s.value);
        if (s.value === "" || Number.isNaN(v)) {
          return { error: `「${m.label}」精确值没填或不是数字` };
        }
        answer[m.key] = {
          value: v,
          min: v,
          max: v,
          isApproximate: false,
          rawText: s.rawText.trim(),
        };
      } else {
        const hasMin = s.min !== "";
        const hasMax = s.max !== "";
        if (!hasMin && !hasMax) {
          return { error: `「${m.label}」标为模糊但上下界都没填` };
        }
        const min = hasMin ? Number(s.min) : null;
        const max = hasMax ? Number(s.max) : null;
        if ((hasMin && Number.isNaN(min)) || (hasMax && Number.isNaN(max))) {
          return { error: `「${m.label}」区间不是数字` };
        }
        if (min !== null && max !== null && min > max) {
          return { error: `「${m.label}」下界大于上界` };
        }
        answer[m.key] = {
          // 规范第 2 节：模糊值 value 必须为 null，否则保守取值机制失效
          value: null,
          min,
          max,
          isApproximate: true,
          rawText: s.rawText.trim(),
        };
      }
    }

    for (const m of BOOLEAN_META) {
      const v = bools[m.key];
      answer[m.key] = v === "none" ? null : v;
    }

    answer.incomeBasis = incomeBasis ?? null;
    answer.companyType = companyType ?? null;
    answer.city = city.trim() === "" ? null : city.trim();
    if (age.trim() === "") {
      answer.age = null;
    } else {
      const a = Number(age);
      if (!Number.isInteger(a) || a < 16 || a > 100) {
        return { error: "年龄需为 16-100 的整数，模糊年龄请留空" };
      }
      answer.age = a;
    }

    return { answer: answer as GoldAnswer };
  }

  async function submit() {
    setMsg(null);
    if (rawText.trim().length < 10) {
      setMsg({ kind: "err", text: "对话原文太短，至少 10 字" });
      return;
    }
    if (!origin) {
      setMsg({ kind: "err", text: "必须选择语料来源（真实 / 合成）" });
      return;
    }
    const built = buildAnswer();
    if ("error" in built) {
      setMsg({ kind: "err", text: built.error });
      return;
    }

    setSaving(true);
    try {
      const r = await fetch("/api/gold-labels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          setName,
          rawText: rawText.trim(),
          expected: built.answer,
          origin,
          note: note.trim() === "" ? null : note.trim(),
          hasCorrection,
          pendingReview,
        }),
      });
      const j = await r.json();
      if (!r.ok) {
        const detail = j?.error?.issues?.[0]
          ? `${j.error.issues[0].path}: ${j.error.issues[0].message}`
          : (j?.error?.message ?? "保存失败");
        setMsg({ kind: "err", text: detail });
        return;
      }
      setMsg({ kind: "ok", text: `已保存 #${j.id}` });
      reset();
      router.refresh();
    } catch {
      setMsg({ kind: "err", text: "网络错误，未保存" });
    } finally {
      setSaving(false);
    }
  }

  const hintBtn = (key: string) => (
    <button
      type="button"
      onClick={() => toggleHint(key)}
      aria-label="显示标注口径"
      aria-expanded={!!openHints[key]}
      className={`ml-1 inline-flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] leading-none ${
        openHints[key]
          ? "border-slate-900 bg-slate-900 text-white"
          : "border-slate-300 bg-white text-slate-500"
      }`}
    >
      ?
    </button>
  );

  return (
    // pb-44：底部操作条是 fixed 的，留白不足会盖住最后一个字段
    <div className="mx-auto w-full max-w-6xl px-3 py-4 pb-44 sm:px-5">
      <header className="mb-4">
        <h1 className="text-lg font-semibold">标注工作台</h1>
        <p className="mt-1 text-xs leading-relaxed text-slate-500">
          标注集 <code className="rounded bg-slate-200 px-1">{setName}</code>
          ｜盲标：本页不显示任何模型输出
        </p>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
          <span>
            已标 <b className="text-slate-900">{stats.total}</b> / 100
          </span>
          <span>真实 {stats.real}</span>
          <span>合成 {stats.synthetic}</span>
          <span>待议 {stats.pending}</span>
          <span>有改口 {stats.corrections}</span>
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* 左：原文 */}
        <section className="lg:sticky lg:top-4 lg:self-start">
          <label className="mb-1 block text-sm font-medium">对话原文</label>
          <textarea
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            placeholder="粘贴微信对话原文，保留客户的原话，不要改写"
            className="h-56 w-full resize-y rounded-lg border border-slate-300 bg-white p-3 text-sm leading-relaxed outline-none focus:border-slate-900 lg:h-[60vh]"
          />
          <div className="mt-2">
            <span className="mr-2 text-sm font-medium">语料来源</span>
            <div className="mt-1 flex gap-2">
              {(
                [
                  ["real", "真实"],
                  ["synthetic", "合成"],
                ] as const
              ).map(([v, l]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setOrigin(v)}
                  className={`flex-1 rounded-lg border px-3 py-2 text-sm ${
                    origin === v
                      ? "border-slate-900 bg-slate-900 text-white"
                      : "border-slate-300 bg-white text-slate-700"
                  }`}
                >
                  {l}
                </button>
              ))}
            </div>
            <p className="mt-1 text-xs text-slate-500">
              必选。报告中要如实披露真实/合成构成比例
            </p>
          </div>
        </section>

        {/* 右：填答案 */}
        <section className="space-y-4">
          {NUMERIC_META.map((m) => {
            const s = nums[m.key];
            const set = (patch: Partial<NumState>) =>
              setNums((prev) => ({
                ...prev,
                [m.key]: { ...prev[m.key], ...patch },
              }));
            return (
              <div
                key={m.key}
                className={`rounded-lg border bg-white p-3 ${
                  s.mode === null ? "border-slate-300" : "border-slate-200"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center text-sm font-medium">
                    {m.label}
                    {m.hard && (
                      <span
                        className="ml-1 text-amber-600"
                        title="硬阈值字段，抽错代价最高"
                      >
                        ★
                      </span>
                    )}
                    {hintBtn(m.key)}
                  </span>
                  <span className="text-xs text-slate-400">{m.unit}</span>
                </div>

                <div className="mt-2 flex gap-1.5">
                  {(
                    [
                      ["none", "未提及"],
                      ["exact", "精确"],
                      ["approx", "模糊"],
                    ] as const
                  ).map(([v, l]) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => set({ mode: v })}
                      className={`flex-1 rounded-md border px-2 py-2.5 text-xs ${
                        s.mode === v
                          ? v === "none"
                            ? "border-slate-500 bg-slate-500 text-white"
                            : "border-slate-900 bg-slate-900 text-white"
                          : "border-slate-300 bg-white text-slate-600"
                      }`}
                    >
                      {l}
                    </button>
                  ))}
                </div>

                {s.mode === "exact" && (
                  <input
                    type="number"
                    value={s.value}
                    onChange={(e) => set({ value: e.target.value })}
                    placeholder="确定数值"
                    className="mt-2 w-full rounded-md border border-slate-300 px-2 py-2 text-sm outline-none focus:border-slate-900"
                  />
                )}

                {s.mode === "approx" && (
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      type="number"
                      value={s.min}
                      onChange={(e) => set({ min: e.target.value })}
                      placeholder="下界"
                      className="w-full rounded-md border border-slate-300 px-2 py-2 text-sm outline-none focus:border-slate-900"
                    />
                    <span className="text-slate-400">~</span>
                    <input
                      type="number"
                      value={s.max}
                      onChange={(e) => set({ max: e.target.value })}
                      placeholder="上界"
                      className="w-full rounded-md border border-slate-300 px-2 py-2 text-sm outline-none focus:border-slate-900"
                    />
                  </div>
                )}

                {s.mode !== null && s.mode !== "none" && (
                  <input
                    value={s.rawText}
                    onChange={(e) => set({ rawText: e.target.value })}
                    placeholder="原文片段（原样摘录，不改写）"
                    className="mt-2 w-full rounded-md border border-slate-300 px-2 py-2 text-sm outline-none focus:border-slate-900"
                  />
                )}

                {openHints[m.key] && (
                  <p className="mt-2 rounded-md bg-slate-50 p-2 text-xs leading-relaxed text-slate-600">
                    {m.hint}
                  </p>
                )}

                {m.key === "monthlyIncome" &&
                  s.mode !== null &&
                  s.mode !== "none" && (
                    <div className="mt-2">
                      <span className="text-xs font-medium text-slate-600">
                        收入口径
                      </span>
                      <div className="mt-1 flex gap-1.5">
                        {INCOME_BASIS_OPTIONS.map((o) => (
                          <button
                            key={o.value}
                            type="button"
                            onClick={() => setIncomeBasis(o.value)}
                            className={`flex-1 rounded-md border px-2 py-2 text-xs ${
                              incomeBasis === o.value
                                ? "border-slate-900 bg-slate-900 text-white"
                                : "border-slate-300 bg-white text-slate-600"
                            }`}
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
              className={`rounded-lg border bg-white p-3 ${
                bools[m.key] === null ? "border-slate-300" : "border-slate-200"
              }`}
            >
              <span className="flex items-center text-sm font-medium">
                {m.label}
                {hintBtn(m.key)}
              </span>
              <div className="mt-2 flex gap-1.5">
                {(
                  [
                    [true, "是"],
                    [false, "否"],
                    ["none", "未提及"],
                  ] as const
                ).map(([v, l]) => (
                  <button
                    key={String(v)}
                    type="button"
                    onClick={() => setBools((p) => ({ ...p, [m.key]: v }))}
                    className={`flex-1 rounded-md border px-2 py-2.5 text-xs ${
                      bools[m.key] === v
                        ? v === "none"
                          ? "border-slate-500 bg-slate-500 text-white"
                          : "border-slate-900 bg-slate-900 text-white"
                        : "border-slate-300 bg-white text-slate-600"
                    }`}
                  >
                    {l}
                  </button>
                ))}
              </div>
              {openHints[m.key] && (
                <p className="mt-2 rounded-md bg-slate-50 p-2 text-xs leading-relaxed text-slate-600">
                  {m.hint}
                </p>
              )}
            </div>
          ))}

          <div className="rounded-lg border border-slate-200 bg-white p-3">
            <span className="flex items-center text-sm font-medium">
              单位性质 <span className="ml-1 text-amber-600">★</span>
              {hintBtn("companyType")}
            </span>
            <div className="mt-2 grid grid-cols-2 gap-1.5">
              {COMPANY_TYPE_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() =>
                    setCompanyType(companyType === o.value ? null : o.value)
                  }
                  className={`rounded-md border px-2 py-2.5 text-xs ${
                    companyType === o.value
                      ? "border-slate-900 bg-slate-900 text-white"
                      : "border-slate-300 bg-white text-slate-600"
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
            {openHints.companyType && (
              <p className="mt-2 rounded-md bg-slate-50 p-2 text-xs leading-relaxed text-slate-600">
                「自己开公司」→ 个体/自由职业。企业主与工薪族走不同规则集，归错类会用错规则
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-slate-200 bg-white p-3">
              <span className="flex items-center text-sm font-medium">
                年龄{hintBtn("age")}
              </span>
              <input
                type="number"
                value={age}
                onChange={(e) => setAge(e.target.value)}
                placeholder="留空=未提及"
                className="mt-2 w-full rounded-md border border-slate-300 px-2 py-2 text-sm outline-none focus:border-slate-900"
              />
              {openHints.age && (
                <p className="mt-2 rounded-md bg-slate-50 p-2 text-xs leading-relaxed text-slate-600">
                  「三十出头」这类模糊年龄留空。「85年的」可算=40
                </p>
              )}
            </div>
            <div className="rounded-lg border border-slate-200 bg-white p-3">
              <span className="text-sm font-medium">城市</span>
              <input
                value={city}
                onChange={(e) => setCity(e.target.value)}
                placeholder="留空=未提及"
                className="mt-2 w-full rounded-md border border-slate-300 px-2 py-2 text-sm outline-none focus:border-slate-900"
              />
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-3">
            <span className="text-sm font-medium">备注</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="规范未覆盖的说法、断缴情况、窗口不匹配等。例：半年5次，3月内未知"
              className="mt-2 h-20 w-full resize-y rounded-md border border-slate-300 p-2 text-sm outline-none focus:border-slate-900"
            />
            <div className="mt-2 space-y-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={hasCorrection}
                  onChange={(e) => setHasCorrection(e.target.checked)}
                  className="size-4"
                />
                <span>客户中途改口（模型容易只抓第一次陈述）</span>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={pendingReview}
                  onChange={(e) => setPendingReview(e.target.checked)}
                  className="size-4"
                />
                <span>待议：规范未覆盖，需回头补规范</span>
              </label>
            </div>
          </div>
        </section>
      </div>

      {/* 主操作固定在屏幕下方：单手拇指可达 */}
      <div className="fixed inset-x-0 bottom-0 border-t border-slate-200 bg-white/95 p-3 backdrop-blur">
        <div className="mx-auto max-w-6xl space-y-2">
          {msg && (
            <p
              className={`text-xs leading-relaxed ${
                msg.kind === "ok" ? "text-emerald-700" : "text-red-600"
              }`}
            >
              {msg.text}
            </p>
          )}
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-xs text-slate-500">
              {unsetCount > 0 ? `未填 ${unsetCount}` : "已填齐"}
            </span>
            {unsetCount > 0 && (
              <button
                type="button"
                onClick={markRestUnmentioned}
                className="rounded-lg border border-slate-300 px-3 py-3 text-xs"
              >
                其余全标未提及
              </button>
            )}
            <span className="flex-1" />
            <button
              type="button"
              onClick={reset}
              className="rounded-lg border border-slate-300 px-3 py-3 text-sm"
            >
              清空
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={saving}
              className="rounded-lg bg-slate-900 px-5 py-3 text-sm font-medium text-white disabled:opacity-50"
            >
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
