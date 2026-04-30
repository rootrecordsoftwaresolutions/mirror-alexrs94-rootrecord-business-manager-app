import React, { useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import { ScreenHeader, PageContainer, Empty, Spinner, Toast, useToast } from "../ui/Shell";
import { fmtDateShort, durationHours, fmtHours } from "../../lib/format";
import { Search, Trash2 } from "lucide-react";
import { useAuth } from "../../contexts/AuthContext";

export default function WorkLog() {
  const { guest } = useAuth();
  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const [start, setStart] = useState(monthStart.toISOString().slice(0, 10));
  const [end, setEnd] = useState(today.toISOString().slice(0, 10));
  const [q, setQ] = useState("");
  const [entries, setEntries] = useState([]);
  const [cats, setCats] = useState({});
  const [loading, setLoading] = useState(false);
  const { toast, show, clear } = useToast();

  async function load() {
    if (guest) return;
    setLoading(true);
    try {
      const [{ data: rows }, { data: catRows }] = await Promise.all([
        api.get("/time/entries", {
          params: {
            start: new Date(`${start}T00:00:00`).toISOString(),
            end: new Date(`${end}T23:59:59`).toISOString(),
            q: q || undefined,
          },
        }),
        api.get("/categories"),
      ]);
      setEntries(rows);
      setCats(Object.fromEntries(catRows.map((c) => [c.id, c])));
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []); // eslint-disable-line

  async function del(id) {
    if (!window.confirm("Delete this entry?")) return;
    try {
      await api.delete(`/time/entries/${id}`);
      setEntries((x) => x.filter((e) => e.id !== id));
      show("Deleted", "success");
    } catch { show("Could not delete", "error"); }
  }

  const totalHours = useMemo(
    () => entries.reduce((s, e) => s + durationHours(e.start_utc, e.end_utc), 0),
    [entries]
  );

  return (
    <>
      <ScreenHeader title="Work Log" subtitle="Tracked time blocks for the selected range" />
      <PageContainer>
        {guest ? (
          <Empty title="Sign in to view your work log" />
        ) : (
          <>
            <div className="card p-3 mb-3 grid grid-cols-2 gap-2">
              <label className="block">
                <span className="label">Start</span>
                <input data-testid="worklog-start" type="date" className="input" value={start} onChange={(e) => setStart(e.target.value)} />
              </label>
              <label className="block">
                <span className="label">End</span>
                <input data-testid="worklog-end" type="date" className="input" value={end} onChange={(e) => setEnd(e.target.value)} />
              </label>
              <label className="block col-span-2">
                <span className="label">Search</span>
                <div className="relative">
                  <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-tertiary" />
                  <input data-testid="worklog-search" className="input pl-9" placeholder="Filter description…" value={q} onChange={(e) => setQ(e.target.value)} />
                </div>
              </label>
              <button data-testid="worklog-load-btn" onClick={load} className="btn btn-primary col-span-2">Load range</button>
            </div>

            <div className="card p-3 mb-3 flex justify-between items-center">
              <span className="text-sm text-ink-secondary">{entries.length} entries</span>
              <span className="text-sm text-brand font-semibold">{fmtHours(totalHours)}</span>
            </div>

            {loading ? <Spinner /> : entries.length === 0 ? (
              <Empty title="No entries" >Try a wider date range or clock in / add manual entries.</Empty>
            ) : (
              <div className="card overflow-hidden">
                {entries.map((e) => {
                  const cat = cats[e.category_id];
                  return (
                    <div key={e.id} data-testid={`worklog-row-${e.id}`} className="row">
                      <div className="min-w-0 pr-3 flex-1">
                        <p className="text-sm text-ink-primary truncate">
                          {cat && <span className="inline-block w-2 h-2 rounded-full mr-2" style={{ backgroundColor: cat.color }} />}
                          {e.description || cat?.name || "Time entry"}
                        </p>
                        <p className="text-xs text-ink-tertiary mt-0.5">
                          {fmtDateShort(e.start_utc)} → {fmtDateShort(e.end_utc)} · {fmtHours(durationHours(e.start_utc, e.end_utc))}
                        </p>
                      </div>
                      <button data-testid={`worklog-delete-${e.id}`} onClick={() => del(e.id)} className="btn btn-ghost p-2 text-ink-tertiary hover:text-expense">
                        <Trash2 size={16} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </PageContainer>
      <Toast message={toast.message} kind={toast.kind} onDone={clear} />
    </>
  );
}
