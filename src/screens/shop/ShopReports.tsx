import React, { useMemo, useState } from 'react';
import { useShopMode } from '../../context/ShopModeContext';
import { db } from '../../lib/firebase';
import { collection, query, orderBy, limit } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { clsx } from 'clsx';
import { todayLocalDateString } from '../../lib/dateUtils';
import { shareOrDownloadFile } from '../../lib/fileShare';

type ReportTab = 'monthly' | 'item' | 'category';
type PeriodType = 'month' | 'quarter';

function quarterOf(dateStr: string): number {
  return Math.ceil(parseInt(dateStr.slice(5, 7), 10) / 3);
}

function csvEscape(val: any): string {
  return `"${String(val ?? '').replace(/"/g, '""')}"`;
}

interface Row {
  key: string;
  revenue: number;
  cost: number;
  count: number;
  costKnownCount: number;
}

// Cost/profit are only ever computed from sales that actually have a cost set (costPending ==
// false) — a sale still waiting on its cost shouldn't silently count as zero-cost (100% margin)
// in these numbers, which would make profit look inflated until the shopkeeper fills it in.
function aggregate(sales: any[], keyFn: (s: any) => string): Row[] {
  const map = new Map<string, Row>();
  sales.forEach((s) => {
    const key = keyFn(s);
    const row = map.get(key) || { key, revenue: 0, cost: 0, count: 0, costKnownCount: 0 };
    row.revenue += s.price || 0;
    row.count += 1;
    if (!s.costPending && s.cost != null) {
      row.cost += s.cost;
      row.costKnownCount += 1;
    }
    map.set(key, row);
  });
  return Array.from(map.values()).sort((a, b) => b.revenue - a.revenue);
}

export default function ShopReports() {
  const { shopId } = useShopMode();
  const [tab, setTab] = useState<ReportTab>('monthly');

  const [salesValue, loading] = useCollection(
    shopId ? query(collection(db, 'shops', shopId, 'sales'), orderBy('date', 'desc'), limit(2000)) : null,
  );
  const sales = salesValue?.docs.map((d) => d.data() as any) || [];

  const monthlyRows = useMemo(() => aggregate(sales, (s) => (s.date || '').slice(0, 7) || 'Unknown'), [sales]);
  const itemRows = useMemo(() => aggregate(sales, (s) => s.itemName || 'Unnamed item'), [sales]);
  const categoryRows = useMemo(() => aggregate(sales, (s) => s.category || 'Uncategorized'), [sales]);

  const rows = tab === 'monthly' ? monthlyRows : tab === 'item' ? itemRows : categoryRows;
  const totalRevenue = sales.reduce((sum, s) => sum + (s.price || 0), 0);
  const totalCost = sales.filter((s) => !s.costPending).reduce((sum, s) => sum + (s.cost || 0), 0);

  // --- Period export (monthly or quarterly download of raw sales data) ---
  const today = todayLocalDateString();
  const [periodType, setPeriodType] = useState<PeriodType>('month');
  const [selectedMonth, setSelectedMonth] = useState(today.slice(0, 7));
  const [selectedYear, setSelectedYear] = useState(parseInt(today.slice(0, 4), 10));
  const [selectedQuarter, setSelectedQuarter] = useState(quarterOf(today));
  const [exportingPdf, setExportingPdf] = useState(false);

  const yearOptions = useMemo(() => {
    const years = new Set(sales.map((s) => parseInt((s.date || '').slice(0, 4), 10)).filter((y) => !isNaN(y)));
    years.add(selectedYear);
    return Array.from(years).sort((a, b) => b - a);
  }, [sales, selectedYear]);

  const periodLabel = periodType === 'month' ? selectedMonth : `Q${selectedQuarter} ${selectedYear}`;

  const periodSales = useMemo(() => {
    return sales
      .filter((s) => {
        if (!s.date) return false;
        if (periodType === 'month') return s.date.slice(0, 7) === selectedMonth;
        return s.date.slice(0, 4) === String(selectedYear) && quarterOf(s.date) === selectedQuarter;
      })
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [sales, periodType, selectedMonth, selectedYear, selectedQuarter]);

  const periodTotals = useMemo(() => {
    const revenue = periodSales.reduce((sum, s) => sum + (s.price || 0), 0);
    const cost = periodSales.filter((s) => !s.costPending).reduce((sum, s) => sum + (s.cost || 0), 0);
    return { revenue, cost, profit: revenue - cost };
  }, [periodSales]);

  const exportRows = () =>
    periodSales.map((s) => ({
      date: s.date,
      item: s.itemName || '',
      category: s.category || '',
      quantity: s.quantity || 1,
      customer: s.customerName || '',
      price: s.price || 0,
      cost: s.costPending ? '' : (s.cost ?? ''),
      profit: s.costPending ? '' : ((s.price || 0) - (s.cost || 0)),
      status: s.paymentStatus === 'credit' ? 'Credit' : 'Paid',
      soldBy: s.soldByName || '',
    }));

  const handleExportCsv = async () => {
    const rows = exportRows();
    if (rows.length === 0) {
      alert('No sales in this period.');
      return;
    }
    const headers = ['Date', 'Item', 'Category', 'Quantity', 'Customer', 'Price', 'Cost', 'Profit', 'Status', 'Sold By'];
    const csv = [
      headers.join(','),
      ...rows.map((r) =>
        [csvEscape(r.date), csvEscape(r.item), csvEscape(r.category), r.quantity, csvEscape(r.customer), r.price, csvEscape(r.cost), csvEscape(r.profit), csvEscape(r.status), csvEscape(r.soldBy)].join(','),
      ),
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    await shareOrDownloadFile(blob, `sales_${periodLabel.replace(/\s/g, '_')}.csv`, 'text/csv');
  };

  const handleExportPdf = async () => {
    const rows = exportRows();
    if (rows.length === 0) {
      alert('No sales in this period.');
      return;
    }
    setExportingPdf(true);
    try {
      // Lazy-loaded so the ~300KB PDF library only ever ships to shopkeepers who actually export.
      const [{ default: jsPDF }, autoTableModule] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
      const autoTable = autoTableModule.default;
      const docPdf = new jsPDF();
      docPdf.setFontSize(14);
      docPdf.text(`Sales report — ${periodLabel}`, 14, 16);
      docPdf.setFontSize(10);
      docPdf.text(
        `Revenue ${periodTotals.revenue.toLocaleString()}   Cost ${periodTotals.cost.toLocaleString()}   Profit ${periodTotals.profit.toLocaleString()}`,
        14,
        23,
      );
      autoTable(docPdf, {
        startY: 28,
        head: [['Date', 'Item', 'Category', 'Qty', 'Customer', 'Price', 'Cost', 'Profit', 'Status', 'Sold By']],
        body: rows.map((r) => [r.date, r.item, r.category, r.quantity, r.customer, r.price, r.cost, r.profit, r.status, r.soldBy]),
        styles: { fontSize: 8 },
        headStyles: { fillColor: [124, 58, 237] },
      });
      const pdfBlob = docPdf.output('blob') as Blob;
      await shareOrDownloadFile(pdfBlob, `sales_${periodLabel.replace(/\s/g, '_')}.pdf`, 'application/pdf');
    } catch (err) {
      console.error('PDF export failed:', err);
      alert('Failed to generate PDF.');
    } finally {
      setExportingPdf(false);
    }
  };

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full space-y-6 pb-24">
        <div>
          <h1 className="text-2xl font-black text-[#7C3AED]">Reports</h1>
          <p className="text-sm text-text-muted mt-1">Sales, cost & profit over time.</p>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div className="bg-white rounded-2xl border border-border-subtle p-4">
            <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Revenue</p>
            <p className="text-lg font-black text-primary mt-0.5">{totalRevenue.toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
          </div>
          <div className="bg-white rounded-2xl border border-border-subtle p-4">
            <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Cost</p>
            <p className="text-lg font-black text-error mt-0.5">{totalCost.toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
          </div>
          <div className="bg-white rounded-2xl border border-border-subtle p-4">
            <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Profit</p>
            <p className="text-lg font-black text-[#0F7A38] mt-0.5">{(totalRevenue - totalCost).toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
          </div>
        </div>

        <div className="flex gap-2">
          {(['monthly', 'item', 'category'] as ReportTab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={clsx(
                'flex-1 py-2.5 rounded-xl text-xs font-bold border capitalize',
                tab === t ? 'bg-[#7C3AED] text-white border-[#7C3AED]' : 'bg-white text-text-muted border-border-subtle',
              )}
            >
              {t === 'monthly' ? 'Monthly' : t === 'item' ? 'By Item' : 'By Category'}
            </button>
          ))}
        </div>

        <section className="space-y-2">
          {loading && <p className="text-sm text-text-muted px-1">Loading…</p>}
          {!loading && rows.length === 0 && <p className="text-sm text-text-muted italic px-1">No sales yet.</p>}
          {rows.map((r) => {
            const netProfit = r.revenue - r.cost;
            return (
              <div key={r.key} className="bg-white rounded-xl border border-border-subtle p-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-bold text-on-surface">{r.key}</p>
                  <p className="text-sm font-bold text-primary">{r.revenue.toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
                </div>
                <div className="flex items-center justify-between mt-1">
                  <p className="text-[10px] text-text-muted">
                    {r.count} sale{r.count !== 1 ? 's' : ''}
                    {r.costKnownCount < r.count && ` · cost known for ${r.costKnownCount}`}
                  </p>
                  <p className={clsx('text-[11px] font-bold', netProfit >= 0 ? 'text-[#0F7A38]' : 'text-error')}>
                    Profit {netProfit.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </p>
                </div>
              </div>
            );
          })}
        </section>

        <section className="bg-white rounded-2xl border border-border-subtle p-5 space-y-4">
          <h2 className="text-xs font-bold text-[#7C3AED] uppercase tracking-widest">Download Sales Data</h2>

          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setPeriodType('month')}
              className={clsx('py-2 rounded-xl text-xs font-bold border', periodType === 'month' ? 'bg-[#7C3AED] text-white border-[#7C3AED]' : 'bg-white text-text-muted border-border-subtle')}
            >
              Monthly
            </button>
            <button
              onClick={() => setPeriodType('quarter')}
              className={clsx('py-2 rounded-xl text-xs font-bold border', periodType === 'quarter' ? 'bg-[#7C3AED] text-white border-[#7C3AED]' : 'bg-white text-text-muted border-border-subtle')}
            >
              Quarterly
            </button>
          </div>

          {periodType === 'month' ? (
            <input
              type="month"
              value={selectedMonth}
              onChange={(e) => setSelectedMonth(e.target.value)}
              className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none"
            />
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <select
                value={selectedQuarter}
                onChange={(e) => setSelectedQuarter(parseInt(e.target.value, 10))}
                className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none"
              >
                {[1, 2, 3, 4].map((q) => (
                  <option key={q} value={q}>Q{q}</option>
                ))}
              </select>
              <select
                value={selectedYear}
                onChange={(e) => setSelectedYear(parseInt(e.target.value, 10))}
                className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none"
              >
                {yearOptions.map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </div>
          )}

          <p className="text-[11px] text-text-muted">
            {periodSales.length} sale{periodSales.length !== 1 ? 's' : ''} · Revenue {periodTotals.revenue.toLocaleString()} · Profit {periodTotals.profit.toLocaleString()}
          </p>

          <div className="flex gap-2">
            <button onClick={handleExportCsv} className="flex-1 flex items-center justify-center gap-1.5 py-2.5 bg-surface border border-border-subtle rounded-xl text-xs font-bold text-[#7C3AED]">
              <span className="material-symbols-outlined text-[16px]">table_view</span>
              Excel (CSV)
            </button>
            <button
              onClick={handleExportPdf}
              disabled={exportingPdf}
              className="flex-1 flex items-center justify-center gap-1.5 py-2.5 bg-surface border border-border-subtle rounded-xl text-xs font-bold text-[#7C3AED] disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-[16px]">picture_as_pdf</span>
              {exportingPdf ? 'Generating…' : 'PDF'}
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}
