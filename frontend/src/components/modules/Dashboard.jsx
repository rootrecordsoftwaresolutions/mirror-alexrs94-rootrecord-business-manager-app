import React, { useEffect, useMemo, useState } from "react";
import { ResponsiveContainer, PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip } from "recharts";
import { api } from "../../lib/api";
import { ScreenHeader, PageContainer, Section, Spinner, Empty, Toast, useToast } from "../ui/Shell";
import { fmtMoney, fmtHours, MONTHS_SHORT, startOfMonthISO, endOfMonthISO, startOfYearISO, isoNow, durationHours } from "../../lib/format";
import { TrendingUp, AlertCircle, Code, Users, FileSearch, Zap, Square, Play } from "lucide-react";
import { useAuth } from "../../contexts/AuthContext";
import { useNavigate } from "react-router-dom";

const ICON_MAP = { Code, Users, FileSearch, Zap, Play };

export default function Dashboard() {
  const { guest, user } = useAuth();
  const nav = useNavigate();
  const { toast, show, clear } = useToast();
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [scope, setScope] = useState("year"); // year | month
  const [monthIdx, setMonthIdx] = useState(new Date().getMonth());
  const year = new Date().getFullYear();

  // Quick actions state
  const [quickActions, setQuickActions] = useState([]);
  const [session, setSession] = useState(null);
  const [tickN, setTickN] = useState(0); // re-render every 30s while clocked in

  const [start, end] = useMemo(() => {
    if (scope === "year") return [startOfYearISO(), isoNow()];
    return [startOfMonthISO(year, monthIdx), endOfMonthISO(year, monthIdx)];
  }, [scope, monthIdx, year]);

  async function loadSummary() {
    if (guest || !user) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const { data } = await api.get("/dashboard/summary", { params: { start, end } });
      setSummary(data);
    } catch (e) {
      setError(e?.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  async function loadQuickAndSession() {
    if (guest || !user) return;
    try {
      const [{ data: qa }, { data: s }] = await Promise.all([
        api.get("/quick-actions"),
        api.get("/time/session"),
      ]);
      setQuickActions(qa || []);
      setSession(s?.active ? s : null);
    } catch { /* ignore */ }
  }

  useEffect(() => { loadSummary(); }, [start, end, guest, user]); // eslint-disable-line
  useEffect(() => { loadQuickAndSession(); }, [guest, user]); // eslint-disable-line

  // Live timer: tick every 30s while clocked in
  useEffect(() => {
    if (!session) return;
    const t = setInterval(() => setTickN((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, [session]);

  async function runQuick(qa) {
    if (guest) return show("Sign in to track time", "error");
    if (session) return show("Already on the clock", "error");
    try {
      const { data } = await api.post(`/quick-actions/${qa.id}/run`);
      setSession(data);
      show(`Clocked in: ${qa.label}`, "success");
    } catch (e) {
      show("Could not start", "error");
    }
  }

  async function stopNow() {
    try {
      await api.post("/time/clock-out", { description: "" });
      setSession(null);
      show("Saved time entry", "success");
      loadSummary();
    } catch { show("Could not clock out", "error"); }
  }

  return (
    <>
      <ScreenHeader title="Dashboard" subtitle="Hours, income/expense, and category breakdown" back={false} />
      <PageContainer>
        {guest && (
          <div className="card p-4 border border-[rgba(244,63,94,0.3)] bg-[rgba(244,63,94,0.08)] mb-4 flex gap-3" data-testid="guest-banner">
            <AlertCircle size={20} className="text-[#FB7185] flex-shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-semibold text-[#FB7185] mb-0.5">Guest mode</p>
              <p className="text-ink-secondary">Sign in to save data, unlock Pro reports, and (when shipped) cloud sync.</p>
            </div>
          </div>
        )}

        {/* Active session banner */}
        {session && (
          <div data-testid="active-session-banner" className="card p-3 mb-3 flex items-center gap-3 border border-brand/30 bg-brand/10">
            <div className="w-9 h-9 rounded-xl bg-brand flex items-center justify-center text-white animate-pulse">
              <Play size={16} fill="currentColor" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-ink-primary truncate">
                On the clock{session.description ? ` · ${session.description}` : ""}
              </p>
              <p className="text-xs text-brand-light font-semibold">
                {fmtHours(durationHours(session.started_at_utc, isoNow()))}
                <span className="hidden">{tickN}</span>
              </p>
            </div>
            <button data-testid="active-session-stop" onClick={stopNow} className="btn btn-danger min-h-[40px] px-3">
              <Square size={14} fill="currentColor" /> Stop
            </button>
          </div>
        )}

        {/* Quick actions */}
        {!guest && quickActions.length > 0 && !session && (
          <Section title="Quick actions">
            <div className="p-3 grid grid-cols-3 gap-2">
              {quickActions.slice(0, 6).map((qa) => {
                const Ico = ICON_MAP[qa.icon] || Zap;
                return (
                  <button
                    key={qa.id}
                    data-testid={`quick-action-${qa.label.toLowerCase()}`}
                    onClick={() => runQuick(qa)}
                    className="flex flex-col items-center justify-center gap-1.5 p-3 rounded-xl bg-bg-elevated border border-strong hover:border-brand/40 active:scale-[0.97] transition min-h-[80px]"
                  >
                    <div className="w-8 h-8 rounded-lg bg-brand/15 text-brand flex items-center justify-center">
                      <Ico size={16} />
                    </div>
                    <span className="text-xs font-semibold text-ink-primary truncate max-w-full">{qa.label}</span>
                  </button>
                );
              })}
            </div>
            <div className="px-3 pb-3 -mt-1">
              <button
                data-testid="manage-quick-actions"
                onClick={() => nav("/track")}
                className="text-[11px] text-ink-tertiary hover:text-ink-secondary"
              >
                Manage on Track →
              </button>
            </div>
          </Section>
        )}

        {/* scope */}
        <div className="card p-1 flex mb-3" data-testid="dashboard-scope">
          {[
            { id: "year", label: "Yearly" },
            { id: "month", label: "Monthly" },
          ].map((t) => (
            <button
              key={t.id}
              data-testid={`scope-${t.id}`}
              onClick={() => setScope(t.id)}
              className={`flex-1 py-2 rounded-xl text-sm font-semibold transition-colors min-h-[44px] ${
                scope === t.id ? "bg-bg-elevated text-ink-primary" : "text-ink-tertiary"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {scope === "month" && (
          <div className="flex gap-2 overflow-x-auto no-scrollbar mb-4 pb-1 -mx-1 px-1">
            {MONTHS_SHORT.map((m, i) => (
              <button
                key={m}
                onClick={() => setMonthIdx(i)}
                data-testid={`month-${m.toLowerCase()}`}
                data-active={monthIdx === i}
                className="chip"
              >
                {m}
              </button>
            ))}
          </div>
        )}

        {loading ? <Spinner /> : error ? (
          <Empty title="Couldn't load dashboard">{error}</Empty>
        ) : guest || !summary ? (
          <Empty title="Nothing to show yet" icon={<TrendingUp size={32} />}>
            {guest ? "Sign in to view live totals." : "Start tracking time or add income/expenses."}
          </Empty>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 mb-4">
              <Kpi testid="kpi-hours" label="Hours" value={fmtHours(summary.hours)} />
              <Kpi testid="kpi-income" label="Income" value={fmtMoney(summary.income_cents)} accent="income" />
              <Kpi testid="kpi-expenses" label="Expenses" value={fmtMoney(summary.expense_cents)} accent="expense" />
              <Kpi testid="kpi-net" label="Net" value={fmtMoney(summary.net_cents)} accent={summary.net_cents >= 0 ? "income" : "expense"} bold />
            </div>

            <Section title="By category">
              <div className="p-4">
                {summary.breakdown.length === 0 ? (
                  <p className="text-sm text-ink-tertiary text-center py-8">No tracked time in this window yet.</p>
                ) : (
                  <>
                    <div style={{ width: "100%", height: 220 }}>
                      <ResponsiveContainer>
                        <PieChart>
                          <Pie
                            data={summary.breakdown}
                            dataKey="hours"
                            nameKey="name"
                            innerRadius={45}
                            outerRadius={80}
                            paddingAngle={2}
                            stroke="none"
                          >
                            {summary.breakdown.map((b, i) => (
                              <Cell key={i} fill={b.color} />
                            ))}
                          </Pie>
                          <Tooltip contentStyle={{ background: "rgba(20,28,28,0.95)", border: "1px solid rgba(255,255,255,0.10)", borderRadius: 8 }} />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                    <div style={{ width: "100%", height: 200 }} className="mt-2">
                      <ResponsiveContainer>
                        <BarChart data={summary.breakdown} margin={{ top: 8, right: 8, left: -20, bottom: 8 }}>
                          <XAxis dataKey="name" tick={{ fill: "#687777", fontSize: 10 }} angle={-30} textAnchor="end" height={40} interval={0} />
                          <YAxis tick={{ fill: "#687777", fontSize: 10 }} />
                          <Tooltip />
                          <Bar dataKey="hours" radius={[6, 6, 0, 0]}>
                            {summary.breakdown.map((b, i) => (
                              <Cell key={i} fill={b.color} />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </>
                )}
              </div>
            </Section>
          </>
        )}
      </PageContainer>
      <Toast message={toast.message} kind={toast.kind} onDone={clear} />
    </>
  );
}

function Kpi({ label, value, accent, bold, testid }) {
  const color = accent === "income" ? "text-income" : accent === "expense" ? "text-expense" : "text-ink-primary";
  return (
    <div data-testid={testid} className="card p-4 flex flex-col">
      <span className="label">{label}</span>
      <span className={`font-heading ${bold ? "text-2xl" : "text-xl"} font-bold ${color} mt-1`}>{value}</span>
    </div>
  );
}
