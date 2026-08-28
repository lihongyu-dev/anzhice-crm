import { Suspense } from "react";
import LoginForm from "./login-form";

export const metadata = {
  title: "登录 · 安知策",
  robots: { index: false, follow: false },
};

/**
 * LoginForm 用了 useSearchParams()（读 ?next=），
 * 在静态预渲染时拿不到查询串，必须包 Suspense —— 否则 build 阶段
 * prerender /login 直接报错。fallback 给一个等高的空壳避免跳动。
 */
export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen" />}>
      <LoginForm />
    </Suspense>
  );
}
