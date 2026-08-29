import { NextResponse } from "next/server";
import { getLeadMatch } from "@/lib/match/queries";

/**
 * GET /api/leads/[id]/match — 该线索的资质匹配结果。
 *
 * ## 为什么这里用 GET，而 /phone 用 POST
 *
 * `/phone` 用 POST 是因为明文手机号不能进浏览器预取、中间层缓存、访问日志。
 * 这个接口的响应里**没有手机号** —— 只有资质判定与缺失字段清单。
 * 它是一次纯读取、无副作用、幂等，语义上就是 GET。
 *
 * 仍然带 `no-store`：响应含收入、负债等敏感个人信息，不该留在任何缓存里。
 *
 * ## 为什么不写审计日志
 *
 * `reveal_phone` 记审计，是因为拿到明文号码是「即将联系此人」的离散动作，
 * 一次一条、可数、有业务含义。匹配结果会在每次展开卡片时看，
 * 一天可能几十次 —— 全记下来只会把审计日志冲成噪音，
 * 反而让真正需要追溯的 reveal_phone 记录淹掉。
 *
 * **审计日志的价值来自信噪比，不是覆盖率。**
 */

export const runtime = "nodejs"; // 走数据库

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const numId = Number(id);
  if (!Number.isInteger(numId) || numId < 1) {
    return NextResponse.json(
      { error: { code: "bad_id", message: "id 不合法" } },
      { status: 400 }
    );
  }

  const result = await getLeadMatch(numId);
  if (!result) {
    return NextResponse.json(
      { error: { code: "not_found", message: "线索不存在" } },
      { status: 404 }
    );
  }

  return NextResponse.json(
    { ok: true, ...result },
    {
      headers: {
        "Cache-Control": "no-store, max-age=0",
        "X-Robots-Tag": "noindex, nofollow",
      },
    }
  );
}
