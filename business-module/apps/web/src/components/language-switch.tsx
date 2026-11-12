"use client";

import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { LOCALES, LOCALE_COOKIE } from "@/i18n/locales";
import { Button } from "@/components/ui/button";

export function LanguageSwitch() {
  const t = useTranslations("language");
  const current = useLocale();
  const router = useRouter();

  function choose(locale: string) {
    document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=31536000; samesite=lax`;
    router.refresh();
  }

  return (
    <div className="flex items-center gap-2 text-sm text-muted">
      <span>{t("label")}</span>
      {LOCALES.map((locale) => (
        <Button
          key={locale}
          size="sm"
          variant={locale === current ? "default" : "outline"}
          onClick={() => choose(locale)}
          aria-pressed={locale === current}
        >
          {t(locale)}
        </Button>
      ))}
    </div>
  );
}
