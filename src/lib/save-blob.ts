/**
 * Save a blob under `filename`. The anchor has to be in the document for the
 * synthetic click to count in every browser, and the object URL has to outlive
 * that click — revoking it in the same tick races the download in some of them,
 * so the revoke is deferred to the next task instead.
 */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
