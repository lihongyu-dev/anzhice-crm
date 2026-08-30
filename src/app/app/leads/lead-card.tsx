"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  STATUS_META,
  PRODUCT_LABELS,
  SOURCE_LABELS,
  formatAmount,
  relativeTime,
  LEAD_STATUSES,
  type LeadStatus,
} from "@/lib/leads/status";
import MatchPanel from "./match-panel";
import ExtractPanel from "./extract-panel";

/**
 * 线索卡片。
 *
 * 单手操作是硬约束，所以：
 * ① 折叠态只放判断优先级需要的信息，展开才给操作按钮 —— 避免误触。
 * ② 「看号码」是显式动作。明文手机号不随列表下发（列表只有掩码），
 *    点了才走 POST /api/leads/[id]/phone 解密并留审计。
 * ③ 拿到号码后直接给 tel: 链接，一步拨出去。
 * ④ 状态改成「养客中」时前端就要求填日期 —— 后端也会拦（nurture_needs_date），
 *    但在这里拦住能省一次失败往返。
 * ⑤ 资质匹配（MatchPanel）按需加载，不随列表下发。
 *    列表可能有上百条，预取全部匹配结果等于把 5 款产品 × N 条线索的
 *    判定全算一遍 —— 而实际每次只看一两条。
 * ⑥ 抽取（ExtractPanel）默认折叠，且排在匹配之后。
 *    抽取要花钱、要等 5-15 秒、要在电脑上逐字段核对 —— 它不是车上的动作。
 *    车上的动作是「看能推哪些产品」+「拨号」；抽取是回到家整理聊天记录时做的。
 *    默认折叠避免误触产生真实费用。
 */

type LeadCardLead = {
  id: number;
  name: string;
  phoneMask: string;
  source: string;
  channelDetail: string | null;
  productIntent: string | null;
  amountIntent: number | null;
  city: string | null;
  rawNote: string | null;
  status: string;
  lostReason: string | null;
  nurtureUntil: string | null;
  nextActionAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** datetime-local 需要 YYYY-MM-DDTHH:mm，且要按北京时间显示 */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const shifted = new Date(d.getTime() + 8 * 3600 * 1000);
  return shifted.toISOString().slice(0, 16);
}

/** 本地输入转回带时区的 ISO。输入被当作北京时间 */
function fromLocalInput(v: string): string | null {
  if (!v) return null;
  return new Date(`${v}:00+08:00`).toISOString();
}

export default function LeadCard({ lead }: { lead: LeadCardLead }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [extractOpen, setExtractOpen] = useState(false);
  const [phone, setPhone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [status, setStatus] = useState<LeadStatus>(lead.status as LeadStatus);
  const [nurtureUntil, setNurtureUntil] = useState(toLocalInput(lead.nurtureUntil));
  const [nextActionAt, setNextActionAt] = useState(toLocalInput(lead.nextActionAt));
  const [note, setNote] = useState("");

  const meta = STATUS_META[lead.status as LeadStatus] ?? STATUS_META.new;
  const overdue =
    lead.nextActionAt !== null && new Date(lead.nextActionAt) <= new Date();

  async function revealPhone() {
    setErr(null);
    setBusy(true);
    try {
      const r = await fetch(`/api/leads/${lead.id}/phone`, { method: "POST" });
      const j = await r.json().catch(() => null);
      if (!r.ok) {
        setErr(j?.error?.message ?? "获取号码失败");
        return;
      }
      setPhone(j.phone);
    } catch {
      setErr("网络错误");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setErr(null);
    if (status === "nurture" && !nurtureUntil) {
      setErr("转为「养客中」必须填重捞时间，否则这条线索会被遗忘");
      return;
    }
    setBusy(true);
    try {
      const r = await fetch(`/api/leads/${lead.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status,
          nurtureUntil: fromLocalInput(nurtureUntil),
          nextActionAt: fromLocalInput(nextActionAt),
          noteAppend: note || undefined,
        }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok) {
        setErr(j?.error?.message ?? "保存失败");
        return;
      }
      setNote("");
      setOpen(false);
      router.refresh();
    } catch {
      setErr("网络错误");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full px-4 py-3 text-left"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-slate-900">{lead.name}</span>
              <span
                className={`rounded-full px-2 py-0.5 text-xs ring-1 ${meta.badge}`}
              >
                {meta.label}
              </span>
              {overdue && (
                <span className="rounded-full bg-rose-100 px-2 py-0.5 text-xs text-rose-700 ring-1 ring-rose-200">
                  该跟进
                </span>
              )}
            </div>
            <div className="mt-1 text-sm text-slate-600">
              {lead.phoneMask}
              {" · "}
              {PRODUCT_LABELS[lead.productIntent ?? "unknown"] ?? "待确认"}
              {lead.amountIntent !== null && ` · ${formatAmount(lead.amountIntent)}`}
            </div>
            <div className="mt-0.5 text-xs text-slate-400">
              {SOURCE_LABELS[lead.source] ?? lead.source}
              {" · "}
              {relativeTime(lead.createdAt)}
            </div>
          </div>
          <span className="shrink-0 pt-1 text-slate-400">{open ? "▲" : "▼"}</span>
        </div>
      </button>

      {open && (
        <div className="space-y-3 border-t border-slate-100 px-4 py-3">
          {/* 号码：显式解密，拿到后一键拨出 */}
          <div className="flex items-center gap-2">
            {phone ? (
              <a
                href={`tel:${phone}`}
                className="flex-1 rounded-lg bg-emerald-600 px-3 py-2 text-center text-sm font-medium text-white"
              >
                拨打 {phone}
              </a>
            ) : (
              <button
                onClick={revealPhone}
                disabled={busy}
                className="flex-1 rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {busy ? "获取中…" : "看号码"}
              </button>
            )}
          </div>

          {lead.rawNote && (
            <div className="rounded-lg bg-slate-50 p-2.5 text-sm whitespace-pre-wrap text-slate-700">
              {lead.rawNote}
            </div>
          )}

          {/*
            资质匹配。放在号码之后、状态之前 ——
            打电话前要知道问什么，打完才改状态，顺序对应实际动作次序。
          */}
          <MatchPanel leadId={lead.id} />

          {/*
            抽取入口。默认折叠 —— 见组件顶部注释 ⑥：
            这是「回家整理聊天记录」的动作，不是车上的动作，
            而且每次点击都产生真实 API 费用，不该轻易误触。
          */}
          <div className="rounded-lg border border-slate-200 bg-slate-50/60">
            <button
              onClick={() => setExtractOpen((v) => !v)}
              className="flex w-full items-center justify-between px-3 py-2 text-left"
            >
              <span className="text-sm font-medium text-slate-700">
                粘对话 → AI 抽资质
              </span>
              <span className="text-xs text-slate-400">
                {extractOpen ? "收起 ▲" : "展开 ▼"}
              </span>
            </button>
            {extractOpen && (
              <div className="border-t border-slate-200 px-3 py-2.5">
                <ExtractPanel leadId={lead.id} />
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs text-slate-500">状态</label>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {LEAD_STATUSES.map((s) => (
                <button
                  key={s}
                  onClick={() => setStatus(s)}
                  className={[
                    "rounded-lg px-2.5 py-1.5 text-sm ring-1",
                    status === s
                      ? "bg-slate-900 text-white ring-slate-900"
                      : "bg-white text-slate-700 ring-slate-200",
                  ].join(" ")}
                >
                  {STATUS_META[s].label}
                </button>
              ))}
            </div>
            <p className="mt-1 text-xs text-slate-400">{STATUS_META[status].hint}</p>
          </div>

          {status === "nurture" && (
            <div>
              <label className="block text-xs text-slate-500">
                重捞时间（必填）
              </label>
              <input
                type="datetime-local"
                value={nurtureUntil}
                onChange={(e) => setNurtureUntil(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm"
              />
            </div>
          )}

          <div>
            <label className="block text-xs text-slate-500">下次跟进时间</label>
            <input
              type="datetime-local"
              value={nextActionAt}
              onChange={(e) => setNextActionAt(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm"
            />
          </div>

          <div>
            <label className="block text-xs text-slate-500">追加备注</label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="聊了什么、下一步做什么"
              className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm"
            />
          </div>

          {err && (
            <p className="rounded-lg bg-rose-50 p-2 text-sm text-rose-700">{err}</p>
          )}

          <button
            onClick={save}
            disabled={busy}
            className="w-full rounded-lg bg-slate-900 px-3 py-2.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
      )}
    </div>
  );
}
