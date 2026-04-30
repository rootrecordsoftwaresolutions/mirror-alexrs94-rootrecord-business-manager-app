import React, { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { ScreenHeader, PageContainer, Section, Field, Empty, Toast, useToast } from "../ui/Shell";
import { fmtDateShort } from "../../lib/format";
import { Plus, Trash2 } from "lucide-react";
import { useAuth } from "../../contexts/AuthContext";

export default function Schedule() {
  const { guest } = useAuth();
  const [items, setItems] = useState([]);
  const [clients, setClients] = useState([]);
  const [title, setTitle] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [clientId, setClientId] = useState("");
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState("scheduled");
  const { toast, show, clear } = useToast();

  async function load() {
    if (guest) return;
    const [{ data: e }, { data: c }] = await Promise.all([api.get("/schedule"), api.get("/clients")]);
    setItems(e); setClients(c);
  }
  useEffect(() => { load(); }, [guest]); // eslint-disable-line

  async function add(e) {
    e.preventDefault();
    if (!title.trim() || !start) return show("Title and start required", "error");
    await api.post("/schedule", {
      title, starts_at_utc: new Date(start).toISOString(),
      ends_at_utc: end ? new Date(end).toISOString() : null,
      client_id: clientId || null, notes, status,
    });
    setTitle(""); setStart(""); setEnd(""); setNotes(""); setClientId(""); setStatus("scheduled");
    show("Event saved", "success"); load();
  }
  async function del(id) { await api.delete(`/schedule/${id}`); load(); }

  return (
    <>
      <ScreenHeader title="Schedule & Bookings" subtitle="Create events and review the next 90 days" back={false} />
      <PageContainer>
        {guest ? (
          <Empty title="Sign in to use Schedule & Bookings" />
        ) : (
          <>
            <Section title="New event">
              <form onSubmit={add} className="p-4">
                <Field label="Title"><input data-testid="event-title" className="input" value={title} onChange={(e)=>setTitle(e.target.value)} /></Field>
                <Field label="Starts"><input data-testid="event-start" className="input" type="datetime-local" value={start} onChange={(e)=>setStart(e.target.value)} /></Field>
                <Field label="Ends (optional)"><input data-testid="event-end" className="input" type="datetime-local" value={end} onChange={(e)=>setEnd(e.target.value)} /></Field>
                <Field label="Client (optional)">
                  <select data-testid="event-client" className="input" value={clientId} onChange={(e)=>setClientId(e.target.value)}>
                    <option value="">—</option>
                    {clients.map((c)=> <option key={c.id} value={c.id}>{c.display_name}</option>)}
                  </select>
                </Field>
                <Field label="Status">
                  <select data-testid="event-status" className="input" value={status} onChange={(e)=>setStatus(e.target.value)}>
                    <option value="scheduled">Scheduled</option>
                    <option value="done">Done</option>
                    <option value="cancelled">Cancelled</option>
                  </select>
                </Field>
                <Field label="Notes"><textarea data-testid="event-notes" className="input min-h-[80px] py-3" rows={3} value={notes} onChange={(e)=>setNotes(e.target.value)} /></Field>
                <button data-testid="event-add-btn" className="btn btn-primary w-full"><Plus size={16} /> Save event</button>
              </form>
            </Section>

            <Section title={`Upcoming (${items.length})`}>
              {items.length === 0 ? <p className="p-4 text-sm text-ink-tertiary">No events yet.</p> :
                items.map((ev) => (
                  <div key={ev.id} data-testid={`event-row-${ev.id}`} className="row">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm truncate font-semibold">{ev.title}</p>
                      <p className="text-xs text-ink-tertiary">
                        {fmtDateShort(ev.starts_at_utc)}
                        {ev.ends_at_utc && ` → ${fmtDateShort(ev.ends_at_utc)}`}
                        {" · "}{ev.status}
                      </p>
                    </div>
                    <button onClick={() => del(ev.id)} className="btn btn-ghost p-2 text-ink-tertiary"><Trash2 size={16} /></button>
                  </div>
                ))}
            </Section>
          </>
        )}
      </PageContainer>
      <Toast message={toast.message} kind={toast.kind} onDone={clear} />
    </>
  );
}
