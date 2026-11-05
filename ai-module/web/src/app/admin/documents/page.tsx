"use client";

/**
 * 文件：app/admin/documents/page.tsx
 * 作用：文档管理页（路径 /admin/documents），仅 RAGETLAdmin 角色有入口。
 * 注意：页面入口是否显示只是方便，真正的保护在 API（每个管理接口都校验角色）。
 */

import { AppShell } from "@/components/app-shell";
import { AuthProvider } from "@/components/auth-provider";
import { DocumentsAdmin } from "@/components/documents-admin";

export default function DocumentsPage() {
  return (
    <AuthProvider>
      <AppShell>
        <DocumentsAdmin />
      </AppShell>
    </AuthProvider>
  );
}
