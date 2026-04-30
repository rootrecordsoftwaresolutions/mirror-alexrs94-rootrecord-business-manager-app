import React, { useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import { ScreenHeader, PageContainer, Section, Field, Empty, Toast, useToast, Spinner } from "../ui/Shell";
import { fmtMoney, fmtDateShort } from "../../lib/format";
import { Plus, Trash2, ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { useAuth } from "../../contexts/AuthContext";

const TABS = [
  { id: "money", label: "Money" },
  { id: "clients", label: "Clients" },
  { id: "invoices", label: "Invoices" },
  { id: "debts", label: "Debts" },
  { id: "funds", label: "Funds" },
  { id: "scheduled", label: "Scheduled" },
  { id: "resources", label: "Resources" },
  { id: "tax", label: "Tax" },
];

export default function Finance() {
  const { guest } = useAuth();
  const [tab, setTab] = useState("money");
  return (
    <>
      <ScreenHeader title="Finance & Clients" subtitle="Money, clients, invoices, debts, funds, more" back={false} />
      <PageContainer>
        <div className="card p-1 flex overflow-x-auto no-scrollbar mb-4 sticky top-[68px] z-10">
          {TABS.map((t) => (
            <button
              key={t.id}
              data-testid={`finance-tab-${t.id}`}
              onClick={() => setTab(t.id)}
              className={`flex-shrink-0 px-4 py-2 rounded-xl text-sm font-semibold transition-colors min-h-[40px] ${
                tab === t.id ? "bg-bg-elevated text-ink-primary" : "text-ink-tertiary"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {guest ? (
          <Empty title="Sign in to manage your money & clients" />
        ) : (
          <>
            {tab === "money" && <MoneyTab />}
            {tab === "clients" && <ClientsTab />}
            {tab === "invoices" && <InvoicesTab />}
            {tab === "debts" && <DebtsTab />}
            {tab === "funds" && <FundsTab />}
            {tab === "scheduled" && <ScheduledTab />}
            {tab === "resources" && <ResourcesTab />}
            {tab === "tax" && <TaxTab />}
          </>
        )}
      </PageContainer>
    </>
  );
}

// ------------ Money (income / expenses) ------------
function MoneyTab() {
  const { toast, show, clear } = useToast();
  const [income, setIncome] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [loading, setLoading] = useState(true);
  // form
  const [iAmount, setIAmount] = useState("");
  const [iDesc, setIDesc] = useState("");
  const [eAmount, setEAmount] = useState("");
  const [eDesc, setEDesc] = useState("");
  const [eFunding, setEFunding] = useState("cash");

  async function load() {
    setLoading(true);
    try {
      const [{ data: i }, { data: e }] = await Promise.all([
        api.get("/money/income"),
        api.get("/money/expenses"),
      ]);
      setIncome(i); setExpenses(e);
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  async function addIncome(ev) {
    ev.preventDefault();
    const cents = Math.round(parseFloat(iAmount || "0") * 100);
    if (!cents) return show("Enter an amount", "error");
    await api.post("/money/income", { amount_cents: cents, description: iDesc, currency: "USD" });
    setIAmount(""); setIDesc(""); show("Income added", "success"); load();
  }
  async function addExpense(ev) {
    ev.preventDefault();
    const cents = Math.round(parseFloat(eAmount || "0") * 100);
    if (!cents) return show("Enter an amount", "error");
    await api.post("/money/expenses", { amount_cents: cents, description: eDesc, funding: eFunding, currency: "USD" });
    setEAmount(""); setEDesc(""); show("Expense added", "success"); load();
  }
  async function delI(id) { await api.delete(`/money/income/${id}`); load(); }
  async function delE(id) { await api.delete(`/money/expenses/${id}`); load(); }

  return (
    <>
      <Section title="Add income">
        <form onSubmit={addIncome} className="p-4">
          <Field label="Amount (USD)">
            <input data-testid="income-amount" className="input" type="number" step="0.01" inputMode="decimal" value={iAmount} onChange={(e) => setIAmount(e.target.value)} placeholder="0.00" />
          </Field>
          <Field label="Description">
            <input data-testid="income-desc" className="input" value={iDesc} onChange={(e) => setIDesc(e.target.value)} placeholder="Project payment, refund, etc." />
          </Field>
          <button data-testid="income-add-btn" className="btn btn-primary w-full"><Plus size={16} /> Add income</button>
        </form>
      </Section>
      <Section title="Add expense">
        <form onSubmit={addExpense} className="p-4">
          <Field label="Amount (USD)">
            <input data-testid="expense-amount" className="input" type="number" step="0.01" inputMode="decimal" value={eAmount} onChange={(e) => setEAmount(e.target.value)} placeholder="0.00" />
          </Field>
          <Field label="Funding">
            <select data-testid="expense-funding" className="input" value={eFunding} onChange={(e) => setEFunding(e.target.value)}>
              <option value="cash">Cash</option>
              <option value="bank">Bank</option>
              <option value="credit">Credit</option>
            </select>
          </Field>
          <Field label="Description">
            <input data-testid="expense-desc" className="input" value={eDesc} onChange={(e) => setEDesc(e.target.value)} placeholder="Software, supplies, fuel…" />
          </Field>
          <button data-testid="expense-add-btn" className="btn btn-primary w-full"><Plus size={16} /> Add expense</button>
        </form>
      </Section>

      {loading ? <Spinner /> : (
        <>
          <Section title={`Income (${income.length})`}>
            {income.length === 0 ? <p className="p-4 text-sm text-ink-tertiary">No income yet.</p> :
              income.map((i) => (
                <div key={i.id} data-testid={`income-row-${i.id}`} className="row">
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <ArrowDownLeft size={18} className="text-income flex-shrink-0" />
                    <div className="min-w-0">
                      <p className="text-sm truncate">{i.description || "Income"}</p>
                      <p className="text-xs text-ink-tertiary">{fmtDateShort(i.received_at_utc)}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-income font-semibold">{fmtMoney(i.amount_cents, i.currency)}</span>
                    <button onClick={() => delI(i.id)} className="btn btn-ghost p-2 text-ink-tertiary"><Trash2 size={16} /></button>
                  </div>
                </div>
              ))
            }
          </Section>
          <Section title={`Expenses (${expenses.length})`}>
            {expenses.length === 0 ? <p className="p-4 text-sm text-ink-tertiary">No expenses yet.</p> :
              expenses.map((x) => (
                <div key={x.id} data-testid={`expense-row-${x.id}`} className="row">
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <ArrowUpRight size={18} className="text-expense flex-shrink-0" />
                    <div className="min-w-0">
                      <p className="text-sm truncate">{x.description || "Expense"}</p>
                      <p className="text-xs text-ink-tertiary">{fmtDateShort(x.spent_at_utc)} · {x.funding}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-expense font-semibold">{fmtMoney(x.amount_cents, x.currency)}</span>
                    <button onClick={() => delE(x.id)} className="btn btn-ghost p-2 text-ink-tertiary"><Trash2 size={16} /></button>
                  </div>
                </div>
              ))
            }
          </Section>
        </>
      )}
      <Toast message={toast.message} kind={toast.kind} onDone={clear} />
    </>
  );
}

// ------------ Clients ------------
function ClientsTab() {
  const [items, setItems] = useState([]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const { toast, show, clear } = useToast();
  async function load() { const { data } = await api.get("/clients"); setItems(data); }
  useEffect(() => { load(); }, []);
  async function add(e) {
    e.preventDefault();
    if (!name.trim()) return show("Name required", "error");
    await api.post("/clients", { display_name: name.trim(), email, phone });
    setName(""); setEmail(""); setPhone(""); load(); show("Client added", "success");
  }
  async function del(id) { await api.delete(`/clients/${id}`); load(); }
  return (
    <>
      <Section title="Add client">
        <form onSubmit={add} className="p-4">
          <Field label="Name"><input data-testid="client-name" className="input" value={name} onChange={(e)=>setName(e.target.value)} /></Field>
          <Field label="Email"><input data-testid="client-email" className="input" value={email} onChange={(e)=>setEmail(e.target.value)} /></Field>
          <Field label="Phone"><input data-testid="client-phone" className="input" value={phone} onChange={(e)=>setPhone(e.target.value)} /></Field>
          <button data-testid="client-add-btn" className="btn btn-primary w-full"><Plus size={16} /> Add client</button>
        </form>
      </Section>
      <Section title={`Clients (${items.length})`}>
        {items.length === 0 ? <p className="p-4 text-sm text-ink-tertiary">No clients yet.</p> :
          items.map((c) => (
            <div key={c.id} data-testid={`client-row-${c.id}`} className="row">
              <div className="min-w-0 flex-1">
                <p className="text-sm truncate">{c.display_name}</p>
                <p className="text-xs text-ink-tertiary truncate">{c.email || c.phone || "—"}</p>
              </div>
              <button onClick={() => del(c.id)} className="btn btn-ghost p-2 text-ink-tertiary"><Trash2 size={16} /></button>
            </div>
          ))}
      </Section>
      <Toast message={toast.message} kind={toast.kind} onDone={clear} />
    </>
  );
}

// ------------ Invoices ------------
function InvoicesTab() {
  const [items, setItems] = useState([]);
  const [clients, setClients] = useState([]);
  const [number, setNumber] = useState("");
  const [clientId, setClientId] = useState("");
  const [desc, setDesc] = useState("");
  const [qty, setQty] = useState("1");
  const [price, setPrice] = useState("");
  const { toast, show, clear } = useToast();

  async function load() {
    const [a, b] = await Promise.all([api.get("/invoices"), api.get("/clients")]);
    setItems(a.data); setClients(b.data);
  }
  useEffect(() => { load(); }, []);

  async function add(e) {
    e.preventDefault();
    if (!number.trim()) return show("Invoice # required", "error");
    const cents = Math.round(parseFloat(price || "0") * 100);
    const lines = cents > 0 ? [{ description: desc, quantity: parseFloat(qty || "1"), unit_price_cents: cents }] : [];
    await api.post("/invoices", { invoice_number: number, client_id: clientId || null, lines });
    setNumber(""); setClientId(""); setDesc(""); setPrice(""); setQty("1"); load(); show("Invoice created", "success");
  }
  async function del(id) { await api.delete(`/invoices/${id}`); load(); }

  return (
    <>
      <Section title="New invoice">
        <form onSubmit={add} className="p-4">
          <Field label="Invoice #"><input data-testid="invoice-number" className="input" value={number} onChange={(e)=>setNumber(e.target.value)} placeholder="INV-001" /></Field>
          <Field label="Client">
            <select data-testid="invoice-client" className="input" value={clientId} onChange={(e)=>setClientId(e.target.value)}>
              <option value="">—</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.display_name}</option>)}
            </select>
          </Field>
          <Field label="Line description"><input data-testid="invoice-desc" className="input" value={desc} onChange={(e)=>setDesc(e.target.value)} /></Field>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <label className="block">
              <span className="label">Qty</span>
              <input data-testid="invoice-qty" className="input" type="number" step="0.01" value={qty} onChange={(e)=>setQty(e.target.value)} />
            </label>
            <label className="block">
              <span className="label">Unit price</span>
              <input data-testid="invoice-price" className="input" type="number" step="0.01" value={price} onChange={(e)=>setPrice(e.target.value)} placeholder="0.00" />
            </label>
          </div>
          <button data-testid="invoice-add-btn" className="btn btn-primary w-full"><Plus size={16} /> Save invoice</button>
        </form>
      </Section>
      <Section title={`Invoices (${items.length})`}>
        {items.length === 0 ? <p className="p-4 text-sm text-ink-tertiary">No invoices yet.</p> :
          items.map((i) => (
            <div key={i.id} className="row">
              <div className="min-w-0 flex-1">
                <p className="text-sm truncate font-semibold">{i.invoice_number}</p>
                <p className="text-xs text-ink-tertiary">{i.status} · {fmtDateShort(i.issued_at_utc)}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className="font-semibold">{fmtMoney(i.total_cents, i.currency)}</span>
                <button onClick={() => del(i.id)} className="btn btn-ghost p-2 text-ink-tertiary"><Trash2 size={16} /></button>
              </div>
            </div>
          ))}
      </Section>
      <Toast message={toast.message} kind={toast.kind} onDone={clear} />
    </>
  );
}

// ------------ Debts ------------
function DebtsTab() {
  const [items, setItems] = useState([]);
  const [amount, setAmount] = useState("");
  const [creditor, setCreditor] = useState("");
  const [desc, setDesc] = useState("");
  async function load() { const { data } = await api.get("/debts"); setItems(data); }
  useEffect(() => { load(); }, []);
  async function add(e) {
    e.preventDefault();
    const cents = Math.round(parseFloat(amount || "0") * 100);
    if (!cents) return;
    await api.post("/debts", { amount_cents: cents, creditor, description: desc });
    setAmount(""); setCreditor(""); setDesc(""); load();
  }
  async function del(id) { await api.delete(`/debts/${id}`); load(); }
  return (
    <>
      <Section title="Track a debt">
        <form onSubmit={add} className="p-4">
          <Field label="Amount"><input data-testid="debt-amount" className="input" type="number" step="0.01" value={amount} onChange={(e)=>setAmount(e.target.value)} placeholder="0.00" /></Field>
          <Field label="Creditor"><input data-testid="debt-creditor" className="input" value={creditor} onChange={(e)=>setCreditor(e.target.value)} placeholder="Bank / vendor" /></Field>
          <Field label="Description"><input data-testid="debt-desc" className="input" value={desc} onChange={(e)=>setDesc(e.target.value)} /></Field>
          <button data-testid="debt-add-btn" className="btn btn-primary w-full"><Plus size={16} /> Save debt</button>
        </form>
      </Section>
      <Section title={`Debts (${items.length})`}>
        {items.length === 0 ? <p className="p-4 text-sm text-ink-tertiary">No debts tracked.</p> :
          items.map((d) => (
            <div key={d.id} className="row">
              <div className="min-w-0 flex-1">
                <p className="text-sm truncate">{d.creditor || "Creditor"} · {d.description}</p>
                <p className="text-xs text-ink-tertiary">{d.status}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className="font-semibold text-expense">{fmtMoney(d.amount_cents, d.currency)}</span>
                <button onClick={() => del(d.id)} className="btn btn-ghost p-2 text-ink-tertiary"><Trash2 size={16} /></button>
              </div>
            </div>
          ))}
      </Section>
    </>
  );
}

// ------------ Funds (accounts) ------------
function FundsTab() {
  const [items, setItems] = useState([]);
  const [name, setName] = useState("");
  const [type, setType] = useState("cash");
  const [bal, setBal] = useState("");
  async function load() { const { data } = await api.get("/funds"); setItems(data); }
  useEffect(() => { load(); }, []);
  async function add(e) {
    e.preventDefault();
    if (!name.trim()) return;
    await api.post("/funds", { account_name: name, account_type: type, current_balance_cents: Math.round(parseFloat(bal||"0")*100) });
    setName(""); setBal(""); load();
  }
  async function del(id) { await api.delete(`/funds/${id}`); load(); }
  const total = useMemo(() => items.reduce((s,i)=> s + (i.current_balance_cents||0), 0), [items]);
  return (
    <>
      <Section title="Add account">
        <form onSubmit={add} className="p-4">
          <Field label="Account name"><input data-testid="fund-name" className="input" value={name} onChange={(e)=>setName(e.target.value)} /></Field>
          <Field label="Type">
            <select data-testid="fund-type" className="input" value={type} onChange={(e)=>setType(e.target.value)}>
              <option value="cash">Cash</option>
              <option value="bank">Bank</option>
              <option value="credit">Credit</option>
            </select>
          </Field>
          <Field label="Current balance"><input data-testid="fund-balance" className="input" type="number" step="0.01" value={bal} onChange={(e)=>setBal(e.target.value)} placeholder="0.00" /></Field>
          <button data-testid="fund-add-btn" className="btn btn-primary w-full"><Plus size={16} /> Save account</button>
        </form>
      </Section>
      <div className="card p-3 mb-3 flex justify-between">
        <span className="text-sm text-ink-secondary">Total available</span>
        <span className="font-heading font-bold text-brand">{fmtMoney(total)}</span>
      </div>
      <Section title={`Accounts (${items.length})`}>
        {items.length === 0 ? <p className="p-4 text-sm text-ink-tertiary">No accounts yet.</p> :
          items.map((f) => (
            <div key={f.id} className="row">
              <div className="min-w-0 flex-1">
                <p className="text-sm truncate">{f.account_name}</p>
                <p className="text-xs text-ink-tertiary">{f.account_type}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className="font-semibold">{fmtMoney(f.current_balance_cents, f.currency)}</span>
                <button onClick={() => del(f.id)} className="btn btn-ghost p-2 text-ink-tertiary"><Trash2 size={16} /></button>
              </div>
            </div>
          ))}
      </Section>
    </>
  );
}

// ------------ Scheduled (recurring) ------------
function ScheduledTab() {
  const [items, setItems] = useState([]);
  const [desc, setDesc] = useState("");
  const [amount, setAmount] = useState("");
  const [freq, setFreq] = useState("monthly");
  const [next, setNext] = useState("");
  async function load() { const { data } = await api.get("/scheduled-expenses"); setItems(data); }
  useEffect(() => { load(); }, []);
  async function add(e) {
    e.preventDefault();
    if (!desc.trim() || !amount || !next) return;
    await api.post("/scheduled-expenses", {
      description: desc, amount_cents: Math.round(parseFloat(amount)*100),
      frequency: freq, next_due_utc: new Date(next).toISOString(),
    });
    setDesc(""); setAmount(""); setNext(""); load();
  }
  async function del(id) { await api.delete(`/scheduled-expenses/${id}`); load(); }
  return (
    <>
      <Section title="Add recurring expense">
        <form onSubmit={add} className="p-4">
          <Field label="Description"><input data-testid="sched-desc" className="input" value={desc} onChange={(e)=>setDesc(e.target.value)} /></Field>
          <Field label="Amount"><input data-testid="sched-amount" className="input" type="number" step="0.01" value={amount} onChange={(e)=>setAmount(e.target.value)} /></Field>
          <Field label="Frequency">
            <select data-testid="sched-freq" className="input" value={freq} onChange={(e)=>setFreq(e.target.value)}>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="yearly">Yearly</option>
            </select>
          </Field>
          <Field label="Next due"><input data-testid="sched-next" className="input" type="datetime-local" value={next} onChange={(e)=>setNext(e.target.value)} /></Field>
          <button data-testid="sched-add-btn" className="btn btn-primary w-full"><Plus size={16} /> Save</button>
        </form>
      </Section>
      <Section title={`Scheduled (${items.length})`}>
        {items.length === 0 ? <p className="p-4 text-sm text-ink-tertiary">No scheduled expenses.</p> :
          items.map((s) => (
            <div key={s.id} className="row">
              <div className="min-w-0 flex-1">
                <p className="text-sm truncate">{s.description}</p>
                <p className="text-xs text-ink-tertiary">{s.frequency} · next {fmtDateShort(s.next_due_utc)}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className="font-semibold">{fmtMoney(s.amount_cents, s.currency)}</span>
                <button onClick={() => del(s.id)} className="btn btn-ghost p-2 text-ink-tertiary"><Trash2 size={16} /></button>
              </div>
            </div>
          ))}
      </Section>
    </>
  );
}

// ------------ Resources (owner contributions) ------------
function ResourcesTab() {
  const [items, setItems] = useState([]);
  const [amount, setAmount] = useState("");
  const [desc, setDesc] = useState("");
  const [src, setSrc] = useState("owner_contribution");
  async function load() { const { data } = await api.get("/resources"); setItems(data); }
  useEffect(() => { load(); }, []);
  async function add(e) {
    e.preventDefault();
    const cents = Math.round(parseFloat(amount || "0") * 100);
    if (!cents) return;
    await api.post("/resources", { amount_cents: cents, source_type: src, description: desc });
    setAmount(""); setDesc(""); load();
  }
  async function del(id) { await api.delete(`/resources/${id}`); load(); }
  return (
    <>
      <Section title="Add resource">
        <form onSubmit={add} className="p-4">
          <Field label="Amount"><input data-testid="resource-amount" className="input" type="number" step="0.01" value={amount} onChange={(e)=>setAmount(e.target.value)} /></Field>
          <Field label="Source">
            <select data-testid="resource-source" className="input" value={src} onChange={(e)=>setSrc(e.target.value)}>
              <option value="owner_contribution">Owner contribution</option>
              <option value="grant">Grant</option>
              <option value="other">Other</option>
            </select>
          </Field>
          <Field label="Description"><input data-testid="resource-desc" className="input" value={desc} onChange={(e)=>setDesc(e.target.value)} /></Field>
          <button data-testid="resource-add-btn" className="btn btn-primary w-full"><Plus size={16} /> Save</button>
        </form>
      </Section>
      <Section title={`Resources (${items.length})`}>
        {items.length === 0 ? <p className="p-4 text-sm text-ink-tertiary">Nothing here yet.</p> :
          items.map((r) => (
            <div key={r.id} className="row">
              <div className="min-w-0 flex-1">
                <p className="text-sm truncate">{r.description || r.source_type}</p>
                <p className="text-xs text-ink-tertiary">{r.source_type} · {fmtDateShort(r.at_utc)}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className="font-semibold text-income">{fmtMoney(r.amount_cents, r.currency)}</span>
                <button onClick={() => del(r.id)} className="btn btn-ghost p-2 text-ink-tertiary"><Trash2 size={16} /></button>
              </div>
            </div>
          ))}
      </Section>
    </>
  );
}

// ------------ Tax estimator ------------
function TaxTab() {
  const [rate, setRate] = useState("25");
  const [data, setData] = useState(null);
  useEffect(() => {
    (async () => {
      const start = new Date(new Date().getFullYear(), 0, 1).toISOString();
      const end = new Date().toISOString();
      const { data } = await api.get("/dashboard/summary", { params: { start, end } });
      setData(data);
    })();
  }, []);
  const taxable = data ? Math.max(0, data.income_cents - data.expense_cents) : 0;
  const owed = Math.round(taxable * (parseFloat(rate || "0") / 100));
  return (
    <>
      <Section title="Quick tax estimate (year-to-date)">
        <div className="p-4">
          <Field label="Tax rate (%)">
            <input data-testid="tax-rate" className="input" type="number" step="0.1" value={rate} onChange={(e)=>setRate(e.target.value)} />
          </Field>
          <div className="grid grid-cols-2 gap-2 mt-2">
            <Mini label="Income YTD" value={fmtMoney(data?.income_cents || 0)} />
            <Mini label="Expenses YTD" value={fmtMoney(data?.expense_cents || 0)} />
            <Mini label="Taxable (Net)" value={fmtMoney(taxable)} />
            <Mini label="Estimated tax" value={fmtMoney(owed)} accent="warn" />
          </div>
          <p className="text-xs text-ink-tertiary mt-3">Estimate only. Talk to a tax pro for filing.</p>
        </div>
      </Section>
    </>
  );
}

function Mini({ label, value, accent }) {
  const c = accent === "warn" ? "text-warn" : "text-ink-primary";
  return (
    <div className="card p-3">
      <p className="text-[10px] uppercase tracking-widest text-ink-tertiary">{label}</p>
      <p className={`font-heading text-lg font-bold ${c}`}>{value}</p>
    </div>
  );
}
