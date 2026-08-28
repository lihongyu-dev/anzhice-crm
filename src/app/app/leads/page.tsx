import Link from "next/link";
import { listLeads, getLeadStats } from "@/lib/leads/queries";
import { LEAD_STATUSES, STATUS_META } from "@/lib/leads/status";
import LeadCard from "./lead-card";

/**
 * 线索工作台（服务端组件）。
 *
 * 硬约束（2026-08-26）：**他一个人、经常在车上。**
 * 所以这一页的设计前提是"单手、竖屏、几秒钟内判断下一步"：
 *
 * ① 默认视图是「待办」不是「全部」。打开第一眼该看到"现在要打给谁"。
 * ② 卡片流不是表格。表格在手机上必然横向滚动，单手滚不了。
 * ③ 拨号按钮直接 tel: 唤起，不要求先进详情页。
 * ④ 待办排序是「老的在前」—— 放着不管越久越该先打。
 */

export const dynamic = "force-dynamic";

const VIEWS = [
  { key: "todo", label: "待办" },
  { key: "all", label: "全部" },
  ...LEAD_STATUSES.map((s) => ({ key: s, label: STATUS_META[s].label })),
];

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const { view = "todo" } = await searchParams;
  const [rows, stats] = await Promise.all([
    listLeads({ view }),
    getLeadStats(),
  ]);

  return (
    <div className="mx-auto w-full max-w-2xl px-4 pb-24 pt-4">
      <header className="mb-4">
        <div className="flex items-baseline justify-between">
          <h1 className="text-xl font-semibold">线索工作台</h1>
          <Link
            href="/app/label"
            className="text-sm text-slate-500 underline underline-offset-2"
          >
            标注工具
          </Link>
        </div>
        <p className="mt-1 text-sm text-slate-600">
          待办 <span className="font-semibold text-slate-900">{stats.todo}</span>
          {" · "}总计 {stats.total}
        </p>
      </header>

      {/* 视图切换：横向滚动条，拇指可划 */}
      <nav className="-mx-4 mb-4 overflow-x-auto px-4">
        <div className="flex gap-2 pb-1">
          {VIEWS.map((v) => {
            const n =
              v.key === "todo"
                ? stats.todo
                : v.key === "all"
                  ? stats.total
                  : (stats.byStatus[v.key] ?? 0);
            const active = v.key === view;
            return (
              <Link
                key={v.key}
                href={`/app/leads?view=${v.key}`}
                className={[
                  "shrink-0 rounded-full px-3 py-1.5 text-sm ring-1",
                  active
                    ? "bg-slate-900 text-white ring-slate-900"
                    : "bg-white text-slate-700 ring-slate-200",
                ].join(" ")}
              >
                {v.label}
                {n > 0 && (
                  <span className={active ? "ml-1 text-slate-300" : "ml-1 text-slate-400"}>
                    {n}
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      </nav>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center">
          <p className="text-slate-600">
            {view === "todo" ? "待办清空了。" : "这个分类下暂无线索。"}
          </p>
          {view === "todo" && (
            <p className="mt-2 text-sm text-slate-400">
              新线索会从官网表单自动进来
            </p>
          )}
        </div>
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => (
            <li key={r.id}>
              <LeadCard lead={{ ...r,
                nurtureUntil: r.nurtureUntil?.toISOString() ?? null,
                nextActionAt: r.nextActionAt?.toISOString() ?? null,
                createdAt: r.createdAt.toISOString(),
                updatedAt: r.updatedAt.toISOString(),
              }} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
