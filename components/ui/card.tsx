import type { HTMLAttributes } from "react";

export function Card({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`rounded-3xl bg-white shadow-sm ring-1 ring-slate-200/80 ${className}`} {...props} />;
}
