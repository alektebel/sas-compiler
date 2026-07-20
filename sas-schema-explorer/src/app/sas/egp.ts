/**
 * .egp reader — SAS Enterprise Guide project files are ZIP archives whose
 * entries include `project.xml` plus the embedded SAS programs (usually
 * `<guid>/code.sas` entries). Everything runs in the browser; the file
 * never leaves the user's machine.
 */

import JSZip from 'jszip';
import { SourceFile } from './schema';

function decode(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes);
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes);
  }
  const utf8 = new TextDecoder('utf-8').decode(bytes);
  // mojibake heuristic: fall back to windows-1252 when utf-8 breaks
  if (utf8.includes('�')) {
    return new TextDecoder('windows-1252').decode(bytes);
  }
  return utf8;
}

/** Map zip-entry directory GUIDs to human labels via project.xml, best effort. */
function labelMap(projectXml: string): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const doc = new DOMParser().parseFromString(projectXml, 'text/xml');
    for (const el of Array.from(doc.getElementsByTagName('Element'))) {
      const label = el.getElementsByTagName('Label')[0]?.textContent?.trim();
      const id = el.getElementsByTagName('ID')[0]?.textContent?.trim();
      if (label && id) map.set(id.toLowerCase(), label);
    }
  } catch {
    /* best effort only */
  }
  return map;
}

export async function readEgp(file: File): Promise<SourceFile[]> {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const out: SourceFile[] = [];

  let labels = new Map<string, string>();
  const projEntry = Object.keys(zip.files).find((n) => /(^|\/)project\.xml$/i.test(n));
  if (projEntry) {
    labels = labelMap(decode(await zip.files[projEntry].async('uint8array')));
  }

  const sasEntries = Object.keys(zip.files).filter(
    (n) => /\.sas$/i.test(n) && !zip.files[n].dir,
  );
  for (const name of sasEntries.sort()) {
    const content = decode(await zip.files[name].async('uint8array'));
    const dir = name.includes('/') ? name.split('/')[0].toLowerCase() : '';
    const label = labels.get(dir);
    out.push({
      name: `${file.name} › ${label ?? name.split('/').pop() ?? name}`,
      content,
      origin: 'egp',
    });
  }

  // Older EGP versions store code in .txt or extension-less entries; if the
  // archive had no .sas at all, keep anything that looks like SAS code.
  if (!out.length) {
    for (const name of Object.keys(zip.files)) {
      const e = zip.files[name];
      if (e.dir || /\.(xml|png|jpg|gif|sas7bdat|log|lst)$/i.test(name)) continue;
      const content = decode(await e.async('uint8array'));
      if (/\b(data\s+[\w.]+\s*;|proc\s+\w+)/i.test(content)) {
        out.push({ name: `${file.name} › ${name.split('/').pop() ?? name}`, content, origin: 'egp' });
      }
    }
  }
  return out;
}
