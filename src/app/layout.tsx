import type { Metadata } from "next";
import "./globals.css";


export const metadata: Metadata = {
  title: "AI Research Atlas",
  description: "AI 论文知识图谱 - 桌面优先的论文浏览应用",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body className="atlas-ui font-sans">{children}</body>
    </html>
  );
}
