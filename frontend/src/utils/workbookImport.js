// Workbooks are schemaless: retain every formatted source cell, including blank
// and duplicate headers. CRM response/note fields are deliberately separate.
export function prepareWorkbook(XLSX, workbook) {
  if (!workbook.SheetNames.length || workbook.SheetNames.length > 50) throw new Error("Use a workbook containing 1–50 sheets.");
  let total = 0;
  const warnings = [];
  const sheets = workbook.SheetNames.map((name) => {
    let headerRow = 0;
    const range = workbook.Sheets[name]['!ref'];
    if (range) {
      const bounds = XLSX.utils.decode_range(range);
      headerRow = bounds.s.r;
      if (bounds.e.r > 100000 || bounds.e.c > 499) throw new Error(`${name}: worksheet exceeds 100,000 data rows or 500 columns.`);
    }
    for (const [address,cell] of Object.entries(workbook.Sheets[name])) {
      if (!address.startsWith('!') && cell.f && cell.v == null) throw new Error(`${name}, ${address}: formula has no saved value. Recalculate and save the workbook before importing.`);
    }
    const matrix = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: "", raw: false, blankrows: true });
    const headerOffset = matrix.findIndex((row) => row.some((value) => value !== "" && value != null));
    if (headerOffset < 0) return null;
    const width = matrix.reduce((max, row) => Math.max(max, row.length), 0);
    if (!width) return null;
    if (width > 500) throw new Error(`${name}: maximum 500 columns.`);
    const column_names = Array.from({ length: width }, (_, i) => {
      const original = String(matrix[headerOffset]?.[i] ?? "");
      return original.trim() ? original : `Unnamed column ${i + 1}`;
    });
    if (column_names.some((value) => value.length > 255)) throw new Error(`${name}: a column heading exceeds 255 characters.`);
    const used = new Set();
    const field_keys = column_names.map((value, i) => {
      const base = value.toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/[\s-]+/g, "_").slice(0, 240) || `column_${i + 1}`;
      let key = base, suffix = 1;
      while (used.has(key)) key = `${base}_${++suffix}`;
      used.add(key);
      return key;
    });
    const seenRows = new Set();
    let duplicates = 0;
    const records = [];
    matrix.slice(headerOffset + 1).forEach((values, i) => {
      if (!values.some((v) => v !== "" && v != null)) return;
      const original_data = Object.fromEntries(field_keys.map((key, j) => [key, String(values[j] ?? "")]));
      const signature = JSON.stringify(original_data);
      if (seenRows.has(signature)) duplicates++;
      seenRows.add(signature);
      records.push({ sheet_name: name, row_number: headerRow + headerOffset + i + 2, original_data });
    });
    if (duplicates) warnings.push(`${name}: ${duplicates} repeated rows retained as separate spreadsheet rows.`);
    total += records.length;
    return { name, rows: Math.max(0, headerRow + matrix.length - 1), columns: width, column_names, field_keys, expected_rows: records.length, records };
  }).filter(Boolean);
  if (!total) throw new Error("The workbook has no non-empty customer rows.");
  if (total > 100000) throw new Error("Use at most 100,000 non-empty rows per workbook.");
  return { sheets, warnings, total };
}

export async function uploadStagedImport(pending, post) {
  const sheets = pending.sheets.map(({ records, ...sheet }) => sheet);
  const { data: job } = await post("/import/start/", {
    fingerprint: pending.fingerprint, datasetName: pending.datasetName,
    filename: pending.filename, sheets,
  });
  if (job.dataset) return { data: job };
  for (const sheet of pending.sheets) {
    for (let i = 0; i < sheet.records.length; i += 250) {
      await post(`/import/jobs/${job.id}/batch/`, { rows: sheet.records.slice(i, i + 250) });
    }
  }
  return post(`/import/jobs/${job.id}/commit/`, {});
}
