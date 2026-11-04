"use client";

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
