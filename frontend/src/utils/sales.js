export function salesRequestParams({ status, date_from, date_to } = {}) {
  return {
    status: status || undefined,
    date_from: date_from || undefined,
    date_to: date_to || undefined,
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
