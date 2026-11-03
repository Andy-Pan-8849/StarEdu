"use client";

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
