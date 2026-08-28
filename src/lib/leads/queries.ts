import { and, asc, count, desc, eq, isNotNull, lte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { leads } from "@/db/schema";
import { LEAD_STATUSES, type LeadStatus } from "./status";

/**
 * 线索列表查询。
 *
 * ⚠️ **绝不 select phone_enc。** 列表只返回 phone_mask。
 * 明文手机号必须是一次显式的、单条的、留审计的动作（见 /api/leads/[id]/phone），
 * 而不是列表顺带返回一屏。
 * 理由：列表接口是最容易被批量拉取的地方 —— 一次请求泄露 500 个号码，
 * 和一次泄露 1 个，风险差两个量级。
 */

export type LeadRow = {
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
  nurtureUntil: Date | null;
  nextActionAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const LIST_COLUMNS = {
  id: leads.id,
  name: leads.name,
  phoneMask: leads.phoneMask,
  source: leads.source,
  channelDetail: leads.channelDetail,
  productIntent: leads.productIntent,
  amountIntent: leads.amountIntent,
  city: leads.city,
  rawNote: leads.rawNote,
  status: leads.status,
  lostReason: leads.lostReason,
  nurtureUntil: leads.nurtureUntil,
  nextActionAt: leads.nextActionAt,
  createdAt: leads.createdAt,
  updatedAt: leads.updatedAt,
};

export type LeadFilter = {
  /** 'all' | 'todo'（待办：待联系+到期重捞）| 具体状态 */
  view?: string;
  limit?: number;
};

export async function listLeads(filter: LeadFilter = {}): Promise<LeadRow[]> {
  const limit = Math.min(filter.limit ?? 100, 500);
  const view = filter.view ?? "todo";

  /**
   * 默认视图是 todo，不是 all。
   * 硬约束：他一个人、经常在车上（2026-08-26）。
   * 打开页面第一眼该看到"现在要打给谁"，不是一屏历史数据。
   */
  if (view === "todo") {
    return db
      .select(LIST_COLUMNS)
      .from(leads)
      .where(
        or(
          eq(leads.status, "new"),
          // 到期该重捞的养客线索
          and(
            eq(leads.status, "nurture"),
            isNotNull(leads.nurtureUntil),
            lte(leads.nurtureUntil, sql`now()`)
          ),
          // 到了预定跟进时间的
          and(isNotNull(leads.nextActionAt), lte(leads.nextActionAt, sql`now()`))
        )
      )
      // 老线索优先：放着不管的越久越该先打
      .orderBy(asc(leads.createdAt))
      .limit(limit);
  }

  if (view === "all") {
    return db
      .select(LIST_COLUMNS)
      .from(leads)
      .orderBy(desc(leads.updatedAt))
      .limit(limit);
  }

  if ((LEAD_STATUSES as readonly string[]).includes(view)) {
    return db
      .select(LIST_COLUMNS)
      .from(leads)
      .where(eq(leads.status, view as LeadStatus))
      .orderBy(desc(leads.updatedAt))
      .limit(limit);
  }

  // 未知 view 一律退回 todo，不报错 —— URL 被手改过不该白屏
  return listLeads({ ...filter, view: "todo" });
}

export type LeadStats = {
  total: number;
  todo: number;
  byStatus: Record<string, number>;
};

export async function getLeadStats(): Promise<LeadStats> {
  const [totalRow] = await db.select({ n: count() }).from(leads);

  const statusRows = await db
    .select({ status: leads.status, n: count() })
    .from(leads)
    .groupBy(leads.status);

  const [todoRow] = await db
    .select({ n: count() })
    .from(leads)
    .where(
      or(
        eq(leads.status, "new"),
        and(
          eq(leads.status, "nurture"),
          isNotNull(leads.nurtureUntil),
          lte(leads.nurtureUntil, sql`now()`)
        ),
        and(isNotNull(leads.nextActionAt), lte(leads.nextActionAt, sql`now()`))
      )
    );

  const byStatus: Record<string, number> = {};
  for (const r of statusRows) byStatus[r.status] = Number(r.n);

  return {
    total: Number(totalRow?.n ?? 0),
    todo: Number(todoRow?.n ?? 0),
    byStatus,
  };
}

export async function getLeadById(id: number): Promise<LeadRow | null> {
  const [row] = await db
    .select(LIST_COLUMNS)
    .from(leads)
    .where(eq(leads.id, id))
    .limit(1);
  return row ?? null;
}
