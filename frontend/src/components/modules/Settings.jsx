import React, { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { ScreenHeader, PageContainer, Section, Field, Toast, useToast } from "../ui/Shell";
import { useAuth } from "../../contexts/AuthContext";
import { Sparkles, LogOut, LogIn } from "lucide-react";
import { useNavigate } from "react-router-dom";

export function AccountSettings() {
  const { user, guest, logout, exitGuest, refreshEntitlement } = useAuth();
  const nav = useNavigate();
  const { toast, show, clear } = useToast();
  const [busy, setBusy] = useState(false);
  const [ent, setEnt] = useState(null);
  const isPro = user?.plan === "pro";

  async function refresh() {
    setBusy(true);
    try {
      const data = await refreshEntitlement();
      setEnt(data);
      show(data.plan === "pro" ? "Pro confirmed" : "Plan refreshed", "success");
    } catch (e) {
      show("Could not refresh — try again later", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <ScreenHeader title="Account Settings" subtitle="RootRecord account, plan, and sync" />
      <PageContainer>
        <Section title="Account">
          <div className="p-4">
            {user ? (
              <>
                <div className="flex justify-between mb-3">
                  <span className="text-sm text-ink-secondary">Signed in as</span>
                  <span data-testid="account-email" className="text-sm font-semibold">{user.email}</span>
                </div>
                <div className="flex justify-between items-center mb-3">
                  <span className="text-sm text-ink-secondary">Membership</span>
                  {isPro ? (
                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-extrabold uppercase tracking-widest bg-brand/15 border border-brand/30 text-brand-light">
                      <Sparkles size={10} /> Pro
                    </span>
                  ) : <span className="chip">Free</span>}
                </div>
                {(user.subscription_status || ent?.subscription_status) && (
                  <div className="flex justify-between mb-3">
                    <span className="text-sm text-ink-secondary">Subscription</span>
                    <span className="text-sm font-semibold capitalize">{ent?.subscription_status || user.subscription_status}</span>
                  </div>
                )}
                {ent?.valid_until && (
                  <div className="flex justify-between mb-3">
                    <span className="text-sm text-ink-secondary">Valid until</span>
                    <span className="text-sm font-semibold">{new Date(ent.valid_until).toLocaleString()}</span>
                  </div>
                )}
                <button data-testid="account-refresh-btn" onClick={refresh} disabled={busy} className="btn btn-primary w-full mb-2">
                  {busy ? "Checking…" : "Refresh entitlement"}
                </button>
                <button data-testid="account-logout-btn" onClick={async () => { await logout(); nav("/auth"); }} className="btn btn-secondary w-full">
                  <LogOut size={16} /> Log out
                </button>
                <p className="text-[11px] text-ink-tertiary mt-3 text-center">
                  Same email/password as the Windows desktop app · device-bound via licence Worker.
                </p>
              </>
            ) : (
              <>
                <p className="text-sm text-ink-secondary mb-3">{guest ? "You're using guest mode. Your data won't sync." : "Not signed in."}</p>
                <button data-testid="account-signin-btn" onClick={() => { exitGuest(); nav("/auth"); }} className="btn btn-primary w-full">
                  <LogIn size={16} /> Sign in
                </button>
              </>
            )}
          </div>
        </Section>

        <Section title="Plan overview">
          <div className="p-4 grid grid-cols-2 gap-3">
            <div className={`card p-3 border-2 ${!isPro ? "border-brand/40" : "border-transparent"}`}>
              <p className="font-heading font-bold text-base">Free</p>
              <ul className="text-xs text-ink-secondary mt-2 space-y-1">
                <li>• Local-first data</li>
                <li>• One business</li>
                <li>• Basic reports</li>
              </ul>
            </div>
            <div className={`card p-3 border-2 ${isPro ? "border-brand/40 bg-brand/5" : "border-transparent"}`}>
              <p className="font-heading font-bold text-base flex items-center gap-1">Pro <Sparkles size={12} className="text-brand" /></p>
              <ul className="text-xs text-ink-secondary mt-2 space-y-1">
                <li>• Full Reports + PDF</li>
                <li>• Multi-business</li>
                <li>• Cloud sync (planned)</li>
              </ul>
            </div>
          </div>
          {user && !isPro && (
            <div className="px-4 pb-4">
              <a
                data-testid="upgrade-pro-link"
                href="https://rootrecord.info"
                target="_blank"
                rel="noreferrer"
                className="btn btn-primary w-full"
              >
                <Sparkles size={16} /> Upgrade on rootrecord.info
              </a>
              <p className="text-[10px] text-ink-tertiary text-center mt-2">After paying, tap "Refresh entitlement" above.</p>
            </div>
          )}
        </Section>

        <Section title="Cloud sync">
          <div className="p-4 text-sm text-ink-secondary">
            <p>You're authenticated with the same RootRecord licence Worker the Windows desktop app uses, so your email/password works on both. Cloud data sync (push/pull of business records) is the next milestone — wire-up will reuse your existing token.</p>
            <button disabled className="btn btn-secondary w-full mt-3 opacity-60">Sync with cloud (planned)</button>
          </div>
        </Section>
      </PageContainer>
      <Toast message={toast.message} kind={toast.kind} onDone={clear} />
    </>
  );
}

export function BusinessSettings() {
  const { guest } = useAuth();
  const [items, setItems] = useState([]);
  const [activeId, setActiveId] = useState("");
  const [active, setActive] = useState(null);
  const [newName, setNewName] = useState("");
  const { toast, show, clear } = useToast();

  async function load() {
    if (guest) return;
    const { data } = await api.get("/businesses");
    setItems(data);
    if (data[0] && !activeId) {
      setActiveId(data[0].id);
      setActive(data[0]);
    }
  }
  useEffect(() => { load(); }, [guest]); // eslint-disable-line

  useEffect(() => {
    if (!activeId) return;
    setActive(items.find((b) => b.id === activeId) || null);
  }, [activeId, items]);

  async function addBiz() {
    if (!newName.trim()) return;
    await api.post("/businesses", { name: newName.trim() });
    setNewName(""); show("Business added", "success"); load();
  }

  async function save() {
    if (!active) return;
    const { id, user_id, created_at, updated_at, _id, is_default, ...rest } = active;
    await api.patch(`/businesses/${id}`, rest);
    show("Saved", "success");
  }

  return (
    <>
      <ScreenHeader title="Business Settings" subtitle="Profiles, contact, address, timezone" />
      <PageContainer>
        {guest ? <p className="text-sm text-ink-tertiary">Sign in to manage businesses.</p> : (
          <>
            <Section title="Business you are editing">
              <div className="p-4">
                <Field label="Choose business">
                  <select data-testid="business-select" className="input" value={activeId} onChange={(e)=>setActiveId(e.target.value)}>
                    {items.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </Field>
                <div className="grid grid-cols-[1fr_auto] gap-2">
                  <input data-testid="business-new-name" className="input" placeholder="New business name" value={newName} onChange={(e)=>setNewName(e.target.value)} />
                  <button data-testid="business-add-btn" onClick={addBiz} className="btn btn-primary">Add</button>
                </div>
              </div>
            </Section>
            {active && (
              <Section title="Profile">
                <div className="p-4">
                  <Field label="Business name"><input data-testid="business-name" className="input" value={active.name||""} onChange={(e)=>setActive({...active,name:e.target.value})} /></Field>
                  <Field label="Legal name"><input className="input" value={active.legal_name||""} onChange={(e)=>setActive({...active,legal_name:e.target.value})} /></Field>
                  <Field label="Owner / contact"><input className="input" value={active.owner||""} onChange={(e)=>setActive({...active,owner:e.target.value})} /></Field>
                  <Field label="Tax ID"><input className="input" value={active.tax_id||""} onChange={(e)=>setActive({...active,tax_id:e.target.value})} /></Field>
                  <Field label="Email"><input className="input" type="email" value={active.email||""} onChange={(e)=>setActive({...active,email:e.target.value})} /></Field>
                  <Field label="Phone"><input className="input" value={active.phone||""} onChange={(e)=>setActive({...active,phone:e.target.value})} /></Field>
                  <Field label="Website"><input className="input" value={active.website||""} onChange={(e)=>setActive({...active,website:e.target.value})} /></Field>
                  <Field label="Address"><textarea className="input min-h-[80px] py-3" value={active.address||""} onChange={(e)=>setActive({...active,address:e.target.value})} /></Field>
                  <Field label="Invoice notes"><textarea className="input min-h-[60px] py-3" value={active.invoice_notes||""} onChange={(e)=>setActive({...active,invoice_notes:e.target.value})} /></Field>
                  <button data-testid="business-save-btn" onClick={save} className="btn btn-primary w-full">Save</button>
                </div>
              </Section>
            )}
          </>
        )}
      </PageContainer>
      <Toast message={toast.message} kind={toast.kind} onDone={clear} />
    </>
  );
}

export function ProgramSettings() {
  const { guest } = useAuth();
  const [s, setS] = useState(null);
  const { toast, show, clear } = useToast();
  async function load() {
    if (guest) return;
    const { data } = await api.get("/settings");
    setS(data);
  }
  useEffect(() => { load(); }, [guest]); // eslint-disable-line
  async function save() {
    if (!s) return;
    await api.patch("/settings", {
      currency_default: s.currency_default,
      theme: s.theme,
      prompt_interval_sec: parseInt(s.prompt_interval_sec, 10) || 0,
      prompt_first_delay_sec: parseInt(s.prompt_first_delay_sec, 10) || 0,
      prompt_response_timeout_sec: parseInt(s.prompt_response_timeout_sec, 10) || 0,
      default_hourly_cents: parseInt(s.default_hourly_cents, 10) || 0,
      show_money_in_dashboard: !!s.show_money_in_dashboard,
      help_bubbles_enabled: !!s.help_bubbles_enabled,
      business_timezone: s.business_timezone || "system",
    });
    show("Settings saved", "success");
  }
  return (
    <>
      <ScreenHeader title="Program Settings" subtitle="Currency, theme, prompts, timezone" />
      <PageContainer>
        {guest || !s ? <p className="text-sm text-ink-tertiary">Sign in to edit settings.</p> : (
          <Section>
            <div className="p-4">
              <Field label="Default currency">
                <select data-testid="settings-currency" className="input" value={s.currency_default} onChange={(e)=>setS({...s, currency_default:e.target.value})}>
                  <option>USD</option><option>EUR</option><option>GBP</option><option>CAD</option><option>AUD</option><option>JPY</option>
                </select>
              </Field>
              <Field label="Theme">
                <select data-testid="settings-theme" className="input" value={s.theme} onChange={(e)=>setS({...s, theme:e.target.value})}>
                  <option value="dark">Dark</option>
                  <option value="system">System</option>
                </select>
              </Field>
              <Field label="Prompt interval (seconds)"><input data-testid="settings-prompt-interval" className="input" type="number" value={s.prompt_interval_sec} onChange={(e)=>setS({...s,prompt_interval_sec:e.target.value})} /></Field>
              <Field label="First prompt after clock-in (seconds)"><input data-testid="settings-prompt-first" className="input" type="number" value={s.prompt_first_delay_sec} onChange={(e)=>setS({...s,prompt_first_delay_sec:e.target.value})} /></Field>
              <Field label="Prompt response timeout (seconds)"><input data-testid="settings-prompt-timeout" className="input" type="number" value={s.prompt_response_timeout_sec} onChange={(e)=>setS({...s,prompt_response_timeout_sec:e.target.value})} /></Field>
              <Field label="Default hourly rate (cents)"><input data-testid="settings-hourly" className="input" type="number" value={s.default_hourly_cents} onChange={(e)=>setS({...s,default_hourly_cents:e.target.value})} /></Field>
              <Field label="Time zone (IANA)">
                <select data-testid="settings-timezone" className="input" value={s.business_timezone} onChange={(e)=>setS({...s,business_timezone:e.target.value})}>
                  <option value="system">Use system (OS region)</option>
                  <option value="UTC">UTC</option>
                  <option value="America/New_York">America/New_York</option>
                  <option value="America/Chicago">America/Chicago</option>
                  <option value="America/Denver">America/Denver</option>
                  <option value="America/Los_Angeles">America/Los_Angeles</option>
                  <option value="America/Detroit">America/Detroit</option>
                  <option value="Europe/London">Europe/London</option>
                  <option value="Europe/Berlin">Europe/Berlin</option>
                  <option value="Asia/Tokyo">Asia/Tokyo</option>
                  <option value="Pacific/Honolulu">Pacific/Honolulu</option>
                </select>
              </Field>
              <label className="row" style={{ paddingLeft: 0, paddingRight: 0 }}>
                <span className="text-sm">Show money summary on dashboard</span>
                <input data-testid="settings-money-summary" type="checkbox" checked={!!s.show_money_in_dashboard} onChange={(e)=>setS({...s,show_money_in_dashboard:e.target.checked})} className="w-5 h-5 accent-[#2B8A8F]" />
              </label>
              <label className="row" style={{ paddingLeft: 0, paddingRight: 0 }}>
                <span className="text-sm">Show help tips</span>
                <input data-testid="settings-help-tips" type="checkbox" checked={!!s.help_bubbles_enabled} onChange={(e)=>setS({...s,help_bubbles_enabled:e.target.checked})} className="w-5 h-5 accent-[#2B8A8F]" />
              </label>
              <button data-testid="settings-save-btn" onClick={save} className="btn btn-primary w-full mt-2">Save settings</button>
            </div>
          </Section>
        )}
      </PageContainer>
      <Toast message={toast.message} kind={toast.kind} onDone={clear} />
    </>
  );
}

export function About() {
  return (
    <>
      <ScreenHeader title="About & Help" subtitle="Version, principles, and plans" />
      <PageContainer>
        <Section>
          <div className="p-4 space-y-3 text-sm">
            <p className="font-heading font-bold text-base text-ink-primary">RootRecord Business Manager</p>
            <p className="text-ink-secondary">Mobile build · v0.1.0 (mirrors desktop v2.0.x)</p>
            <p className="text-ink-secondary">Local-first time, money, clients, inventory, scheduling, and reports — designed to run wherever your business does.</p>
          </div>
        </Section>
        <Section title="What RootRecord stands for">
          <div className="p-4 text-sm text-ink-secondary space-y-1">
            <p>• Reliability first</p>
            <p>• Clarity over cleverness</p>
            <p>• Operability in the real world</p>
            <p>• Composable services</p>
            <p>• Respectful communication</p>
          </div>
        </Section>
        <Section title="Plans">
          <div className="p-4 text-sm text-ink-secondary space-y-2">
            <p><b className="text-ink-primary">Pro</b> unlocks Reports workspace, multi-business, and (planned) cloud backup + AI-assisted reports.</p>
            <p><b className="text-ink-primary">Free</b> keeps your data on your device. Account Settings shows your current plan.</p>
          </div>
        </Section>
        <Section title="Where to get help">
          <div className="p-4 text-sm text-ink-secondary">
            <p>Use <b className="text-ink-primary">Feedback</b> in the More menu for bug reports, ideas, or subscription questions. Visit <a className="text-brand" href="https://rootrecord.info" target="_blank" rel="noreferrer">rootrecord.info</a> for the latest.</p>
          </div>
        </Section>
      </PageContainer>
    </>
  );
}

export function Feedback() {
  const { guest } = useAuth();
  const [type, setType] = useState("general");
  const [msg, setMsg] = useState("");
  const [reply, setReply] = useState("");
  const [diag, setDiag] = useState(true);
  const { toast, show, clear } = useToast();
  async function send(e) {
    e.preventDefault();
    if (!msg.trim()) return show("Tell us something first", "error");
    if (guest) return show("Sign in to send feedback", "error");
    await api.post("/feedback", { type, message: msg, reply_email: reply || null, include_diagnostics: diag });
    setMsg(""); setReply(""); show("Feedback sent — thank you", "success");
  }
  return (
    <>
      <ScreenHeader title="Feedback" subtitle="Tell us what's working, or what isn't" />
      <PageContainer>
        <Section>
          <form onSubmit={send} className="p-4">
            <Field label="Type">
              <select data-testid="feedback-type" className="input" value={type} onChange={(e)=>setType(e.target.value)}>
                <option value="general">General</option>
                <option value="bug">Bug report</option>
                <option value="feature">Feature request</option>
                <option value="billing">Billing / account</option>
              </select>
            </Field>
            <Field label="Your feedback">
              <textarea data-testid="feedback-message" className="input min-h-[140px] py-3" value={msg} onChange={(e)=>setMsg(e.target.value)} placeholder="Describe what happened or what you would like…" />
            </Field>
            <Field label="Reply-to email (optional)">
              <input data-testid="feedback-email" className="input" type="email" value={reply} onChange={(e)=>setReply(e.target.value)} placeholder="you@example.com" />
            </Field>
            <label className="row" style={{ paddingLeft: 0, paddingRight: 0 }}>
              <span className="text-sm">Include app version and OS</span>
              <input data-testid="feedback-diag" type="checkbox" checked={diag} onChange={(e)=>setDiag(e.target.checked)} className="w-5 h-5 accent-[#2B8A8F]" />
            </label>
            <button data-testid="feedback-send-btn" className="btn btn-primary w-full">Send feedback</button>
          </form>
        </Section>
      </PageContainer>
      <Toast message={toast.message} kind={toast.kind} onDone={clear} />
    </>
  );
}
