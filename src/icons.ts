import {
  ArrowRight,
  BookOpen,
  CalendarDays,
  ChartNoAxesColumnIncreasing,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  DatabaseBackup,
  Download,
  NotebookTabs,
  Pencil,
  Plus,
  Save,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Target,
  Trash2,
  UserRound,
  Utensils,
  WandSparkles,
  Weight,
  X,
  createIcons,
} from "lucide";

const ICONS = {
  ArrowRight,
  BookOpen,
  CalendarDays,
  ChartNoAxesColumnIncreasing,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  DatabaseBackup,
  Download,
  NotebookTabs,
  Pencil,
  Plus,
  Save,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Target,
  Trash2,
  UserRound,
  Utensils,
  WandSparkles,
  Weight,
  X,
};

export type IconName = keyof typeof ICONS;

export const icon = (name: IconName, className = ""): string =>
  `<i data-lucide="${name}" class="icon ${className}" aria-hidden="true"></i>`;

export const renderIcons = (root: HTMLElement): void => {
  createIcons({
    icons: ICONS,
    root,
    attrs: { "aria-hidden": "true", "stroke-width": "1.8" },
  });
};
