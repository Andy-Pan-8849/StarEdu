import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale } from "next-intl/server";
import "./globals.css";

export const metadata: Metadata = { title: "StarIT" };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  // 公开试用站的提示条：只在设置了 TRIAL_BANNER 时显示（运行时读取，不用重新构建）
  const banner = process.env.TRIAL_BANNER?.trim();
  return (
    <html lang={locale}>
      <body>
        {banner ? (
          <div role="status" className="bg-amber-100 px-4 py-1.5 text-center text-xs text-amber-900">
            {banner}
          </div>
        ) : null}
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
