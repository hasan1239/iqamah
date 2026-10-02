// In-memory handoff from the Add wizard to the Update wizard, used when an
// Add submission turns out to be an existing masjid. Carries the uploaded
// image and the reviewed extraction so the user doesn't re-extract.
// Memory only (SPA navigation keeps modules alive); a reload drops it.

let pending = null;

export function setUploadHandoff(slug, imageDataUrl, extractedData) {
  pending = { slug, imageDataUrl, extractedData };
}

// Returns the handoff for this slug (once), or null. Always clears it, so a
// handoff for a different masjid (or one whose render failed) can't linger
// and resurface on a later visit.
export function takeUploadHandoff(slug) {
  const h = pending;
  pending = null;
  return h && h.slug === slug ? h : null;
}
