import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

export default function ImagePreviewDialog({ images, initialIndex = 0, onClose }) {
  const dialog = useRef(null);
  const titleId = useId();
  const [index, setIndex] = useState(initialIndex);
  const [failed, setFailed] = useState(false);
  const photo = images[index];
  useEffect(() => {
    const previouslyFocused = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const modal = dialog.current;
    modal.showModal();
    return () => {
      modal.close();
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);
  useEffect(() => { setFailed(false); }, [index]);
  return createPortal(<dialog ref={dialog} className="task-image-modal" aria-labelledby={titleId}
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="task-image-modal-content">
      <div className="task-image-modal-header">
        <div id={titleId} className="fw-semibold text-break">{photo.label}: {photo.original_name}</div>
        <button type="button" className="btn-close flex-shrink-0" aria-label="Close image preview" onClick={onClose} autoFocus />
      </div>
      {failed ? <div className="alert alert-warning m-3">Unable to load this image. Close the popup and try opening it again.</div>
        : <img className="task-image-full" src={photo.url} alt={`${photo.label}: ${photo.original_name}`} onError={() => setFailed(true)} />}
      {images.length > 1 && <div className="task-image-modal-footer">
        <button type="button" className="btn btn-outline-secondary btn-sm" disabled={index === 0} onClick={() => setIndex(index - 1)}>Previous image</button>
        <span className="small text-secondary">{index + 1} / {images.length}</span>
        <button type="button" className="btn btn-outline-secondary btn-sm" disabled={index === images.length - 1} onClick={() => setIndex(index + 1)}>Next image</button>
      </div>}
    </div>
  </dialog>, document.body);
}
