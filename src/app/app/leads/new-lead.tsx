"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PRODUCT_LABELS, SOURCE_LABELS } from "@/lib/leads/status";

/**
 * 手工建线索 —— 微信直聊客户的入口。
 *
 * ## 为什么这个入口必须存在
 *
 * 之前线索只能从门户站表单进来。但实际获客靠私域：朋友圈、微信直接问 ——
 * **这些人根本不会去官网填表。** 系统只接得住最少的那条流量。
 *
 * ## 两条界面决定
 *
 * ① **姓名 + 手机号是唯一必填，其余全可留空。**
 *    微信刚聊两句只知道「王哥、138 开头」是常态。
 *    必填项越多，人越倾向于"等信息全了再录"，而等下去的结果是根本不录。
 *    资质字段一个都不在这里 —— 那是抽取和复核的活。
 *
 * ② **建完直接落到该线索的抽取入口。**
 *    实际动作是连续的：加了微信 → 聊几句 → 建线索 → 立刻把聊天记录粘进去。\
 *    建完就停在列表顶端，人还得再找一次这条线索、再展开、再点抽取。
 */

const SOURCES = ["wechat", "referral", "xhs", "douyin", "manual"] as const;
const PRODUCTS = ["unknown", "credit", "mortgage", "car", "business"] as const;

export default function NewLead() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [dupe, setDupe] = useState<number | null>(null);

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [source, setSource] = useState<string>("wechat");
  const [channelDetail, setChannelDetail] = useState("");
  const [productIntent, setProductIntent] = useState<string>("unknown");
  const [amountText, setAmountText] = useState("");
  const [note, setNote] = useState("");

  function reset() {
    setName("");
    setPhone("");
    setSource("wechat");
    setChannelDetail("");
    setProductIntent("unknown");
    setAmountText("");
    setNote("");
    setErr(null);
    setDupe(null);
  }

  async function submit() {
    setErr(null);
    setDupe(null);
    setBusy(true);
    try {
      const r = await fetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          phone,
          source,
          channelDetail,
          productIntent,
          amountText,
          note,
        }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok) {
        setErr(j?.error?.message ?? "建线索失败");
        return;
      }
      if (j.duplicate) {
        /**
         * 手机号已存在 → 不报错，告诉人"这人已经在库里"。
         * 客户隔一周又来问是常事，重复录入不是错误操作。
         */
        setDupe(j.leadId);
        return;
      }
      reset();
      setOpen(false);
      router.refresh();
    } catch {
      setErr("网络错误");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mb-4 w-full rounded-xl bg-slate-900 px-3 py-3 text-sm font-medium text-white"
      >
        ＋ 新建线索（微信直聊客户）
      </button>
    );
  }

  return (
    <div className="mb-4 rounded-xl border border-slate-300 bg-white p-3 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-semibold text-slate-900">新建线索</span>
        <button
          onClick={() => {
            reset();
            setOpen(false);
          }}
          className="text-xs text-slate-500"
        >
          取消
        </button>
      </div>

      <div className="space-y-2.5">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-xs text-slate-500">
              称呼 <span className="text-rose-600">*</span>
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="王哥"
              className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-500">
              手机号 <span className="text-rose-600">*</span>
            </label>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              inputMode="tel"
              placeholder="138 1234 8000"
              className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs text-slate-500">来源</label>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {SOURCES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSource(s)}
                className={[
                  "rounded-lg px-2.5 py-1.5 text-sm ring-1",
                  source === s
                    ? "bg-slate-900 text-white ring-slate-900"
                    : "bg-white text-slate-700 ring-slate-200",
                ].join(" ")}
              >
                {SOURCE_LABELS[s]}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-xs text-slate-500">
            具体来源（可留空）
          </label>
          <input
            value={channelDetail}
            onChange={(e) => setChannelDetail(e.target.value)}
            placeholder="某条朋友圈 / 谁转介绍的"
            className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm"
          />
        </div>

        <div>
          <label className="block text-xs text-slate-500">意向产品</label>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {PRODUCTS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setProductIntent(p)}
                className={[
                  "rounded-lg px-2.5 py-1.5 text-sm ring-1",
                  productIntent === p
                    ? "bg-slate-900 text-white ring-slate-900"
                    : "bg-white text-slate-700 ring-slate-200",
                ].join(" ")}
              >
                {PRODUCT_LABELS[p]}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-xs text-slate-500">
            意向金额（可留空，原话即可）
          </label>
          <input
            value={amountText}
            onChange={(e) => setAmountText(e.target.value)}
            placeholder="三十万 / 20-30万 / 越多越好"
            className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm"
          />
          <p className="mt-1 text-xs text-slate-400">
            解析不出来也没关系，原话会完整存进备注
          </p>
        </div>

        <div>
          <label className="block text-xs text-slate-500">备注（可留空）</label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="怎么认识的、初步聊了什么"
            className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm"
          />
        </div>

        {err && (
          <p className="rounded-lg bg-rose-50 p-2 text-sm text-rose-700">{err}</p>
        )}

        {dupe !== null && (
          <p className="rounded-lg bg-amber-50 p-2 text-sm text-amber-800">
            这个手机号已经在库里了（线索 #{dupe}）。没有新建重复线索 ——
            直接在列表里找这条跟进即可。
          </p>
        )}

        <button
          onClick={submit}
          disabled={busy || !name.trim() || !phone.trim()}
          className="w-full rounded-lg bg-slate-900 px-3 py-2.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? "保存中…" : "建线索"}
        </button>

        <p className="text-xs text-slate-400">
          只有称呼和手机号必填。资质不在这里填 ——
          建完展开这条线索，粘微信对话让 AI 抽，再逐字段核对。
        </p>
      </div>
    </div>
  );
}
