import { verify } from "@node-rs/argon2";
import { z } from "zod";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SEC,
  signSession,
} from "@/lib/auth/token";
import {
  clearFailures,
  clientIp,
  isLocked,
  recordAttempt,
} from "@/lib/auth/ratelimit";

/**
 * 登录。跑在 node runtime —— argon2 是原生模块，edge 跑不了。
 * middleware 只负责校验已签发的令牌，密码校验只在这里发生。
 *
 * 时序：先查限流 → 再验密码。反过来的话攻击者仍能通过响应时间差
 * 判断密码对不对（对的那次会慢，因为要走完 argon2）。
 */

export const runtime = "nodejs";

const bodySchema = z.object({ password: z.string().min(1).max(200) });

/** 无论成败都返回同样的措辞，不区分「密码错」和「账号不存在」 */
const GENERIC_FAIL = { error: { code: "invalid_credentials", message: "密码不正确" } };

export async function POST(req: Request) {
  const ip = clientIp(req);

  const hash = process.env.ADMIN_PASSWORD_HASH;
  const secret = process.env.SESSION_SECRET;

  /**
   * 哈希格式必须显式校验，不能只判空。
   *
   * 2026-08-27 踩的坑：argon2 哈希形如 $argon2id$v=19$m=...，
   * 而 Next.js 用 dotenv-expand 解析 .env.local，会把 $argon2id / $v / $m
   * 当成变量引用替换成空串 —— 62 字符的哈希被啃成 17 个。
   * .env.local 里必须逐个写成 \$ 转义。
   *
   * 当时这个错误被下面的 try/catch 归为「密码不正确」返回 401，
   * 把配置错误伪装成了密码错误。所以这里提前拦一道并给出可诊断的信息：
   * 配置坏了要响亮，只有真的密码错才安静。
   */
  if (!hash || !secret || !hash.startsWith("$argon2")) {
    return Response.json(
      {
        error: {
          code: "not_configured",
          message: "服务未正确配置：登录凭据缺失或格式非法",
        },
      },
      { status: 503 }
    );
  }

  if (await isLocked(ip)) {
    return Response.json(
      {
        error: {
          code: "too_many_attempts",
          message: "失败次数过多，请 15 分钟后再试",
        },
      },
      { status: 429 }
    );
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json(
      { error: { code: "bad_json", message: "请求体不是合法 JSON" } },
      { status: 400 }
    );
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    await recordAttempt(ip, false);
    return Response.json(GENERIC_FAIL, { status: 401 });
  }

  let ok = false;
  try {
    ok = await verify(hash, parsed.data.password);
  } catch {
    ok = false; // 哈希串格式坏了也算失败，不抛 500 暴露内部状态
  }

  if (!ok) {
    await recordAttempt(ip, false);
    return Response.json(GENERIC_FAIL, { status: 401 });
  }

  await recordAttempt(ip, true);
  await clearFailures(ip);

  const token = await signSession("admin", secret);
  const res = Response.json({ ok: true });
  res.headers.append(
    "Set-Cookie",
    [
      `${SESSION_COOKIE}=${token}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      "Secure",
      `Max-Age=${SESSION_MAX_AGE_SEC}`,
    ].join("; ")
  );
  return res;
}
