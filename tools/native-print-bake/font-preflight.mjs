// Font preflight for the unattended print pipeline (§3.5 of the spec).
//
// referencedFonts(contract) — returns all font family names referenced in a
// contract (from text paint nodes: font.family and rich-run fontFamily).
//
// checkFontAvailability(families, availableSet) — given a Set of available
// font family names on the host, returns the subset of `families` that are
// missing.  Callers supply the OS font list; this module stays cross-platform.
//
// The OS-specific enumeration (fontconfig/fc-list on Linux, Win32 EnumFonts
// on Windows) is left to the caller — the Windows service uses the host's
// font registry, the Linux CI build passes an explicit allowlist for testing.

// Extract all font family names referenced in a contract.
export function referencedFonts(contract) {
  const families = new Set();
  const doc = contract && contract.document;
  if (!doc || !Array.isArray(doc.pages)) return families;
  for (const page of doc.pages) {
    for (const node of (page.paint || [])) {
      if (node.kind !== 'text') continue;
      if (node.font && node.font.family) {
        families.add(node.font.family);
      }
      const content = node.content;
      if (content && content.type === 'rich' && Array.isArray(content.paragraphs)) {
        for (const para of content.paragraphs) {
          for (const run of (para.runs || [])) {
            if (run.fontFamily) families.add(run.fontFamily);
          }
        }
      }
    }
  }
  return families;
}

// Return the subset of `families` not present in `availableSet`.
// D5/D3: missing face → fail loudly in unattended mode.
export function checkFontAvailability(families, availableSet) {
  const missing = new Set();
  for (const f of families) {
    if (!availableSet.has(f)) missing.add(f);
  }
  return missing;
}

// Throw a typed error if any referenced font is missing from availableSet.
// Used by the unattended service to enforce D3 preflight before printing.
export function assertFontsAvailable(contract, availableSet) {
  const families = referencedFonts(contract);
  const missing = checkFontAvailability(families, availableSet);
  if (missing.size > 0) {
    const err = new Error(
      `font preflight failed: missing face(s): ${[...missing].join(', ')}`);
    err.code = 'MISSING_FONTS';
    err.missingFonts = [...missing];
    throw err;
  }
}
