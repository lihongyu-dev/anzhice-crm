import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "客户资质结构化处理系统",
  description: "内部系统",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-slate-50 text-slate-900">
        {children}
      </body>
    </html>
  );
}
