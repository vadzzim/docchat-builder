import type { ButtonHTMLAttributes } from "react";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost";
};

export function Button({ className = "", variant = "primary", ...props }: ButtonProps) {
  const styles = {
    primary: "bg-ink text-white hover:bg-slate-700",
    secondary: "bg-white text-ink ring-1 ring-slate-200 hover:bg-slate-50",
    ghost: "text-slate-600 hover:bg-slate-100",
  }[variant];

  return <button className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${styles} ${className}`} {...props} />;
}
