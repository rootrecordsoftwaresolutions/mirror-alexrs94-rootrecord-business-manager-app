const { contextBridge, ipcRenderer } = require('electron');

/** If this fails (packaged path / ASAR / prune), preload must still expose `rootRecord` or the app cannot sign in. */
let JsPdf = null;
try {
  const jspdfMod = require('jspdf');
  JsPdf = jspdfMod.jsPDF;
  const jspdfAutotable = require('jspdf-autotable');
  if (jspdfAutotable && typeof jspdfAutotable.applyPlugin === 'function' && JsPdf) {
    jspdfAutotable.applyPlugin(JsPdf);
  }
} catch (e) {
  console.error('[preload] jsPDF / jspdf-autotable failed to load; PDF export disabled.', e);
}

/** @param {number} c */
function fmtMoney(c) {
  return ((Number(c) || 0) / 100).toFixed(2);
}

/**
 * Build a printable PDF from plain JSON (runs in preload so jsPDF is available).
 * @param {{ title?: string, generatedAt: string, sections: Array<Record<string, unknown>> }} payload
 * @returns {string} base64 (no data: prefix)
 */
function buildDashboardSummaryPdfBase64(payload) {
  if (!JsPdf) {
    throw new Error(
      'PDF export library failed to load. Restart the app or reinstall; sign-in and other features still work without PDF.'
    );
  }
  const title = (payload && payload.title) || 'Root Record — dashboard summary';
  const generatedAt = (payload && payload.generatedAt) || '';
  const sections = Array.isArray(payload && payload.sections) ? payload.sections : [];

  const doc = new JsPdf({ unit: 'pt', format: 'letter', orientation: 'portrait' });
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 48;
  let y = margin;

  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.text(title, margin, y);
  y += 22;
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  if (generatedAt) {
    doc.text(`Generated: ${generatedAt}`, margin, y);
    y += 16;
  }
  doc.text('Each section uses the same Combined window as the Dashboard for that time scale.', margin, y);
  y += 22;

  for (const sec of sections) {
    const scale = String(sec.scale || '');
    const windowLabel = String(sec.windowLabel || '');
    const scopeLabel = String(sec.scopeLabel || '');
    const comparePrevLabel = String(sec.comparePrevLabel || '');
    const sum = sec.summary || {};
    const prev = sec.previousSummary || {};
    const bdMode = String(sec.breakdownMode || 'Category');
    const col1 = bdMode === 'Project' ? 'Project' : 'Category';
    const breakdown = Array.isArray(sec.breakdown) ? sec.breakdown : [];
    const moneyBy = sec.moneyByCurrency && typeof sec.moneyByCurrency === 'object' ? sec.moneyByCurrency : {};
    const funds = sec.availableFundsTotals && typeof sec.availableFundsTotals === 'object' ? sec.availableFundsTotals : null;

    const hours = ((Number(sum.seconds_worked_approx) || 0) / 3600).toFixed(2);
    const inc = fmtMoney(sum.income_cents);
    const exp = fmtMoney(sum.expense_cents);
    const net = fmtMoney((Number(sum.income_cents) || 0) - (Number(sum.expense_cents) || 0));

    const ph = ((Number(prev.seconds_worked_approx) || 0) / 3600).toFixed(2);
    const pn = fmtMoney((Number(prev.income_cents) || 0) - (Number(prev.expense_cents) || 0));

    if (y > doc.internal.pageSize.getHeight() - 120) {
      doc.addPage();
      y = margin;
    }

    doc.setFontSize(13);
    doc.setFont('helvetica', 'bold');
    doc.text(scale, margin, y);
    y += 18;
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    const winLines = doc.splitTextToSize(`Window: ${windowLabel}`, pageW - margin * 2);
    doc.text(winLines, margin, y);
    y += winLines.length * 12 + 4;
    if (scopeLabel && scopeLabel !== windowLabel) {
      const scLines = doc.splitTextToSize(`Scope: ${scopeLabel}`, pageW - margin * 2);
      doc.text(scLines, margin, y);
      y += scLines.length * 12 + 4;
    }

    doc.autoTable({
      startY: y,
      margin: { left: margin, right: margin },
      head: [['Metric', 'Value']],
      body: [
        ['Hours worked', `${hours} h`],
        ['Income', inc],
        ['Expenses', exp],
        ['Net', net]
      ],
      styles: { fontSize: 9, cellPadding: 4 },
      headStyles: { fillColor: [55, 58, 70] }
    });
    y = doc.lastAutoTable.finalY + 12;

    const cmpLine = `${comparePrevLabel}: ${ph} h · net ${pn} (comparison period)`;
    const cmpLines = doc.splitTextToSize(cmpLine, pageW - margin * 2);
    doc.text(cmpLines, margin, y);
    y += cmpLines.length * 12 + 10;

    const moneyRows = Object.keys(moneyBy).map((ccy) => {
      const v = moneyBy[ccy] || {};
      return [
        ccy,
        fmtMoney(v.income_cents),
        fmtMoney(v.expense_cents),
        fmtMoney((Number(v.income_cents) || 0) - (Number(v.expense_cents) || 0))
      ];
    });
    if (moneyRows.length) {
      doc.setFont('helvetica', 'bold');
      doc.text('Period money by currency', margin, y);
      y += 12;
      doc.setFont('helvetica', 'normal');
      doc.autoTable({
        startY: y,
        margin: { left: margin, right: margin },
        head: [['Currency', 'Income', 'Expenses', 'Net']],
        body: moneyRows,
        styles: { fontSize: 9, cellPadding: 4 },
        headStyles: { fillColor: [55, 58, 70] }
      });
      y = doc.lastAutoTable.finalY + 14;
    }

    if (funds && Object.keys(funds).length) {
      const fundRows = Object.keys(funds).map((ccy) => {
        const b = funds[ccy] || {};
        return [ccy, fmtMoney(b.available_cents), fmtMoney(b.balance_cents)];
      });
      doc.setFont('helvetica', 'bold');
      doc.text('Available funds (current)', margin, y);
      y += 12;
      doc.setFont('helvetica', 'normal');
      doc.autoTable({
        startY: y,
        margin: { left: margin, right: margin },
        head: [['Currency', 'Available', 'Balance']],
        body: fundRows,
        styles: { fontSize: 9, cellPadding: 4 },
        headStyles: { fillColor: [55, 58, 70] }
      });
      y = doc.lastAutoTable.finalY + 14;
    }

    const bdRows = breakdown.map((r) => {
      const name = String(r.task_name != null ? r.task_name : '');
      const hrs = ((Number(r.seconds_total) || 0) / 3600).toFixed(2);
      const pct = (Number(r.percent_of_day) != null ? Number(r.percent_of_day) : 0).toFixed(1);
      return [name, `${hrs} h`, `${pct}%`];
    });
    doc.setFont('helvetica', 'bold');
    doc.text(`Time breakdown (${col1})`, margin, y);
    y += 12;
    doc.setFont('helvetica', 'normal');
    if (bdRows.length) {
      doc.autoTable({
        startY: y,
        margin: { left: margin, right: margin },
        head: [[col1, 'Hours', '% of tracked']],
        body: bdRows,
        styles: { fontSize: 9, cellPadding: 3 },
        headStyles: { fillColor: [55, 58, 70] }
      });
      y = doc.lastAutoTable.finalY + 24;
    } else {
      doc.text('No tracked time in this window.', margin, y);
      y += 28;
    }
  }

  const dataUri = doc.output('datauristring');
  const i = dataUri.indexOf(',');
  return i >= 0 ? dataUri.slice(i + 1) : dataUri;
}

contextBridge.exposeInMainWorld('rootRecord', {
  bootstrap() {
    return ipcRenderer.invoke('rr-bootstrap');
  },
  api(method, payload) {
    return ipcRenderer.invoke('rr-api', { method, payload });
  },
  openPath(p) {
    return ipcRenderer.invoke('shell-open-path', p);
  },
  openExternalUrl(url) {
    return ipcRenderer.invoke('shell-open-external', url);
  },
  submitFeedback(payload) {
    return ipcRenderer.invoke('rr-feedback-submit', payload || {});
  },
  resetAllLocalData(payload) {
    return ipcRenderer.invoke('rr-reset-all-local-data', payload || {});
  },
  deleteCloudSyncData(payload) {
    return ipcRenderer.invoke('rr-delete-cloud-sync-data', payload || {});
  },
  licensePrepare(payload) {
    return ipcRenderer.invoke('license-prepare', payload || {});
  },
  licenseLogin(payload) {
    return ipcRenderer.invoke('license-login', payload || {});
  },
  licenseSignup(payload) {
    return ipcRenderer.invoke('license-signup', payload || {});
  },
  licenseLogout() {
    return ipcRenderer.invoke('license-logout');
  },
  syncRun() {
    return ipcRenderer.invoke('rr-sync-run');
  },
  syncReuploadHistory() {
    return ipcRenderer.invoke('rr-sync-reupload-history');
  },
  buildDashboardSummaryPdfBase64(payload) {
    return buildDashboardSummaryPdfBase64(payload || {});
  }
});
