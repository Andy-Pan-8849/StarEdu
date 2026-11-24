"use client";

import * as React from "react";

/** 租户的界面设置（来自"参数"，随 /api/me 下发）：列表每页多少条。 */
export interface UiSettings { pageSize: number; defaultLocale?: string; maxExtensionDays?: number }
export const SettingsContext = React.createContext<UiSettings>({ pageSize: 20 });
export const useSettings = (): UiSettings => React.useContext(SettingsContext);
