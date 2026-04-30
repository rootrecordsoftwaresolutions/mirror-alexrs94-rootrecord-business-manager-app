'use strict';

const { run, get, all } = require('./sqliteUtil');
const { nowUtcIsoText } = require('./migrate');
const { parseSettingBool } = require('./settingBool');

async function assertSuiteBusinessRow(ctx, table, id) {
  const bid = ctx.requireWritable();
  const row = await get(ctx.db, `SELECT business_id FROM ${table} WHERE id = ? AND user_id = ?`, [id, ctx.userId]);
  if (!row) throw new Error('Record not found.');
  const multi = parseSettingBool(await ctx.settingsGet('multi_business_enabled', false));
  if (!multi) return bid;
  const raw = row.business_id;
  const rBid = raw != null && raw !== '' ? parseInt(String(raw), 10) : NaN;
  const effective = Number.isFinite(rBid) && rBid > 0 ? rBid : 1;
  if (effective !== bid) throw new Error('That record belongs to another business.');
  return bid;
}

async function recalculateInvoiceTotals(ctx, invoiceId) {
  const row = await get(ctx.db, 'SELECT tax_cents FROM invoices WHERE id = ?', [invoiceId]);
  const tax = parseInt(row && row.tax_cents != null ? row.tax_cents : 0, 10);
  const srow = await get(ctx.db, 'SELECT COALESCE(SUM(line_total_cents), 0) AS s FROM invoice_lines WHERE invoice_id = ?', [
    invoiceId
  ]);
  const sub = parseInt(srow && srow.s != null ? srow.s : 0, 10);
  const total = sub + tax;
  await run(ctx.db, 'UPDATE invoices SET subtotal_cents = ?, total_cents = ?, updated_at = ? WHERE id = ? AND user_id = ?', [
    sub,
    total,
    nowUtcIsoText(),
    invoiceId,
    ctx.userId
  ]);
}

async function nextInvoiceNumber(ctx) {
  const row = await get(ctx.db, 'SELECT invoice_number FROM invoices WHERE user_id = ? ORDER BY id DESC LIMIT 1', [
    ctx.userId
  ]);
  if (!row || !row.invoice_number) {
    return `INV-${new Date().getFullYear()}-001`;
  }
  const last = String(row.invoice_number);
  const m = last.match(/(\d+)$/);
  if (m) {
    const n = parseInt(m[1], 10) + 1;
    const prefix = last.slice(0, m.index);
    return `${prefix}${String(n).padStart(3, '0')}`;
  }
  return `${last}-2`;
}

module.exports = {
  saveClient: async (ctx, p) => {
    const bid = ctx.requireWritable();
    const now = nowUtcIsoText();
    const name = String(p.display_name || '').trim();
    if (!name) throw new Error('Name required');
    if (p.client_id) {
      await run(
        ctx.db,
        `UPDATE clients SET display_name=?, company=?, email=?, phone=?, address=?, website=?,
         tax_id=?, notes=?, updated_at=? WHERE id = ? AND user_id = ?`,
        [
          name,
          String(p.company || '').trim(),
          String(p.email || '').trim(),
          String(p.phone || '').trim(),
          String(p.address || '').trim(),
          String(p.website || '').trim(),
          String(p.tax_id || '').trim(),
          String(p.notes || '').trim(),
          now,
          p.client_id,
          ctx.userId
        ]
      );
      return { id: p.client_id };
    }
    const r = await run(
      ctx.db,
      `INSERT INTO clients (user_id, business_id, display_name, company, email, phone, address, website, tax_id, notes, sort_order, archived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 999, 0, ?, ?)`,
      [
        ctx.userId,
        bid,
        name,
        String(p.company || '').trim(),
        String(p.email || '').trim(),
        String(p.phone || '').trim(),
        String(p.address || '').trim(),
        String(p.website || '').trim(),
        String(p.tax_id || '').trim(),
        String(p.notes || '').trim(),
        now,
        now
      ]
    );
    return { id: r.lastID };
  },
  archiveClient: async (ctx, p) => {
    ctx.requireWritable();
    await run(ctx.db, 'UPDATE clients SET archived = 1, updated_at = ? WHERE id = ? AND user_id = ?', [
      nowUtcIsoText(),
      p.client_id,
      ctx.userId
    ]);
    return { ok: true };
  },
  saveScheduleEvent: async (ctx, p) => {
    const bid = ctx.requireWritable();
    const now = nowUtcIsoText();
    const tit = String(p.title || '').trim();
    if (!tit) throw new Error('Title required');
    if (p.event_id) {
      const prevEv = await get(ctx.db, 'SELECT all_day, location FROM schedule_events WHERE id=? AND user_id=?', [
        p.event_id,
        ctx.userId
      ]);
      const allDay =
        p.all_day != null ? parseInt(String(p.all_day), 10) || 0 : prevEv ? parseInt(String(prevEv.all_day ?? 0), 10) || 0 : 0;
      const loc =
        p.location !== undefined
          ? String(p.location || '').trim()
          : prevEv && prevEv.location != null
            ? String(prevEv.location).trim()
            : '';
      await run(
        ctx.db,
        `UPDATE schedule_events SET title=?, starts_at_utc=?, ends_at_utc=?, all_day=?, client_id=?, project_id=?,
         location=?, notes=?, status=?, updated_at=? WHERE id = ? AND user_id = ?`,
        [
          tit,
          p.starts_at_utc,
          p.ends_at_utc ?? null,
          allDay,
          p.client_id ?? null,
          p.project_id ?? null,
          loc,
          String(p.notes || '').trim(),
          String(p.status || 'scheduled'),
          now,
          p.event_id,
          ctx.userId
        ]
      );
      return { id: p.event_id };
    }
    const r = await run(
      ctx.db,
      `INSERT INTO schedule_events (user_id, business_id, title, starts_at_utc, ends_at_utc, all_day, client_id, project_id,
        location, notes, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ctx.userId,
        bid,
        tit,
        p.starts_at_utc,
        p.ends_at_utc ?? null,
        p.all_day != null ? p.all_day : 0,
        p.client_id ?? null,
        p.project_id ?? null,
        String(p.location || '').trim(),
        String(p.notes || '').trim(),
        String(p.status || 'scheduled'),
        now,
        now
      ]
    );
    return { id: r.lastID };
  },
  deleteScheduleEvent: async (ctx, p) => {
    ctx.requireWritable();
    await run(ctx.db, 'DELETE FROM schedule_events WHERE id = ? AND user_id = ?', [p.event_id, ctx.userId]);
    return { ok: true };
  },
  listScheduleBetween: async (ctx, p) => {
    const bf = ctx.businessFragment('e');
    return all(
      ctx.db,
      `SELECT e.id, e.title, e.starts_at_utc, e.ends_at_utc, e.all_day, e.client_id, e.project_id, e.location, e.notes, e.status,
              c.display_name AS client_name, p.name AS project_name
       FROM schedule_events e
       LEFT JOIN clients c ON c.id = e.client_id
       LEFT JOIN projects p ON p.id = e.project_id
       WHERE e.user_id = ? AND e.starts_at_utc >= ? AND e.starts_at_utc < ? ${bf.sql}
       ORDER BY e.starts_at_utc ASC`,
      [ctx.userId, p.startUtc, p.endUtc, ...bf.params]
    );
  },
  saveStockProduct: async (ctx, p) => {
    const bid = ctx.requireWritable();
    const now = nowUtcIsoText();
    if (p.product_id) {
      await run(
        ctx.db,
        `UPDATE stock_products SET name=?, sku=?, description=?, unit=?, qty_on_hand=?, reorder_level=?,
         unit_cost_cents=?, unit_price_cents=?, currency=?, notes=?, archived=?, updated_at=?
         WHERE id = ? AND user_id = ?`,
        [
          String(p.name || ''),
          p.sku ?? null,
          p.description ?? null,
          String(p.unit || 'ea'),
          parseFloat(p.qty_on_hand) || 0,
          parseFloat(p.reorder_level) || 0,
          p.unit_cost_cents ?? null,
          p.unit_price_cents ?? null,
          String(p.currency || 'USD'),
          String(p.notes || '').trim(),
          p.archived ? 1 : 0,
          now,
          p.product_id,
          ctx.userId
        ]
      );
      return { id: p.product_id };
    }
    const r = await run(
      ctx.db,
      `INSERT INTO stock_products (user_id, business_id, name, sku, description, unit, qty_on_hand, reorder_level,
        unit_cost_cents, unit_price_cents, currency, notes, sort_order, archived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 999, 0, ?, ?)`,
      [
        ctx.userId,
        bid,
        String(p.name || ''),
        p.sku ?? null,
        p.description ?? null,
        String(p.unit || 'ea'),
        parseFloat(p.qty_on_hand) || 0,
        parseFloat(p.reorder_level) || 0,
        p.unit_cost_cents ?? null,
        p.unit_price_cents ?? null,
        String(p.currency || 'USD'),
        String(p.notes || '').trim(),
        now,
        now
      ]
    );
    return { id: r.lastID };
  },
  adjustStockQty: async (ctx, p) => {
    ctx.requireWritable();
    await run(ctx.db, 'UPDATE stock_products SET qty_on_hand = qty_on_hand + ?, updated_at = ? WHERE id = ? AND user_id = ?', [
      parseFloat(p.delta) || 0,
      nowUtcIsoText(),
      p.product_id,
      ctx.userId
    ]);
    const row = await get(ctx.db, 'SELECT qty_on_hand FROM stock_products WHERE id = ?', [p.product_id]);
    return { qty_on_hand: row ? row.qty_on_hand : null };
  },
  saveSupply: async (ctx, p) => {
    const bid = ctx.requireWritable();
    const now = nowUtcIsoText();
    if (p.supply_id) {
      await run(
        ctx.db,
        `UPDATE supplies SET name=?, category=?, unit=?, qty_on_hand=?, reorder_level=?, vendor=?, notes=?, archived=?, updated_at=?
         WHERE id = ? AND user_id = ?`,
        [
          String(p.name || ''),
          p.category ?? null,
          String(p.unit || 'ea'),
          parseFloat(p.qty_on_hand) || 0,
          parseFloat(p.reorder_level) || 0,
          p.vendor ?? null,
          String(p.notes || '').trim(),
          p.archived ? 1 : 0,
          now,
          p.supply_id,
          ctx.userId
        ]
      );
      return { id: p.supply_id };
    }
    const r = await run(
      ctx.db,
      `INSERT INTO supplies (user_id, business_id, name, category, unit, qty_on_hand, reorder_level, vendor, notes, sort_order, archived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 999, 0, ?, ?)`,
      [
        ctx.userId,
        bid,
        String(p.name || ''),
        p.category ?? null,
        String(p.unit || 'ea'),
        parseFloat(p.qty_on_hand) || 0,
        parseFloat(p.reorder_level) || 0,
        p.vendor ?? null,
        String(p.notes || '').trim(),
        now,
        now
      ]
    );
    return { id: r.lastID };
  },
  adjustSupplyQty: async (ctx, p) => {
    ctx.requireWritable();
    await run(ctx.db, 'UPDATE supplies SET qty_on_hand = qty_on_hand + ?, updated_at = ? WHERE id = ? AND user_id = ?', [
      parseFloat(p.delta) || 0,
      nowUtcIsoText(),
      p.supply_id,
      ctx.userId
    ]);
    const row = await get(ctx.db, 'SELECT qty_on_hand FROM supplies WHERE id = ?', [p.supply_id]);
    return { qty_on_hand: row ? row.qty_on_hand : null };
  },
  insertDebt: async (ctx, p) => {
    const bid = ctx.requireWritable();
    const r = await run(
      ctx.db,
      `INSERT INTO debt_entries (user_id, business_id, created_at_utc, due_at_utc, amount_cents, currency, creditor, description, status, debt_type, account_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      [
        ctx.userId,
        bid,
        p.created_at_utc,
        p.due_at_utc ?? null,
        parseInt(p.amount_cents, 10),
        String(p.currency || 'USD'),
        String(p.creditor || '').trim(),
        String(p.description || ''),
        String(p.debt_type || 'loan'),
        String(p.account_ref || '')
      ]
    );
    return { id: r.lastID };
  },
  setDebtStatus: async (ctx, p) => {
    ctx.requireWritable();
    await run(ctx.db, 'UPDATE debt_entries SET status = ? WHERE id = ? AND user_id = ?', [
      String(p.status || 'open'),
      p.debt_id,
      ctx.userId
    ]);
    return { ok: true };
  },
  insertResourceEntry: async (ctx, p) => {
    const bid = ctx.requireWritable();
    const r = await run(
      ctx.db,
      `INSERT INTO resource_entries (user_id, business_id, at_utc, amount_cents, currency, source_type, description, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ctx.userId,
        bid,
        p.at_utc,
        parseInt(p.amount_cents, 10),
        String(p.currency || 'USD'),
        String(p.source_type || 'owner_contribution'),
        String(p.description || ''),
        nowUtcIsoText()
      ]
    );
    return { id: r.lastID };
  },
  upsertAvailableFundsAccount: async (ctx, p) => {
    const bid = ctx.requireWritable();
    const now = nowUtcIsoText();
    if (p.account_id) {
      await run(
        ctx.db,
        `UPDATE available_funds_accounts SET account_name=?, account_type=?, currency=?, current_balance_cents=?,
         credit_limit_cents=?, notes=?, archived=?, updated_at=? WHERE id = ? AND user_id = ? AND COALESCE(business_id,1)=?`,
        [
          String(p.account_name || ''),
          String(p.account_type || 'cash'),
          String(p.currency || 'USD'),
          parseInt(p.current_balance_cents, 10) || 0,
          parseInt(p.credit_limit_cents, 10) || 0,
          String(p.notes || '').trim(),
          p.archived ? 1 : 0,
          now,
          p.account_id,
          ctx.userId,
          bid
        ]
      );
      return { id: p.account_id };
    }
    const r = await run(
      ctx.db,
      `INSERT INTO available_funds_accounts (user_id, business_id, account_name, account_type, currency, current_balance_cents, credit_limit_cents, notes, archived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        ctx.userId,
        bid,
        String(p.account_name || ''),
        String(p.account_type || 'cash'),
        String(p.currency || 'USD'),
        parseInt(p.current_balance_cents, 10) || 0,
        parseInt(p.credit_limit_cents, 10) || 0,
        String(p.notes || '').trim(),
        now,
        now
      ]
    );
    return { id: r.lastID };
  },
  addScheduledExpense: async (ctx, p) => {
    const bid = ctx.requireWritable();
    const now = nowUtcIsoText();
    const r = await run(
      ctx.db,
      `INSERT INTO scheduled_expenses (user_id, business_id, description, amount_cents, currency, frequency, next_due_utc,
        project_id, work_category_id, merchant, billable, notes, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [
        ctx.userId,
        bid,
        String(p.description || ''),
        parseInt(p.amount_cents, 10),
        String(p.currency || 'USD'),
        String(p.frequency || 'monthly'),
        p.next_due_utc,
        p.project_id ?? null,
        p.work_category_id ?? null,
        p.merchant ?? null,
        p.billable != null ? p.billable : 1,
        p.notes ?? null,
        now,
        now
      ]
    );
    return { id: r.lastID };
  },
  createInvoice: async (ctx, p) => {
    const bid = ctx.requireWritable();
    const now = nowUtcIsoText();
    let num = (p.invoice_number || '').trim();
    if (!num) num = await nextInvoiceNumber(ctx);
    const r = await run(
      ctx.db,
      `INSERT INTO invoices (user_id, business_id, client_id, invoice_number, status, issued_at_utc, due_at_utc,
        currency, subtotal_cents, tax_cents, total_cents, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?, ?)`,
      [
        ctx.userId,
        bid,
        p.client_id ?? null,
        num,
        String(p.status || 'draft'),
        p.issued_at_utc,
        p.due_at_utc ?? null,
        String(p.currency || 'USD'),
        parseInt(p.tax_cents, 10) || 0,
        String(p.notes || '').trim(),
        now,
        now
      ]
    );
    const iid = r.lastID;
    await run(
      ctx.db,
      `INSERT INTO invoice_lines (invoice_id, sort_order, description, quantity, unit_price_cents, line_total_cents) VALUES (?, 0, 'Service', 1, 0, 0)`,
      [iid]
    );
    await recalculateInvoiceTotals(ctx, iid);
    return { id: iid, invoice_number: num };
  },
  saveInvoiceLine: async (ctx, p) => {
    ctx.requireWritable();
    const qty = parseFloat(p.quantity) || 1;
    const unit = parseInt(p.unit_price_cents, 10) || 0;
    const lineTotal = Math.round(qty * unit);
    const desc = String(p.description || '').trim() || 'Item';
    if (p.line_id) {
      await run(
        ctx.db,
        `UPDATE invoice_lines SET description=?, quantity=?, unit_price_cents=?, line_total_cents=? WHERE id = ? AND invoice_id = ?`,
        [desc, qty, unit, lineTotal, p.line_id, p.invoice_id]
      );
      await recalculateInvoiceTotals(ctx, p.invoice_id);
      return { id: p.line_id };
    }
    const mx = await get(ctx.db, 'SELECT COALESCE(MAX(sort_order), -1) + 1 AS so FROM invoice_lines WHERE invoice_id = ?', [
      p.invoice_id
    ]);
    const so = mx ? mx.so : 0;
    const r = await run(
      ctx.db,
      `INSERT INTO invoice_lines (invoice_id, sort_order, description, quantity, unit_price_cents, line_total_cents) VALUES (?, ?, ?, ?, ?, ?)`,
      [p.invoice_id, so, desc, qty, unit, lineTotal]
    );
    await recalculateInvoiceTotals(ctx, p.invoice_id);
    return { id: r.lastID };
  },
  deleteInvoiceLine: async (ctx, p) => {
    ctx.requireWritable();
    await run(ctx.db, 'DELETE FROM invoice_lines WHERE id = ? AND invoice_id = ?', [p.line_id, p.invoice_id]);
    await recalculateInvoiceTotals(ctx, p.invoice_id);
    return { ok: true };
  },
  deleteInvoice: async (ctx, p) => {
    ctx.requireWritable();
    await run(ctx.db, 'DELETE FROM invoices WHERE id = ? AND user_id = ?', [p.invoice_id, ctx.userId]);
    return { ok: true };
  },
  listInvoiceLines: async (ctx, p) =>
    all(
      ctx.db,
      'SELECT id, sort_order, description, quantity, unit_price_cents, line_total_cents FROM invoice_lines WHERE invoice_id = ? ORDER BY sort_order, id',
      [p.invoice_id]
    ),
  getInvoice: async (ctx, p) =>
    get(
      ctx.db,
      `SELECT i.id, i.client_id, i.invoice_number, i.status, i.issued_at_utc, i.due_at_utc, i.currency,
        i.subtotal_cents, i.tax_cents, i.total_cents, i.notes, c.display_name AS client_name
       FROM invoices i LEFT JOIN clients c ON c.id = i.client_id WHERE i.id = ? AND i.user_id = ?`,
      [p.invoice_id, ctx.userId]
    ),
  updateDebtEntry: async (ctx, p) => {
    const id = parseInt(p.debt_id, 10);
    if (!Number.isFinite(id)) throw new Error('Invalid debt id.');
    await assertSuiteBusinessRow(ctx, 'debt_entries', id);
    await run(
      ctx.db,
      `UPDATE debt_entries SET created_at_utc=?, due_at_utc=?, amount_cents=?, currency=?, creditor=?, description=?,
       status=?, debt_type=?, account_ref=? WHERE id=? AND user_id=?`,
      [
        String(p.created_at_utc),
        p.due_at_utc ?? null,
        parseInt(p.amount_cents, 10),
        String(p.currency || 'USD'),
        String(p.creditor || '').trim(),
        String(p.description || ''),
        String(p.status || 'open'),
        String(p.debt_type || 'loan'),
        String(p.account_ref || ''),
        id,
        ctx.userId
      ]
    );
    return { ok: true };
  },
  deleteDebtEntry: async (ctx, p) => {
    const id = parseInt(p.debt_id, 10);
    if (!Number.isFinite(id)) throw new Error('Invalid debt id.');
    await assertSuiteBusinessRow(ctx, 'debt_entries', id);
    await run(ctx.db, 'DELETE FROM debt_entries WHERE id = ? AND user_id = ?', [id, ctx.userId]);
    return { ok: true };
  },
  updateResourceEntry: async (ctx, p) => {
    const id = parseInt(p.id, 10);
    if (!Number.isFinite(id)) throw new Error('Invalid resource entry id.');
    await assertSuiteBusinessRow(ctx, 'resource_entries', id);
    await run(
      ctx.db,
      `UPDATE resource_entries SET at_utc=?, amount_cents=?, currency=?, source_type=?, description=? WHERE id=? AND user_id=?`,
      [
        String(p.at_utc),
        parseInt(p.amount_cents, 10),
        String(p.currency || 'USD'),
        String(p.source_type || 'owner_contribution'),
        String(p.description || ''),
        id,
        ctx.userId
      ]
    );
    return { ok: true };
  },
  deleteResourceEntry: async (ctx, p) => {
    const id = parseInt(p.id, 10);
    if (!Number.isFinite(id)) throw new Error('Invalid resource entry id.');
    await assertSuiteBusinessRow(ctx, 'resource_entries', id);
    await run(ctx.db, 'DELETE FROM resource_entries WHERE id = ? AND user_id = ?', [id, ctx.userId]);
    return { ok: true };
  },
  updateScheduledExpense: async (ctx, p) => {
    const id = parseInt(p.scheduled_id, 10);
    if (!Number.isFinite(id)) throw new Error('Invalid scheduled expense id.');
    await assertSuiteBusinessRow(ctx, 'scheduled_expenses', id);
    const prev = await get(ctx.db, 'SELECT merchant FROM scheduled_expenses WHERE id=? AND user_id=?', [id, ctx.userId]);
    const merchantKeep = prev ? prev.merchant : null;
    const now = nowUtcIsoText();
    await run(
      ctx.db,
      `UPDATE scheduled_expenses SET description=?, amount_cents=?, currency=?, frequency=?, next_due_utc=?,
       project_id=?, work_category_id=?, merchant=?, billable=?, notes=?, active=?, updated_at=?
       WHERE id=? AND user_id=?`,
      [
        String(p.description || ''),
        parseInt(p.amount_cents, 10),
        String(p.currency || 'USD'),
        String(p.frequency || 'monthly'),
        String(p.next_due_utc),
        p.project_id ?? null,
        p.work_category_id ?? null,
        p.merchant !== undefined ? p.merchant : merchantKeep,
        p.billable != null ? parseInt(String(p.billable), 10) || 1 : 1,
        p.notes !== undefined ? p.notes : null,
        p.active != null ? parseInt(String(p.active), 10) : 1,
        now,
        id,
        ctx.userId
      ]
    );
    return { ok: true };
  },
  deleteScheduledExpense: async (ctx, p) => {
    const id = parseInt(p.scheduled_id, 10);
    if (!Number.isFinite(id)) throw new Error('Invalid scheduled expense id.');
    await assertSuiteBusinessRow(ctx, 'scheduled_expenses', id);
    await run(ctx.db, 'DELETE FROM scheduled_expenses WHERE id = ? AND user_id = ?', [id, ctx.userId]);
    return { ok: true };
  }
};
