import { NextResponse } from "next/server";
import { z } from "zod";
import {
  extractForLead,
  getLatestQualification,
  saveQualificationReview,
} from "@/lib/extract/persist";
import { approxNumberSchema, incomeBasisSchema } from "@/lib/extract/types";

/**
 * 抽取与复核接口。
 *
 * POST  /api/leads/[id]/extract  — 粘一段对话原文 → 结构化资质草稿
 * PATCH /api/leads/[id]/extract  — 人工复核后落库（FR-1.6）
 * GET   /api/leads/[id]/extract  — 回显最新草稿，供复核界面加载
 *
 * 认证由 middleware 统一保证（本路径不在 PUBLIC_PATHS 内）。
 *
 * ## 为什么 POST 而不是 GET
 *
 * 这个接口**要花钱**（调百炼 API）。GET 会被浏览器预取、被 Link
 * prefetch、被中间层缓存重放 —— 每一次都是真实费用。
 * 非幂等 + 有成本，语义上必须是 POST。
 *
 * ## runtime = nodejs
 *
 * 走数据库（postgres-js）且 crypto.ts 用 node:crypto，不能跑 edge。
 */

export const runtime = "nodejs";
/** 抽取要等模型返回，默认 15s 不够 */
export const maxDuration = 60;

const postSchema = z.object({
  /**
   * 对话原文。下限 10 字与 goldLabelInputSchema 保持一致 ——
   * 两边都是"喂给抽取器的文本"，口径不该分叉。
   * 上限 20000：微信长对话导出可能很长，但超过这个量级
   * 单次抽取的注意力会被稀释，该分段处理而不是硬塞。
   */
  rawText: z.string().trim().min(10, "对话原文太短，至少 10 字").max(20000),
  channel: z.enum(["wechat", "phone", "website", "other"]).default("wechat"),
  direction: z.enum(["inbound", "outbound"]).default("inbound"),
  /** 覆盖默认模型，用于在真实线索上对比模型表现 */
  model: z.string().max(60).optional(),
});

/**
 * 复核入参。
 *
 * 数值字段沿用 approxNumberSchema —— 人工填的值也必须带 min/max/rawText。
 * 这不是形式主义：人如果只填一个精确数字而不记原话，
 * 三个月后没人知道这个 36 是客户说的还是复核时估的。
 */
const patchSchema = z.object({
  qualificationId: z.number().int().positive(),
  patch: z
    .object({
      monthlyIncome: approxNumberSchema.nullable(),
      incomeBasis: incomeBasisSchema,
      socialSecurityMonths: approxNumberSchema.nullable(),
      providentFundMonths: approxNumberSchema.nullable(),
      creditInquiries3m: approxNumberSchema.nullable(),
      debtMonthly: approxNumberSchema.nullable(),
      businessMonths: approxNumberSchema.nullable(),
      amountIntent: approxNumberSchema.nullable(),
      creditOverdue: z.boolean().nullable(),
      hasMortgage: z.boolean().nullable(),
      hasCarLoan: z.boolean().nullable(),
      hasProvidentFund: z.boolean().nullable(),
      age: z.number().int().min(16).max(100).nullable(),
      city: z.string().max(50).nullable(),
      companyType: z
        .enum(["state", "private", "foreign", "self_employed", "none"])
        .nullable(),
    })
    .partial(),
  verifiedFields: z.array(z.string().max(40)).max(30).default([]),
});

function parseId(id: string): number | null {
  const n = Number(id);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

const NO_STORE = {
  /** 响应含收入、负债等敏感个人信息，不该留在任何缓存里 */
  "Cache-Control": "no-store, max-age=0",
  "X-Robots-Tag": "noindex, nofollow",
};

function badId() {
  return NextResponse.json(
    { error: { code: "bad_id", message: "id 不合法" } },
    { status: 400 }
  );
}

function invalid(e: z.ZodError) {
  return NextResponse.json(
    {
      error: {
        code: "invalid",
        message: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      },
    },
    { status: 400 }
  );
}

async function readJson(req: Request) {
  try {
    return { ok: true as const, body: await req.json() };
  } catch {
    return { ok: false as const };
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const leadId = parseId(id);
  if (leadId === null) return badId();

  const body = await readJson(req);
  if (!body.ok) {
    return NextResponse.json(
      { error: { code: "bad_json", message: "请求体不是合法 JSON" } },
      { status: 400 }
    );
  }

  const parsed = postSchema.safeParse(body.body);
  if (!parsed.success) return invalid(parsed.error);

  const result = await extractForLead({ leadId, ...parsed.data });

  if (!result.ok) {
    /**
     * 状态码分两类，因为处置动作不同：
     *   404 线索不存在 —— 客户端搞错了 id，重试无用
     *   502 模型侧失败 —— 可重试，UI 该给"再试一次"按钮
     * 都带上 extractionRunId，出问题能直接查那一行的 rawResponse。
     */
    const status = result.code === "lead_not_found" ? 404 : 502;
    return NextResponse.json(
      {
        error: {
          code: result.code,
          message: result.message,
          extractStatus: result.status,
          extractionRunId: result.extractionRunId,
        },
      },
      { status, headers: NO_STORE }
    );
  }

  /** result 自带 ok:true，展开即可 —— 重复写 ok 会被覆盖，TS 也会报 TS2783 */
  return NextResponse.json(result, { headers: NO_STORE });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const leadId = parseId(id);
  if (leadId === null) return badId();

  const body = await readJson(req);
  if (!body.ok) {
    return NextResponse.json(
      { error: { code: "bad_json", message: "请求体不是合法 JSON" } },
      { status: 400 }
    );
  }

  const parsed = patchSchema.safeParse(body.body);
  if (!parsed.success) return invalid(parsed.error);

  /**
   * 校验 qualificationId 归属于路径里的 leadId。
   *
   * 不查这一步的话，带着别人的 qualificationId 打这个接口就能改到
   * 另一条线索的资质 —— 只有一个用户也要堵，因为将来加第二个用户时
   * 没人会想起来这里漏了一道。
   */
  const latest = await getLatestQualification(leadId);
  if (!latest || latest.id !== parsed.data.qualificationId) {
    const owned = await getLatestQualification(leadId);
    if (!owned) {
      return NextResponse.json(
        { error: { code: "not_found", message: "该线索还没有资质记录" } },
        { status: 404, headers: NO_STORE }
      );
    }
    if (owned.id !== parsed.data.qualificationId) {
      return NextResponse.json(
        {
          error: {
            code: "stale_qualification",
            message: "这份资质已不是最新版本，请刷新后重新复核",
          },
        },
        { status: 409, headers: NO_STORE }
      );
    }
  }

  const result = await saveQualificationReview(parsed.data);
  if (!result.ok) {
    return NextResponse.json(
      { error: { code: result.code, message: result.message } },
      { status: 404, headers: NO_STORE }
    );
  }

  return NextResponse.json(result, { headers: NO_STORE });
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const leadId = parseId(id);
  if (leadId === null) return badId();

  const row = await getLatestQualification(leadId);
  if (!row) {
    return NextResponse.json(
      { ok: true, qualification: null },
      { headers: NO_STORE }
    );
  }

  return NextResponse.json(
    {
      ok: true,
      qualification: {
        ...row,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      },
    },
    { headers: NO_STORE }
  );
}
