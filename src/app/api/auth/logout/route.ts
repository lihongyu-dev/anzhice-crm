import { SESSION_COOKIE } from "@/lib/auth/token";

/** 退出：把 cookie 置空并立即过期 */
export async function POST() {
  const res = Response.json({ ok: true });
  res.headers.append(
    "Set-Cookie",
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`
  );
  return res;
}
