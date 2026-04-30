import React from "react";
import { Link, useNavigate } from "react-router-dom";
import { ScreenHeader, PageContainer, Section } from "../ui/Shell";
import { useAuth } from "../../contexts/AuthContext";
import {
  ListTodo, BarChart3, Boxes, User, Briefcase, Settings as Cog,
  HelpCircle, MessageSquare, ChevronRight, LogOut, LogIn, Sparkles,
} from "lucide-react";

const ITEMS = [
  { to: "/work-log", label: "Work Log", desc: "All tracked time blocks", icon: ListTodo, testid: "more-work-log" },
  { to: "/reports", label: "Reports", desc: "Charts and PDF export", icon: BarChart3, testid: "more-reports" },
  { to: "/stock", label: "Stock & Supplies", desc: "Products and supplies", icon: Boxes, testid: "more-stock" },
  { to: "/account", label: "Account Settings", desc: "Plan, sign-in, sync", icon: User, testid: "more-account" },
  { to: "/business", label: "Business Settings", desc: "Profile, address, tax", icon: Briefcase, testid: "more-business" },
  { to: "/program", label: "Program Settings", desc: "Theme, currency, prompts", icon: Cog, testid: "more-program" },
  { to: "/about", label: "About & Help", desc: "Version, principles, plans", icon: HelpCircle, testid: "more-about" },
  { to: "/feedback", label: "Feedback", desc: "Send us a note", icon: MessageSquare, testid: "more-feedback" },
];

export default function More() {
  const { user, guest, logout, exitGuest } = useAuth();
  const nav = useNavigate();

  return (
    <>
      <ScreenHeader title="More" subtitle="All modules and settings" back={false} />
      <PageContainer>
        <Section>
          <div className="p-4 flex items-center gap-3">
            <div className="w-12 h-12 rounded-2xl bg-brand/15 flex items-center justify-center text-brand font-heading font-bold text-xl">
              {(user?.name || user?.email || "G")[0].toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-heading text-base text-ink-primary truncate">{user?.name || user?.email || "Guest"}</p>
              <div className="flex items-center gap-2 mt-0.5">
                {user ? <ProBadge plan={user.plan} /> : <span className="chip">Guest</span>}
              </div>
            </div>
            {user ? (
              <button data-testid="logout-btn" onClick={async () => { await logout(); nav("/auth"); }} className="btn btn-ghost p-2 text-ink-tertiary">
                <LogOut size={18} />
              </button>
            ) : (
              <button data-testid="signin-btn" onClick={() => { exitGuest(); nav("/auth"); }} className="btn btn-secondary text-sm">
                <LogIn size={16} /> Sign in
              </button>
            )}
          </div>
        </Section>

        <Section title="Modules">
          {ITEMS.map((it) => (
            <Link
              key={it.to}
              to={it.to}
              data-testid={it.testid}
              className="row hover:bg-bg-elevated"
            >
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <div className="w-9 h-9 rounded-xl bg-bg-elevated flex items-center justify-center text-brand">
                  <it.icon size={18} />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-ink-primary">{it.label}</p>
                  <p className="text-xs text-ink-tertiary truncate">{it.desc}</p>
                </div>
              </div>
              <ChevronRight size={18} className="text-ink-tertiary" />
            </Link>
          ))}
        </Section>

        {!user && !guest && (
          <p className="text-xs text-ink-tertiary text-center px-4">
            Tip: sign in to keep your data safe.
          </p>
        )}
      </PageContainer>
    </>
  );
}

function ProBadge({ plan }) {
  if (plan === "pro") {
    return (
      <span data-testid="plan-badge-pro" className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-extrabold uppercase tracking-widest bg-brand/15 border border-brand/30 text-brand-light">
        <Sparkles size={10} /> Pro
      </span>
    );
  }
  return <span data-testid="plan-badge-free" className="chip">Free</span>;
}
