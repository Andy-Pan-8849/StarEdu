"use client";

/**
 * 文件：app/page.tsx
 * 作用：首页（路径 /）：聊天界面。用 AuthProvider 包住以确保已登录，AppShell 提供顶部菜单，Chat
 *   是聊天本体。
 */

import { AppShell } from "@/components/app-shell";
import { AuthProvider } from "@/components/auth-provider";
import { Chat } from "@/components/chat";

export default function Home() {
  return (
    <AuthProvider>
      <AppShell>
        <Chat />
      </AppShell>
    </AuthProvider>
  );
}
