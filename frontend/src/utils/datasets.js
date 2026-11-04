export function filterDatasets(datasets, { name = "", date_from = "", date_to = "" } = {}) {
  const searchName = name.trim().toLocaleLowerCase();

  return datasets.filter((dataset) => {
    if (!String(dataset.name || "").toLocaleLowerCase().includes(searchName)) return false;
    if (!date_from && !date_to) return true;

    const uploadedAt = new Date(dataset.uploaded_at);
    if (Number.isNaN(uploadedAt.getTime())) return false;

    // Match the local calendar date shown in the Uploaded column, including
    // uploads at any time on either boundary date.
    const uploadDate = [
      String(uploadedAt.getFullYear()).padStart(4, "0"),
      String(uploadedAt.getMonth() + 1).padStart(2, "0"),
      String(uploadedAt.getDate()).padStart(2, "0"),
    ].join("-");

    return (!date_from || uploadDate >= date_from) && (!date_to || uploadDate <= date_to);
  });
}
