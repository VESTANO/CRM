import { useEffect, useId, useRef, useState } from "react";
import { addTaskImages, MAX_TASK_IMAGES, TASK_IMAGE_TYPES } from "../utils/taskImages.js";
import { formatPhotoBytes, optimizePhoto, photoSourceKey } from "../utils/photoCompression.js";

function PhotoPreview({ file }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const preview = URL.createObjectURL(file.thumbnail || file);
    setUrl(preview);
    return () => URL.revokeObjectURL(preview);
  }, [file]);
  return url ? <img src={url} alt={`Selected photo: ${file.name}`} className="task-photo-thumbnail" /> : null;
}

export default function TaskImagePicker({ label, files, onChange, existingCount = 0, disabled = false, onBusyChange }) {
  const id = useId();
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const operation = useRef(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; operation.current?.abort(); onBusyChange?.(false); };
  }, [onBusyChange]);
  const busy = Boolean(progress);
  const remaining = Math.max(0, MAX_TASK_IMAGES - existingCount - files.length);
  const select = async (event) => {
    const selected = Array.from(event.target.files || []);
    event.target.value = "";
    if (!selected.length) return;
    const controller = new AbortController();
    operation.current = controller;
    onBusyChange?.(true);
    try {
      const combined = addTaskImages(files, selected, existingCount);
      const additions = combined.filter((file) => !files.some((existing) => photoSourceKey(existing) === photoSourceKey(file)));
      const prepared = [];
      setError("");
      for (let index = 0; index < additions.length; index++) {
        setProgress(`Compressing photo ${index + 1} of ${additions.length}...`);
        prepared.push(await optimizePhoto(additions[index], { signal: controller.signal }));
      }
      if (mounted.current && !controller.signal.aborted) onChange([...files, ...prepared]);
    } catch (selectionError) { if (mounted.current && selectionError.name !== "AbortError") setError(selectionError.message); }
    finally { if (mounted.current) { setProgress(""); onBusyChange?.(false); } operation.current = null; }
  };
  return <div className="task-photo-picker">
    <label className="form-label" htmlFor={id}>{label}</label>
    <input id={id} className="form-control" type="file" multiple accept={TASK_IMAGE_TYPES.join(",")}
      onChange={select} disabled={disabled || busy || remaining === 0} aria-describedby={`${id}-help`} />
    <div id={`${id}-help`} className="form-text">Up to 10 photos. Originals up to 100 MB are compressed automatically before upload. {existingCount + files.length > 0 && `${remaining} more available.`}</div>
    {busy && <div className="small mt-2" role="status">{progress} <button type="button" className="btn btn-link btn-sm p-0 ms-2" onClick={() => operation.current?.abort()}>Cancel preparation</button></div>}
    {error && <div className="text-danger small mt-2" role="alert">{error}</div>}
    {files.length > 0 && <ul className="task-photo-selection list-unstyled mt-3 mb-0">
      {files.map((file, index) => <li key={`${file.name}-${file.size}-${file.lastModified}`}>
        <PhotoPreview file={file} />
        <span className="small task-photo-filename" title={file.name}>{file.name}</span>
        {file.originalSize && <span className="text-secondary small">{formatPhotoBytes(file.originalSize)} → {formatPhotoBytes(file.size)}</span>}
        <button type="button" className="btn btn-outline-danger btn-sm" disabled={disabled || busy}
          aria-label={`Remove ${file.name}`} onClick={() => { onChange(files.filter((_, item) => item !== index)); setError(""); }}>Remove</button>
      </li>)}
    </ul>}
  </div>;
}
