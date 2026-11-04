import { useState } from "react";
import ImagePreviewDialog from "./ImagePreviewDialog.jsx";

function PhotoGroup({ images, label, onOpen }) {
  return <div className="task-photo-group">
    <div className="small fw-semibold mb-2">{label} ({images.length})</div>
    <div className="task-photo-gallery">
      {images.map((image, index) => image.url ? <button type="button" className="task-photo-open" key={image.id}
        aria-label={`Open ${label} photo ${index + 1}: ${image.original_name}`}
        onClick={() => onOpen(images.map((item, itemIndex) => ({ ...item, label: `${label} photo ${itemIndex + 1}` })), index)}>
        <img className="task-photo-thumbnail" src={image.thumbnail_url || image.url} alt={`${label} photo ${index + 1}: ${image.original_name}`} loading="lazy" decoding="async" width="88" height="88" />
      </button> : <span key={image.id} className="small text-secondary">Photo unavailable</span>)}
    </div>
  </div>;
}

export default function TaskPhotos({ task, emptyLabel = false }) {
  const [preview, setPreview] = useState(null);
  const before = task.assignment_images || [];
  const after = task.completion_images || [];
  if (!before.length && !after.length) return emptyLabel ? <span className="text-secondary small">No photos</span> : null;
  const open = (images, index) => setPreview({ images, index });
  return <>
    <div className="task-photos mt-3">
      {before.length > 0 && <PhotoGroup images={before} label="Before" onOpen={open} />}
      {after.length > 0 && <PhotoGroup images={after} label="After" onOpen={open} />}
      {before.length > 0 && !after.length && <div className="small text-secondary">After photos awaiting upload.</div>}
    </div>
    {preview && <ImagePreviewDialog images={preview.images} initialIndex={preview.index} onClose={() => setPreview(null)} />}
  </>;
}
