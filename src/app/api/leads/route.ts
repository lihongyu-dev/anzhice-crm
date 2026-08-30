import { NextResponse } from "next/server";
import { createLead, createLeadSchema } from "@/lib/leads/create";

/**
 * POST /api/leads — 手工建线索（微信直聊客户入口）。
 *
 * 认证由 middleware 统一保证（本路径不在 PUBLIC_PATHS 内）。
 *
 * ## 与 /api/ingest/leads 的区别
 *
 * ingest 是**服务间**接口：门户站用 INGEST_TOKEN 鉴权，没有浏览器会话。
 * 这个是**人用**的接口：走登录会话，禹哥在后台手工录入。
 *
 * 两者刻意不合并 —— 鉴权方式不同、来源默认值不同（website vs wechat）、
 * 生命周期不同。合并会让"门户站改字段"和"后台改表单"互相牵连。
 */

export const runtime = "nodejs"; // 需要 node:crypto 做手机号加密

const NO_STORE = {
  "Cache-Control": "no-store, max-age=0",
  "X-Robots-Tag": "noindex, nofollow",
};

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { code: "bad_json", message: "请求体不是合法 JSON" } },
      { status: 400 }
    );
  }

  const parsed = createLeadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: "invalid",
          message: parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; "),
        },
      },
      { status: 400 }
    );
  }

  try {
    const result = await createLead(parsed.data);
    return NextResponse.json(
      { ok: true, ...result },
      { status: result.duplicate ? 200 : 201, headers: NO_STORE }
    );
  } catch (e) {
    console.error("[leads:create] 入库失败:", String(e).slice(0, 300));
    return NextResponse.json(
      { error: { code: "db_error", message: "入库失败" } },
      { status: 500, headers: NO_STORE }
    );
  }
}
