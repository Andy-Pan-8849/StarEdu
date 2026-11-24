"use client";

import { useTranslations } from "next-intl";
import * as React from "react";
import { bff } from "@/lib/bff";

export interface DictOption { value: string; label: string }

/**
 * 读一个字典（租户可配置）：返回下拉框要的选项，和把"值"翻成文字的函数。
 * 平台提供的条目用翻译键按界面语言取文字；租户自建的直接用存的文字；字典里没有的值原样显示。
 */
export function useDict(code: string) {
  const tm = useTranslations();
  const [raw, setRaw] = React.useState<Array<{ value: string; label: string; labelKey: string | null }>>([]);
  React.useEffect(() => {
    let live = true;
    void bff<{ items: typeof raw }>(`dicts/${code}`).then((d) => { if (live) setRaw(d.items); }).catch(() => undefined);
    return () => { live = false; };
  }, [code]);
  const options: DictOption[] = raw.map((i) => ({ value: i.value, label: i.labelKey && tm.has(i.labelKey) ? tm(i.labelKey) : i.label }));
  const label = (value: string | null | undefined): string => (value ? options.find((o) => o.value === value)?.label ?? value : "");
  return { options, label };
}
