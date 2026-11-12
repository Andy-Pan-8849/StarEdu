"use client";

import * as React from "react";
import { bff } from "@/lib/bff";

/** 读取一个列表接口；reload 重新加载。 */
export function useList<T>(path: string) {
  const [rows, setRows] = React.useState<T[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    let live = true;
    setLoading(true);
    bff<T[]>(path)
      .then((data) => live && (setRows(data), setError(null)))
      .catch((e: Error) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [path, tick]);
  return { rows, loading, error, reload: () => setTick((t) => t + 1) };
}
