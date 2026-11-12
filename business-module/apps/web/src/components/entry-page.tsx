import { getTranslations } from "next-intl/server";
import { LanguageSwitch } from "@/components/language-switch";

export async function EntryPage({ entry }: { entry: "portal" | "admin" | "platform" }) {
  const t = await getTranslations();
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-4 py-16">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-primary">{t("app.name")}</span>
        <LanguageSwitch />
      </div>
      <h1 className="text-3xl font-semibold" data-testid="entry-title">
        {t(`${entry}.title`)}
      </h1>
      <p className="text-muted">{t(`${entry}.description`)}</p>
      <p className="rounded-md border border-border px-3 py-2 text-sm text-muted">{t("placeholder.status")}</p>
    </main>
  );
}
