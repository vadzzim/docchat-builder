"use client";

import { useEffect, useState } from "react";
import { WidgetChat } from "@/components/widget-chat";

function safeOrigin(value: string | null): string | null {
  if (!value) return null;
  try {
    const origin = new URL(value);
    if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password ||
      origin.pathname !== "/" || origin.search || origin.hash) return null;
    return origin.origin;
  } catch {
    return null;
  }
}

export default function WidgetPage() {
  const [configuration, setConfiguration] = useState<{ botId: string; parentOrigin: string } | null>(null);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    const search = new URLSearchParams(window.location.search);
    const botId = search.get("bot_id")?.trim() ?? "";
    const parentOrigin = safeOrigin(search.get("parent_origin"));
    if (!botId || !parentOrigin) {
      setInvalid(true);
      return;
    }
    setConfiguration({ botId, parentOrigin });
  }, []);

  if (invalid) {
    return <main className="flex min-h-screen items-center justify-center bg-white px-5 text-center text-sm text-slate-600">This widget is missing its embedding configuration.</main>;
  }
  if (!configuration) {
    return <main className="flex min-h-screen items-center justify-center bg-white px-5 text-sm text-slate-500" role="status">Connecting…</main>;
  }
  return <WidgetChat botId={configuration.botId} parentOrigin={configuration.parentOrigin} />;
}
