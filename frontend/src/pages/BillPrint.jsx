import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import TimedAlert from "../components/TimedAlert.jsx";
import {
  buildBillFromDraft,
  calculateDraftTotal,
  listPrinters,
  printBill,
  qzErrorMessage,
  suggestedBillPrinter,
} from "../services/qzPrinter.js";

const selectedPrinterStorageKey = "crm.billPrint.selectedPrinter";

const initialBill = {
  customerName: "",
  source: "Direct Bill",
  visitDate: new Date().toISOString().slice(0, 10),
  reference: "",
  itemDescription: "",
  quantity: "",
  unitPrice: "",
  discount: "",
  tax: "",
  total: "",
};

export default function BillPrint() {
  const [billDraft, setBillDraft] = useState(initialBill);
  const [printing, setPrinting] = useState(false);
  const [loadingPrinters, setLoadingPrinters] = useState(false);
  const [printers, setPrinters] = useState([]);
  const [selectedPrinter, setSelectedPrinter] = useState(() => localStorage.getItem(selectedPrinterStorageKey) || "");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const billResult = buildBillFromDraft({
    ...billDraft,
    reference: billDraft.reference || `Bill ${billDraft.visitDate}`,
  });

  const updateBillDraft = (event) => {
    const { name, value } = event.target;
    setBillDraft((current) => ({ ...current, [name]: value }));
  };

  const refreshPrinters = async ({ showSuccess = false } = {}) => {
    setLoadingPrinters(true);
    setError("");
    try {
      const discoveredPrinters = await listPrinters();
      setPrinters(discoveredPrinters);
      setSelectedPrinter((currentPrinter) => {
        const rememberedPrinter = currentPrinter || localStorage.getItem(selectedPrinterStorageKey) || "";
        if (rememberedPrinter && discoveredPrinters.includes(rememberedPrinter)) return rememberedPrinter;
        const suggestedPrinter = suggestedBillPrinter(discoveredPrinters);
        if (suggestedPrinter) {
          localStorage.setItem(selectedPrinterStorageKey, suggestedPrinter);
        }
        return suggestedPrinter;
      });
      if (showSuccess) {
        setMessage(discoveredPrinters.length ? "Printer list refreshed." : "No printers were found from QZ Tray.");
      }
    } catch (printerError) {
      setError(qzErrorMessage(printerError) || "Unable to load printers from QZ Tray.");
      setPrinters([]);
    } finally {
      setLoadingPrinters(false);
    }
  };

  useEffect(() => {
    refreshPrinters();
  }, []);

  const updateSelectedPrinter = (event) => {
    const printerName = event.target.value;
    setSelectedPrinter(printerName);
    if (printerName) {
      localStorage.setItem(selectedPrinterStorageKey, printerName);
    } else {
      localStorage.removeItem(selectedPrinterStorageKey);
    }
  };

  const fillCalculatedTotal = () => {
    const calculatedTotal = calculateDraftTotal(billDraft);
    if (calculatedTotal) {
      setBillDraft((current) => ({ ...current, total: calculatedTotal }));
    }
  };

  const resetBill = () => {
    setBillDraft(initialBill);
    setMessage("");
    setError("");
  };

  const submitBill = async (event) => {
    event.preventDefault();
    setMessage("");
    setError("");

    if (!billResult.ok) {
      setError(billResult.reason);
      return;
    }
    if (!selectedPrinter) {
      setError("Select the ESSAE PR-55 printer queue available on this laptop before printing.");
      return;
    }

    setPrinting(true);
    try {
      await printBill(billResult.bill, selectedPrinter);
      setMessage("Bill print job was sent to QZ Tray.");
      setBillDraft(initialBill);
    } catch (printError) {
      setError(qzErrorMessage(printError));
    } finally {
      setPrinting(false);
    }
  };

  return (
    <>
      <nav aria-label="breadcrumb" className="mb-3">
        <ol className="breadcrumb mb-0">
          <li className="breadcrumb-item"><Link to="/dashboard">Dashboard</Link></li>
          <li className="breadcrumb-item active" aria-current="page">Bill Print</li>
        </ol>
      </nav>
      <div className="page-header mb-4">
        <div>
          <div className="eyebrow">Printing</div>
          <h1 className="h2 mb-2">Bill Print</h1>
          <p className="text-secondary mb-0">Enter bill details and send the job directly to QZ Tray.</p>
        </div>
      </div>

      <TimedAlert message={error} variant="warning" />
      <TimedAlert message={message} />

      <section className="panel mb-4" aria-labelledby="printer-heading">
        <div className="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-3">
          <div>
            <h2 className="h4 mb-1" id="printer-heading">Printer</h2>
            <p className="text-secondary mb-0">Select the ESSAE PR-55 queue available from this laptop's QZ Tray.</p>
          </div>
          <button className="btn btn-outline-primary btn-sm" type="button" onClick={() => refreshPrinters({ showSuccess: true })} disabled={loadingPrinters || printing}>
            <i className="bi bi-arrow-clockwise me-1" />
            {loadingPrinters ? "Loading..." : "Refresh Printers"}
          </button>
        </div>
        <div className="row g-3 align-items-end">
          <div className="col-md-8">
            <label className="form-label" htmlFor="bill-printer">Printer Queue</label>
            <select id="bill-printer" className="form-select" value={selectedPrinter} onChange={updateSelectedPrinter} disabled={loadingPrinters || printing}>
              <option value="">{loadingPrinters ? "Loading printers..." : "Select a printer"}</option>
              {printers.map((printer) => (
                <option value={printer} key={printer}>{printer}</option>
              ))}
            </select>
          </div>
          <div className="col-md-4">
            <div className="text-secondary small">
              Shared printers may appear as a network queue name instead of USB001.
            </div>
          </div>
        </div>
      </section>

      <section className="panel" aria-labelledby="bill-print-heading">
        <div className="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-3">
          <div>
            <h2 className="h4 mb-1" id="bill-print-heading">Bill Details</h2>
            <p className="text-secondary mb-0">These values are printed as entered and are not saved to the database.</p>
          </div>
        </div>
        <form onSubmit={submitBill}>
          <div className="row g-3">
            <BillField label="Customer Name" name="customerName" value={billDraft.customerName} onChange={updateBillDraft} />
            <BillField label="Reference" name="reference" value={billDraft.reference} onChange={updateBillDraft} placeholder="Bill number or visit reference" />
            <BillField label="Bill Date" name="visitDate" type="date" value={billDraft.visitDate} onChange={updateBillDraft} />
            <BillField label="Source" name="source" value={billDraft.source} onChange={updateBillDraft} />
            <BillField label="Item / Product" name="itemDescription" value={billDraft.itemDescription} onChange={updateBillDraft} required />
            <BillField label="Quantity" name="quantity" type="number" value={billDraft.quantity} onChange={updateBillDraft} required step="0.01" min="0" />
            <BillField label="Unit Price" name="unitPrice" type="number" value={billDraft.unitPrice} onChange={updateBillDraft} required step="0.01" min="0" />
            <BillField label="Discount" name="discount" type="number" value={billDraft.discount} onChange={updateBillDraft} step="0.01" min="0" />
            <BillField label="Tax / GST" name="tax" type="number" value={billDraft.tax} onChange={updateBillDraft} step="0.01" min="0" />
            <div className="col-md-6">
              <label className="form-label" htmlFor="bill-total">Bill Total</label>
              <div className="input-group">
                <input id="bill-total" className="form-control" name="total" type="number" value={billDraft.total} onChange={updateBillDraft} required step="0.01" min="0" />
                <button className="btn btn-outline-secondary" type="button" onClick={fillCalculatedTotal}>Calculate</button>
              </div>
            </div>
          </div>
          <div className="d-flex flex-wrap gap-2 mt-4">
            <button className="btn btn-primary" type="submit" disabled={printing}>
              <i className="bi bi-printer me-1" />
              {printing ? "Printing..." : "Print Bill"}
            </button>
            <button className="btn btn-outline-secondary" type="button" onClick={resetBill}>Clear</button>
          </div>
        </form>
      </section>
    </>
  );
}

function BillField({ label, name, value, onChange, type = "text", ...props }) {
  return (
    <div className="col-md-6">
      <label className="form-label" htmlFor={`bill-${name}`}>{label}</label>
      <input id={`bill-${name}`} className="form-control" name={name} type={type} value={value} onChange={onChange} {...props} />
    </div>
  );
}
