/**
 * Parsed representation of a single arXiv Atom feed <entry>, after
 * whitespace normalization and safe field extraction. This is the app's
 * internal shape — never expose the raw parsed XML/attributes to the UI.
 */
export interface ArxivEntry {
  /** arXiv identifier, e.g. "2401.12345" (version suffix stripped). */
  id: string;
  title: string;
  summary: string;
  /** ISO 8601 timestamp of initial submission. */
  published: string;
  /** ISO 8601 timestamp of the most recent revision. */
  updated: string;
  authors: string[];
  categories: string[];
  primaryCategory?: string;
  /** Direct PDF download link, when arXiv provides one. */
  pdfUrl?: string;
  /** Human-readable abstract page, e.g. https://arxiv.org/abs/2401.12345 */
  abstractUrl: string;
}
