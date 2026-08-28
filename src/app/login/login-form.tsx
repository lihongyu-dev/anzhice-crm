"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

/**
 * 登录页。单用户系统，没有用户名 —— 只有一个密码框。
 *
 * 不显示"密码错误还剩几次"之类的提示：那等于帮攻击者标定限流边界。
 * 被锁时才明确告知，因为那时候本人也需要知道为什么进不去。
 */
export default function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/app/label";

  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (r.ok) {
        // 用 replace 而非 push：登录页不该留在返回栈里
        router.replace(next);
        return;
      }
      const j = await r.json().catch(() => null);
      setErr(j?.error?.message ?? "登录失败");
    } catch {
      setErr("网络错误");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm">
        <h1 className="text-lg font-semibold">安知策</h1>
        <p className="mt-1 text-xs text-slate-500">客户资质结构化处理系统</p>

        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="密码"
          autoComplete="current-password"
          autoFocus
          className="mt-5 w-full rounded-lg border border-slate-300 px-3 py-3 text-base outline-none focus:border-slate-900"
        />

        {err && <p className="mt-2 text-sm text-red-600">{err}</p>}

        <button
          type="submit"
          disabled={busy || password === ""}
          className="mt-3 w-full rounded-lg bg-slate-900 px-4 py-3 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? "登录中…" : "登录"}
        </button>
      </form>
    </div>
  );
}
