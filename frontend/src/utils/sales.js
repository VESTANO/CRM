export function salesRequestParams({ status, date_from, date_to, q, dataset_name, payment_status, page } = {}) {
  return {
    status: status || undefined,
    date_from: date_from || undefined,
    date_to: date_to || undefined,
    q: q?.trim() || undefined,
    dataset_name: dataset_name?.trim() || undefined,
    payment_status: payment_status || undefined,
    page: Number(page) > 1 ? Number(page) : undefined,
  };
}

export function filterSalesVisits(visits, { q = "", dataset_name = "", payment_status = "" } = {}) {
  const clientName = q.trim().toLocaleLowerCase();
  const datasetName = dataset_name.trim().toLocaleLowerCase();

  return visits.filter((visit) => (
    String(visit.client_name || "").toLocaleLowerCase().includes(clientName)
    && String(visit.dataset_name || "").toLocaleLowerCase().includes(datasetName)
    && (!payment_status || (visit.status === "converted" && visit.payment_status === payment_status))
  ));
}

export function buildSalesReportStats(visits, now = new Date()) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const [year,month] = today.slice(0,7).split("-").map(Number);
  const statuses = new Map();
  const months = new Map();
  let expenseCents = 0;
  for (const visit of visits) {
    statuses.set(visit.status,{ label: visit.status_label || visit.status, count: (statuses.get(visit.status)?.count || 0)+1 });
    expenseCents += Math.round(Number(visit.expense || 0)*100);
    const key = String(visit.visit_date || "").slice(0,7);
    if (/^\d{4}-(?:0[1-9]|1[0-2])$/.test(key)) months.set(key,(months.get(key) || 0)+1);
  }
  const label = new Intl.DateTimeFormat("en",{month:"short",timeZone:"UTC"});
  return {
    statuses: Array.from(statuses,([value,data])=>({value,...data})),
    recentMonths: Array.from({length:6},(_,index)=>{
      const date = new Date(Date.UTC(year,month-1-(5-index),1));
      const key = date.toISOString().slice(0,7);
      return {key,label:label.format(date),count:months.get(key) || 0};
    }),
    totalExpenses: expenseCents/100,
    totalVisits: visits.length,
    activeMonths: months.size,
  };
}
