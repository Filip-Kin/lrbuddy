/** Saves text as a file through a temporary link. */
export const downloadText = (filename: string, text: string, type = "text/csv;charset=utf-8"): void => {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

/** "demo-2026" from "Demo 2026". */
export const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "event";
