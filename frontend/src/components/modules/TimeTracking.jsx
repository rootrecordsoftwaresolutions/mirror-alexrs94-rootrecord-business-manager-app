import React, { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { ScreenHeader, PageContainer, Section, Field, Empty, Toast, useToast } from "../ui/Shell";
import { fmtDateShort, durationHours, fmtHours, isoNow } from "../../lib/format";
import { Play, Square, PlusCircle } from "lucide-react";
import { useAuth } from "../../contexts/AuthContext";

export default function TimeTracking() {
  const { guest } = useAuth();
  const { toast, show, clear } = useToast();
  const [session, setSession] = useState(null);
  const [categories, setCategories] = useState([]);
  const [projects, setProjects] = useState([]);
  const [categoryId, setCategoryId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  // Manual entry
  const [mStart, setMStart] = useState("");
  const [mEnd, setMEnd] = useState("");
  const [mCat, setMCat] = useState("");
  const [mDesc, setMDesc] = useState("");

  async function load() {
    if (guest) return;
    try {
      const [s, c, p] = await Promise.all([
        api.get("/time/session"),
        api.get("/categories"),
        api.get("/projects"),
      ]);
      setSession(s.data?.active ? s.data : null);
      setCategories(c.data || []);
      setProjects(p.data || []);
      if (c.data?.[0] && !categoryId) setCategoryId(c.data[0].id);
    } catch {/* ignore */}
  }

  useEffect(() => { load(); }, [guest]); // eslint-disable-line

  async function clockIn() {
    if (guest) return show("Sign in to track time", "error");
    setBusy(true);
    try {
      const { data } = await api.post("/time/clock-in", {
        category_id: categoryId || null,
        project_id: projectId || null,
        description,
      });
      setSession(data);
      show("Clocked in", "success");
    } catch (e) { show("Could not clock in", "error"); }
    finally { setBusy(false); }
  }

  async function clockOut() {
    setBusy(true);
    try {
      await api.post("/time/clock-out", { description });
      setSession(null);
      setDescription("");
      show("Saved time entry", "success");
    } catch (e) { show("Could not clock out", "error"); }
    finally { setBusy(false); }
  }

  async function saveManual() {
    if (guest) return show("Sign in to track time", "error");
    if (!mStart || !mEnd) return show("Pick start and end", "error");
    try {
      await api.post("/time/manual", {
        start_utc: new Date(mStart).toISOString(),
        end_utc: new Date(mEnd).toISOString(),
        category_id: mCat || null,
        description: mDesc,
      });
      setMStart(""); setMEnd(""); setMDesc("");
      show("Manual entry saved", "success");
    } catch { show("Could not save", "error"); }
  }

  return (
    <>
      <ScreenHeader title="Time & Tracking" subtitle="Clock in, clock out, or log manually" back={false} />
      <PageContainer>
        {guest ? (
          <Empty title="Sign in to track time" icon={<Play size={32} />}>
            Time entries are tied to your account.
          </Empty>
        ) : (
          <>
            <Section title="Now">
              <div className="p-4">
                <div className="row" style={{ borderBottom: "none", padding: 0, marginBottom: 12 }}>
                  <div>
                    <p className="text-xs text-ink-tertiary">Status</p>
                    <p data-testid="session-status" className="font-heading text-base font-semibold">
                      {session ? "On the clock" : "Off the clock"}
                    </p>
                  </div>
                  {session && (
                    <p className="text-xs text-ink-secondary">
                      Started {fmtDateShort(session.started_at_utc)}<br />
                      <span className="text-brand font-semibold">
                        {fmtHours(durationHours(session.started_at_utc, isoNow()))}
                      </span>
                    </p>
                  )}
                </div>
                {!session && (
                  <>
                    <Field label="Category">
                      <select className="input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} data-testid="track-category">
                        <option value="">—</option>
                        {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </Field>
                    <Field label="Project (optional)">
                      <select className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)} data-testid="track-project">
                        <option value="">—</option>
                        {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                    </Field>
                  </>
                )}
                <Field label="What you are doing">
                  <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Working on…" data-testid="track-description" />
                </Field>
                {session ? (
                  <button data-testid="clock-out-btn" onClick={clockOut} disabled={busy} className="btn btn-danger w-full">
                    <Square size={18} fill="currentColor" /> Clock out
                  </button>
                ) : (
                  <button data-testid="clock-in-btn" onClick={clockIn} disabled={busy} className="btn btn-primary w-full">
                    <Play size={18} fill="currentColor" /> Clock in
                  </button>
                )}
              </div>
            </Section>

            <Section title="Manual time entry">
              <div className="p-4">
                <Field label="Start">
                  <input data-testid="manual-start" className="input" type="datetime-local" value={mStart} onChange={(e) => setMStart(e.target.value)} />
                </Field>
                <Field label="End">
                  <input data-testid="manual-end" className="input" type="datetime-local" value={mEnd} onChange={(e) => setMEnd(e.target.value)} />
                </Field>
                <Field label="Category">
                  <select className="input" value={mCat} onChange={(e) => setMCat(e.target.value)} data-testid="manual-category">
                    <option value="">—</option>
                    {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </Field>
                <Field label="Description">
                  <input className="input" value={mDesc} onChange={(e) => setMDesc(e.target.value)} placeholder="What was this?" data-testid="manual-description" />
                </Field>
                <button data-testid="manual-save-btn" onClick={saveManual} className="btn btn-secondary w-full">
                  <PlusCircle size={18} /> Save manual entry
                </button>
              </div>
            </Section>
          </>
        )}
      </PageContainer>
      <Toast message={toast.message} kind={toast.kind} onDone={clear} />
    </>
  );
}
