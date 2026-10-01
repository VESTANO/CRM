import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { importApi } from "../services/api.js";
import { useAuth } from "../hooks/useAuth.jsx";
import TimedAlert from "../components/TimedAlert.jsx";

export default function ImportExcel() {
  const { csrfToken } = useAuth();
  const navigate = useNavigate();
  const fileInputRef = useRef(null);
  const [datasetName, setDatasetName] = useState("");
  const [errors, setErrors] = useState({});
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("danger");
  const [inspectionResult, setInspectionResult] = useState(null);
  const [isInspecting, setIsInspecting] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);

  const inspect = async (event) => {
    event.preventDefault();
    setErrors({});
    setMessage("");
    setMessageType("danger");
    setInspectionResult(null);
    setIsInspecting(true);

    const formData = new FormData();
    formData.append("dataset_name", datasetName);
    if (fileInputRef.current?.files?.[0]) {
      formData.append("excel_file", fileInputRef.current.files[0]);
    }

    try {
      const { data } = await importApi.inspect(formData, csrfToken);
      setInspectionResult(data);
      setDatasetName(data.datasetName);
      setMessage("Excel file inspected successfully. Review the structure, then confirm the import.");
      setMessageType("success");
    } catch (err) {
      if (err.response?.data?.errors) {
        setErrors(err.response.data.errors);
      } else {
        setMessage(err.response?.data?.detail || "Something went wrong while reading the workbook.");
        setMessageType("danger");
      }
    } finally {
      setIsInspecting(false);
    }
  };

  const confirmImport = async (event) => {
    event.preventDefault();
    if (!inspectionResult?.pendingImportToken) return;
    setMessage("");
    setMessageType("danger");
    setIsConfirming(true);
    try {
      const { data } = await importApi.confirm(inspectionResult.pendingImportToken, csrfToken);
      navigate(`/datasets/${data.dataset.id}`);
    } catch (err) {
      setMessage(err.response?.data?.detail || "Something went wrong while importing the workbook.");
      setMessageType("danger");
      setIsConfirming(false);
    }
  };

  return (
    <>
      <nav aria-label="breadcrumb" className="mb-3">
        <ol className="breadcrumb mb-0">
          <li className="breadcrumb-item"><Link to="/dashboard">Dashboard</Link></li>
          <li className="breadcrumb-item active" aria-current="page">Import Excel</li>
        </ol>
      </nav>

      <div className="page-header d-flex justify-content-between align-items-start gap-3 mb-4">
        <div>
          <h1 className="h2 mb-2">Import Excel</h1>
          <p className="text-secondary mb-0">
            Upload a workbook, inspect its structure, then confirm before creating a dataset.
          </p>
        </div>
      </div>

      <TimedAlert message={message} variant={messageType} />

      <div className="row g-4">
        <div className="col-lg-7 col-xl-6">
          <div className="panel">
            <form onSubmit={inspect}>
              <div className="upload-step mb-4">
                <span className="step-number">1</span>
                <div className="flex-grow-1">
                  <label className="form-label" htmlFor="dataset-name">Dataset name</label>
                  <input
                    className="form-control"
                    id="dataset-name"
                    maxLength="255"
                    placeholder="January Leads"
                    required
                    value={datasetName}
                    onChange={(event) => setDatasetName(event.target.value)}
                  />
                  <div className="form-text">Example: January Leads</div>
                  <FieldErrors errors={errors.dataset_name} />
                </div>
              </div>
              <div className="upload-step mb-4">
                <span className="step-number">2</span>
                <div className="flex-grow-1">
                  <label className="form-label" htmlFor="excel-file">Excel file</label>
                  <input
                    accept=".xlsx"
                    className="form-control"
                    id="excel-file"
                    ref={fileInputRef}
                    type="file"
                  />
                  <div className="form-text">Upload an .xlsx workbook for dataset import and structure inspection.</div>
                  <FieldErrors errors={errors.excel_file} />
                </div>
              </div>
              <button className="btn btn-primary" type="submit" disabled={isInspecting}>
                {isInspecting ? "Inspecting..." : "Inspect Excel"}
              </button>
            </form>
          </div>
        </div>
      </div>

      {inspectionResult && (
        <>
          <hr className="my-5" />
          <InspectionSummary result={inspectionResult} onConfirm={confirmImport} isConfirming={isConfirming} />
        </>
      )}
    </>
  );
}

function InspectionSummary({ result, onConfirm, isConfirming }) {
  const { datasetName, inspection, pendingImportToken } = result;

  return (
    <section>
      <h2 className="h3 mb-3">Workbook Summary</h2>
      <dl className="row">
        <dt className="col-sm-3">Dataset</dt>
        <dd className="col-sm-9">{datasetName}</dd>

        <dt className="col-sm-3">Filename</dt>
        <dd className="col-sm-9">{inspection.filename}</dd>

        <dt className="col-sm-3">Sheets</dt>
        <dd className="col-sm-9">{inspection.sheet_names.join(", ")}</dd>
      </dl>

      {inspection.sheets.map((sheet) => (
        <div className="sheet-section panel mb-4" key={sheet.name}>
          <h3 className="h4 mb-3">{sheet.name}</h3>

          <div className="row g-3 mb-3">
            <div className="col-sm-6">
              <div className="summary-card compact">
                <div className="text-secondary small">Rows</div>
                <div className="fs-5">{sheet.rows}</div>
              </div>
            </div>
            <div className="col-sm-6">
              <div className="summary-card compact">
                <div className="text-secondary small">Columns</div>
                <div className="fs-5">{sheet.columns}</div>
              </div>
            </div>
          </div>

          <h4 className="h6">Column Names</h4>
          {sheet.column_names.length ? (
            <ol className="column-list">
              {sheet.column_names.map((column, index) => (
                <li key={`${column}-${index}`}>{column}</li>
              ))}
            </ol>
          ) : (
            <p className="text-secondary">No columns were detected.</p>
          )}

          <h4 className="h6 mt-4">Masked Preview</h4>
          {sheet.preview_rows.length ? (
            <div className="table-responsive">
              <table className="table table-sm table-hover align-middle crm-table">
                <thead className="table-light">
                  <tr>
                    {sheet.preview_headers.map((header, index) => (
                      <th scope="col" key={`${header}-${index}`}>{header}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sheet.preview_rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {row.map((value, columnIndex) => (
                        <td key={`${rowIndex}-${columnIndex}`}>{value}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-secondary">No preview rows were found.</p>
          )}
        </div>
      ))}

      {pendingImportToken && (
        <form className="d-flex flex-wrap gap-2 mt-4" onSubmit={onConfirm}>
          <button className="btn btn-success btn-lg" type="submit" disabled={isConfirming}>
            {isConfirming ? "Importing..." : "Confirm Import"}
          </button>
          <Link className="btn btn-outline-secondary btn-lg" to="/import">Cancel</Link>
        </form>
      )}
    </section>
  );
}

function FieldErrors({ errors }) {
  if (!errors?.length) return null;
  return errors.map((error) => (
    <div className="text-danger small mt-2" key={error}>{error}</div>
  ));
}
