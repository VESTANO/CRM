import qz from "qz-tray";
import { apiClient } from "./api.js";

export const BILL_PRINTER_NAME = "Essae PR-55";
let qzSecurityConfigured = false;

const BILL_FIELD_PATTERNS = {
  item: [/item/i, /product/i, /description/i],
  quantity: [/^qty$/i, /quantity/i],
  unitPrice: [/unit\s*price/i, /\brate\b/i, /^price$/i],
  tax: [/\btax\b/i, /\bgst\b/i],
  discount: [/discount/i],
  total: [/grand\s*total/i, /\btotal\b/i, /\bamount\b/i, /\bnet\b/i],
};

function fieldValue(fields, patterns) {
  const match = fields.find((field) => patterns.some((pattern) => pattern.test(field.label)));
  return normalizeValue(match?.value);
}

function normalizeValue(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function parseAmount(value) {
  const numeric = Number(normalizeValue(value).replace(/[^\d.-]/g, ""));
  return Number.isFinite(numeric) ? numeric : null;
}

function formatAmount(value) {
  const numeric = parseAmount(value);
  return numeric === null ? normalizeValue(value) : numeric.toFixed(2);
}

function getCookie(name) {
  return document.cookie
    .split(";")
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(`${name}=`))
    ?.slice(name.length + 1) || "";
}

function configureQzSecurity() {
  if (qzSecurityConfigured) return;

  qz.security.setCertificatePromise((resolve, reject) => {
    apiClient.get("/qz/certificate/", { responseType: "text" })
      .then(({ data }) => resolve(data))
      .catch((error) => reject(qzErrorMessage(error)));
  });

  qz.security.setSignatureAlgorithm("SHA512");
  qz.security.setSignaturePromise((toSign) => (resolve, reject) => {
    apiClient.post(
      "/qz/sign/",
      { request: toSign },
      { headers: { "X-CSRFToken": getCookie("csrftoken") } }
    )
      .then(({ data }) => resolve(data.signature))
      .catch((error) => reject(qzErrorMessage(error)));
  });

  qzSecurityConfigured = true;
}

export function buildBillFromVisit(visit) {
  return buildBillFromDraft(getBillDraftFromVisit(visit));
}

export function getBillDraftFromVisit(visit) {
  const fields = visit?.customer_fields || [];
  return {
    customerName: normalizeValue(visit?.client_name),
    source: normalizeValue(visit?.dataset_name || visit?.client_source || "Manual Client"),
    visitDate: normalizeValue(visit?.visit_date),
    itemDescription: fieldValue(fields, BILL_FIELD_PATTERNS.item),
    quantity: fieldValue(fields, BILL_FIELD_PATTERNS.quantity),
    unitPrice: fieldValue(fields, BILL_FIELD_PATTERNS.unitPrice),
    tax: fieldValue(fields, BILL_FIELD_PATTERNS.tax),
    discount: fieldValue(fields, BILL_FIELD_PATTERNS.discount),
    total: fieldValue(fields, BILL_FIELD_PATTERNS.total),
    reference: visit?.id ? `Visit #${visit.id}` : "Visit Bill",
  };
}

export function buildBillFromDraft(draft) {
  const itemDescription = normalizeValue(draft?.itemDescription);
  const quantity = normalizeValue(draft?.quantity);
  const unitPrice = normalizeValue(draft?.unitPrice);
  const total = normalizeValue(draft?.total);
  const tax = normalizeValue(draft?.tax);
  const discount = normalizeValue(draft?.discount);

  const missing = [];
  if (!itemDescription) missing.push("item description");
  if (!quantity) missing.push("quantity");
  if (!unitPrice) missing.push("unit price");
  if (!total) missing.push("bill total");

  if (missing.length) {
    return {
      ok: false,
      missing,
      reason: `Bill printing needs ${missing.join(", ")} fields in the selected customer/bill data.`,
    };
  }

  return {
    ok: true,
    bill: {
      customerName: normalizeValue(draft.customerName),
      source: normalizeValue(draft.source),
      visitDate: normalizeValue(draft.visitDate),
      item: {
        description: itemDescription,
        quantity,
        unitPrice,
      },
      tax,
      discount,
      total,
      reference: normalizeValue(draft.reference || "Visit Bill"),
    },
  };
}

export function calculateDraftTotal(draft) {
  const quantity = parseAmount(draft?.quantity);
  const unitPrice = parseAmount(draft?.unitPrice);
  if (quantity === null || unitPrice === null) return "";
  const tax = parseAmount(draft?.tax) || 0;
  const discount = parseAmount(draft?.discount) || 0;
  return Math.max(quantity * unitPrice + tax - discount, 0).toFixed(2);
}

function escapeHtml(value) {
  return normalizeValue(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function billHtml(bill) {
  const optionalRows = [
    bill.discount ? `<tr><td>Discount</td><td class="right">${escapeHtml(formatAmount(bill.discount))}</td></tr>` : "",
    bill.tax ? `<tr><td>Tax</td><td class="right">${escapeHtml(formatAmount(bill.tax))}</td></tr>` : "",
  ].join("");

  return `<!doctype html>
<html>
  <head>
    <meta content="text/html;charset=utf-8" http-equiv="Content-Type">
    <style>
      @page { margin: 0; size: 80mm auto; }
      body {
        margin: 0;
        width: 72mm;
        padding: 3mm;
        color: #000;
        font-family: Arial, Helvetica, sans-serif;
        font-size: 11px;
      }
      .center { text-align: center; }
      .right { text-align: right; }
      .muted { font-size: 10px; }
      .rule { border-top: 1px dashed #000; margin: 6px 0; }
      table { width: 100%; border-collapse: collapse; }
      td { padding: 2px 0; vertical-align: top; }
      .total td { border-top: 1px solid #000; font-weight: 700; padding-top: 5px; }
    </style>
  </head>
  <body>
    <div class="center">
      <strong>Customer CRM</strong><br>
      <span class="muted">Bill</span>
    </div>
    <div class="rule"></div>
    <table>
      <tr><td>Customer</td><td class="right">${escapeHtml(bill.customerName)}</td></tr>
      <tr><td>Source</td><td class="right">${escapeHtml(bill.source)}</td></tr>
      <tr><td>Reference</td><td class="right">${escapeHtml(bill.reference)}</td></tr>
      <tr><td>Date</td><td class="right">${escapeHtml(bill.visitDate)}</td></tr>
    </table>
    <div class="rule"></div>
    <table>
      <tr><td colspan="2"><strong>${escapeHtml(bill.item.description)}</strong></td></tr>
      <tr><td>Qty</td><td class="right">${escapeHtml(bill.item.quantity)}</td></tr>
      <tr><td>Unit Price</td><td class="right">${escapeHtml(formatAmount(bill.item.unitPrice))}</td></tr>
      ${optionalRows}
      <tr class="total"><td>Total</td><td class="right">${escapeHtml(formatAmount(bill.total))}</td></tr>
    </table>
    <div class="rule"></div>
    <div class="center muted">Generated by Customer CRM</div>
  </body>
</html>`;
}

async function ensureConnected() {
  if (qz.websocket.isActive()) return;
  configureQzSecurity();
  await qz.websocket.connect();
}

export async function findBillPrinter() {
  await ensureConnected();
  return qz.printers.find(BILL_PRINTER_NAME);
}

export async function printBill(bill) {
  const printer = await findBillPrinter();
  const config = qz.configs.create(printer, {
    jobName: `${bill.reference} Bill`,
    units: "mm",
    margins: { top: 0, right: 0, bottom: 0, left: 0 },
    scaleContent: false,
    rasterize: false,
    colorType: "blackwhite",
    orientation: "portrait",
    encoding: "UTF-8",
  });

  const data = [{
    type: "pixel",
    format: "html",
    flavor: "plain",
    data: billHtml(bill),
    options: { pageWidth: 80 },
  }];

  await qz.print(config, data);
}

export function qzErrorMessage(error) {
  if (!error) return "Unable to print the bill.";
  if (typeof error === "string") return error;
  return error.message || String(error);
}
