import React, { useEffect, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { useNavigate } from "react-router-dom";

export function ScreenHeader({ title, subtitle, back = true, right = null }) {
  const nav = useNavigate();
  return (
    <header className="px-4 pt-4 pb-3 sticky top-0 z-30 glass-bottom" style={{ borderTop: "none", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
      <div className="flex items-center gap-2">
        {back && (
          <button
            data-testid="header-back-btn"
            onClick={() => nav(-1)}
            className="btn btn-ghost px-2 -ml-2 min-h-[40px]"
            aria-label="Back"
          >
            <ChevronLeft size={22} />
          </button>
        )}
        <div className="flex-1 min-w-0">
          <h1 className="font-heading text-xl font-bold tracking-tight text-ink-primary truncate">{title}</h1>
          {subtitle && <p className="text-xs text-ink-secondary mt-0.5 truncate">{subtitle}</p>}
        </div>
        {right}
      </div>
    </header>
  );
}

export function PageContainer({ children, className = "" }) {
  return (
    <div className={`page-shell px-4 pt-4 pb-28 ${className}`}>{children}</div>
  );
}

export function Section({ title, children, action }) {
  return (
    <section className="mb-5">
      {(title || action) && (
        <div className="flex items-end justify-between mb-2 px-1">
          {title && <h2 className="label">{title}</h2>}
          {action}
        </div>
      )}
      <div className="card overflow-hidden">{children}</div>
    </section>
  );
}

export function Field({ label, children, hint }) {
  return (
    <label className="block mb-3">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="text-xs text-ink-tertiary block mt-1">{hint}</span>}
    </label>
  );
}

export function Empty({ icon, title, children }) {
  return (
    <div className="card p-6 text-center">
      {icon && <div className="text-ink-tertiary mb-2 flex justify-center">{icon}</div>}
      <p className="font-heading text-base text-ink-primary mb-1">{title}</p>
      {children && <p className="text-sm text-ink-secondary">{children}</p>}
    </div>
  );
}

export function Spinner() {
  return (
    <div className="flex justify-center py-8">
      <div className="w-6 h-6 rounded-full border-2 border-ink-tertiary border-t-brand animate-spin" />
    </div>
  );
}

export function Toast({ message, kind = "info", onDone }) {
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(onDone, 2400);
    return () => clearTimeout(t);
  }, [message, onDone]);
  if (!message) return null;
  const colors = {
    info: "bg-bg-elevated text-ink-primary border-strong",
    success: "bg-[rgba(16,185,129,0.15)] text-[#34D399] border-[rgba(16,185,129,0.35)]",
    error: "bg-[rgba(244,63,94,0.15)] text-[#FB7185] border-[rgba(244,63,94,0.35)]",
  };
  return (
    <div className="fixed left-0 right-0 z-50 flex justify-center pointer-events-none" style={{ bottom: "calc(80px + env(safe-area-inset-bottom))" }}>
      <div data-testid="toast" className={`pointer-events-auto px-4 py-2.5 rounded-xl border text-sm font-medium ${colors[kind] || colors.info}`}>
        {message}
      </div>
    </div>
  );
}

export function useToast() {
  const [t, setT] = useState({ message: "", kind: "info" });
  return {
    toast: t,
    show: (message, kind = "info") => setT({ message, kind }),
    clear: () => setT({ message: "", kind: "info" }),
  };
}
