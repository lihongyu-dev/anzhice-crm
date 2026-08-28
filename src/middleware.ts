import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/lib/auth/token";

/**
 * 认证守卫。跑在 edge runtime —— 只能用 Web Crypto，不能碰数据库、不能用 node:crypto。
 * 所以这里只做「令牌签名对不对、过期没过期」，密码校验在 /api/auth/login（node runtime）。
 *
 * 两条设计决定：
 *
 * ① fail closed：SESSION_SECRET 没配置时**拒绝所有请求**，不是放行。
 *    配置缺失最常见的场景是部署时漏了环境变量 —— 那一刻恰恰是最不能放行的时候。
 *
 * ② 未认证的 API 请求返回 404，不是 401。
 *    401 等于告诉扫描器"这个端点存在，只是你没登录"。
 *    404 让 /api/gold-labels 和一个不存在的路径看起来完全一样。
 *    （沿用门户站 2026-08-26 的修法）
 */

const PUBLIC_PATHS = new Set(["/login", "/api/auth/login"]);

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isApi = pathname.startsWith("/api/");

  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    // 配置缺失 → 全拒。宁可整站不可用，也不能裸奔
    return isApi
      ? new NextResponse(null, { status: 404 })
      : new NextResponse("服务未正确配置：SESSION_SECRET 缺失", { status: 503 });
  }

  const session = await verifySession(
    req.cookies.get(SESSION_COOKIE)?.value,
    secret
  );

  if (PUBLIC_PATHS.has(pathname)) {
    // 已登录还访问登录页 → 直接送进工作台
    if (session && pathname === "/login") {
      return NextResponse.redirect(new URL("/app/label", req.url));
    }
    return NextResponse.next();
  }

  if (!session) {
    if (isApi) return new NextResponse(null, { status: 404 });
    const to = new URL("/login", req.url);
    to.searchParams.set("next", pathname);
    return NextResponse.redirect(to);
  }

  return NextResponse.next();
}

export const config = {
  // 排除静态资源；其余全部走守卫（默认保护，新增路由不会漏）
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
