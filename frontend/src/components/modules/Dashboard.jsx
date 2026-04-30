import React, { useEffect, useMemo, useState } from "react";
import { ResponsiveContainer, PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip } from "recharts";
import { api } from "../../lib/api";
import { ScreenHeader, PageContainer, Section, Spinner, Empty } from "../ui/Shell";
import { fmtMoney, fmtHours, MONTHS_SHORT, startOfMonthISO, endOfMonthISO, startOfYearISO, isoNow } from "../../lib/format";
import { TrendingUp, AlertCircle } from "lucide-react";
import { useAuth } from "../../contexts/AuthContext";

export default function Dashboard() {
  const { guest, user } = useAuth();
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [scope, setScope] = useState("year"); // year | month
  const [monthIdx, setMonthIdx] = useState(new Date().getMonth());
  const year = new Date().getFullYear();

  const [start, end] = useMemo(() => {
    if (scope === "year") return [startOfYearISO(), isoNow()];
    return [startOfMonthISO(year, monthIdx), endOfMonthISO(year, monthIdx)];
  }, [scope, monthIdx, year]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (guest || !user) {
        setLoading(false);
        return;
      }
      setLoading(true);
      setError("");
      try {
        const { data } = await api.get("/dashboard/summary", { params: { start, end } });
        if (!cancelled) setSummary(data);
      } catch (e) {
        if (!cancelled) setError(e?.message || "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [start, end, guest, user]);

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
