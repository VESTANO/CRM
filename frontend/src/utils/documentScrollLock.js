// All CRM overlays share one owner set. Bootstrap's drawer is configured with
// scroll:true so it cannot save/restore a second, conflicting body snapshot.
const owners = new Set();
let originalPadding;

function visibleOverlay() {
  return document.querySelector('.offcanvas.show,.offcanvas.showing,.offcanvas.hiding,.modal.show,.modal.d-block,dialog[open]');
}

export function recoverOrphanedScrollLock() {
  if (owners.size || visibleOverlay()) return false;
  const body = document.body;
  // Recover the exact orphaned Bootstrap/legacy state observed on the mobile
  // dashboard. Never unlock an active drawer, native dialog or CRM modal.
  if (body.style.overflow !== 'hidden' && !body.classList.contains('crm-dialog-open')) return false;
  const priorOverflow = body.getAttribute('data-bs-overflow');
  const priorPadding = body.getAttribute('data-bs-padding-right');
  body.style.overflow = priorOverflow && priorOverflow !== 'hidden' ? priorOverflow : '';
  body.style.paddingRight = priorPadding || '';
  body.removeAttribute('data-bs-overflow');
  body.removeAttribute('data-bs-padding-right');
  body.classList.remove('crm-dialog-open');
  return true;
}

export function lockDocumentScroll() {
  if (!owners.size) {
    recoverOrphanedScrollLock();
    const body = document.body;
    originalPadding = body.style.paddingRight;
    const gutter = Math.max(0, window.innerWidth - document.documentElement.clientWidth);
    const padding = parseFloat(getComputedStyle(body).paddingRight) || 0;
    body.classList.add('crm-dialog-open');
    if (gutter) body.style.paddingRight = `${padding + gutter}px`;
  }
  const owner = {};
  owners.add(owner);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    owners.delete(owner);
    if (!owners.size) {
      document.body.classList.remove('crm-dialog-open');
      document.body.style.paddingRight = originalPadding || '';
      originalPadding = undefined;
    }
  };
}
