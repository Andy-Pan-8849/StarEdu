import { Bell, BookOpen, Bot, Building2, Folder, GraduationCap, Settings, Users, LayoutGrid, type LucideIcon } from "lucide-react";

// 菜单目录的 icon 字段（menu-catalog 里写的名字）对应的图标；没认识的名字用通用图标。
const ICONS: Record<string, LucideIcon> = {
  bell: Bell,
  book: BookOpen,
  bot: Bot,
  building: Building2,
  folder: Folder,
  graduation: GraduationCap,
  settings: Settings,
  users: Users,
};

export function MenuIcon({ name, className = "h-4 w-4" }: { name: string | null; className?: string }) {
  const Icon = (name && ICONS[name]) || LayoutGrid;
  return <Icon aria-hidden className={className} />;
}
