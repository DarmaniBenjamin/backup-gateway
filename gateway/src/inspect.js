// Looks at the real content of each new file version (the gateway decrypts it anyway to verify
// its SHA-256) and lists anything that looks like ransomware damage.
//
// Signals:
//   became-random     the file was normal data before and is now pure randomness (encrypted in place)
//   random-text       a text-type file (.txt, .csv, .json...) that is pure randomness
//   type-mismatch     the content doesn't match the extension (a .pdf that doesn't start with %PDF)
//   ransom-extension  names like report.docx.locked / .encrypted / .crypt
//   ransom-note       names like HOW_TO_DECRYPT.txt / README_RESTORE_FILES.html

const MIN_SIZE_FOR_ENTROPY = 256; // smaller files are too short to judge randomness reliably

// What the first bytes of common file types must look like
const SIGNATURES = {
  pdf: [[0x25, 0x50, 0x44, 0x46]], // %PDF
  zip: [[0x50, 0x4b, 0x03, 0x04], [0x50, 0x4b, 0x05, 0x06]], // PK.. (also empty zip)
  png: [[0x89, 0x50, 0x4e, 0x47]],
  jpg: [[0xff, 0xd8, 0xff]],
  gif: [[0x47, 0x49, 0x46, 0x38]],
  ole: [[0xd0, 0xcf, 0x11, 0xe0]], // old Office: .doc .xls .ppt .msg
  rar: [[0x52, 0x61, 0x72, 0x21]],
  "7z": [[0x37, 0x7a, 0xbc, 0xaf]],
  gz: [[0x1f, 0x8b]],
};
const EXTENSION_TYPE = {
  pdf: "pdf",
  docx: "zip", xlsx: "zip", pptx: "zip", docm: "zip", xlsm: "zip", odt: "zip", ods: "zip", zip: "zip", jar: "zip",
  png: "png",
  jpg: "jpg", jpeg: "jpg",
  gif: "gif",
  doc: "ole", xls: "ole", ppt: "ole", msg: "ole",
  rar: "rar",
  "7z": "7z",
  gz: "gz", tgz: "gz",
};

// File types that are normally readable text, never random
const TEXT_EXTENSIONS = new Set([
  "txt", "csv", "tsv", "log", "md", "json", "xml", "html", "htm", "rtf", "ini", "cfg", "conf",
  "yml", "yaml", "sql", "js", "ts", "py", "php", "css", "bat", "ps1", "sh", "vcf", "ics", "eml",
]);

const RANSOM_EXTENSIONS = new Set([
  "locked", "lock", "encrypted", "enc", "crypt", "crypted", "crypto", "cry", "crypz", "cerber",
  "locky", "zepto", "wnry", "wncry", "wcry", "onion", "ryuk", "lockbit", "conti", "phobos",
  "ransom", "pays", "rdm", "kraken", "darkness", "nochance", "micro", "xxx", "ttt", "vvv",
]);
const RANSOM_NOTE_PATTERNS = [
  /how[_\-\s]?to[_\-\s]?(decrypt|restore|recover)/i,
  /(decrypt|restore|recover)[_\-\s]?(my|your|all)?[_\-\s]?files/i,
  /readme.*(decrypt|restore|recover|unlock)/i,
  /(ransom|payment)[_\-\s]?(note|instructions)/i,
  /!!!.*(read|important).*!!!/i,
];

function extensionOf(relPath) {
  const name = relPath.split("/").pop();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

// Shannon entropy in bits per byte: ~4 for text, ~8 for random/encrypted data
export function entropyOf(histogram, size) {
  if (!size) return 0;
  let h = 0;
  for (const count of histogram) {
    if (!count) continue;
    const p = count / size;
    h -= p * Math.log2(p);
  }
  return h;
}

// How random a file of this size can look, minus a safety margin (small samples score lower)
function randomThreshold(size) {
  return Math.min(8, 8 - 255 / (2 * size * Math.LN2)) - 0.25;
}

/**
 * header       first bytes of the file (at least 8 if the file is that big)
 * histogram    count of each byte value 0-255 across the whole file
 * previous     the last good version of the same file, or null ({ entropy })
 */
export function inspectFile({ relPath, size, header, histogram, previous }) {
  const reasons = [];
  const name = relPath.split("/").pop();
  const ext = extensionOf(relPath);
  const entropy = entropyOf(histogram, size);
  const looksRandom = size >= MIN_SIZE_FOR_ENTROPY && entropy >= randomThreshold(size);

  if (RANSOM_EXTENSIONS.has(ext)) reasons.push("ransom-extension");
  if (RANSOM_NOTE_PATTERNS.some((re) => re.test(name))) reasons.push("ransom-note");

  const type = EXTENSION_TYPE[ext];
  if (type && size >= 8) {
    const ok = SIGNATURES[type].some((sig) => sig.every((byte, i) => header[i] === byte));
    if (!ok) reasons.push("type-mismatch");
  }

  if (looksRandom && TEXT_EXTENSIONS.has(ext)) reasons.push("random-text");
  if (looksRandom && previous?.entropy != null && previous.entropy < 7.0) reasons.push("became-random");

  return { entropy: Math.round(entropy * 1000) / 1000, reasons };
}

// What a file really is, judged from its content (not its name). Used by the Inspect panel.
const TYPE_LABEL = {
  pdf: "PDF document",
  zip: "ZIP container (Word, Excel, PowerPoint or .zip)",
  png: "PNG image",
  jpg: "JPEG image",
  gif: "GIF image",
  ole: "Old Office document (.doc, .xls, .ppt, .msg)",
  rar: "RAR archive",
  "7z": "7-Zip archive",
  gz: "Gzip archive",
};

export function describeContent(sample, totalSize) {
  if (!sample.length) return "Empty file";
  for (const [type, sigs] of Object.entries(SIGNATURES)) {
    if (sigs.some((sig) => sig.every((byte, i) => sample[i] === byte))) return TYPE_LABEL[type];
  }
  const histogram = new Array(256).fill(0);
  for (const b of sample) histogram[b]++;
  const size = sample.length;
  if (size >= MIN_SIZE_FOR_ENTROPY && entropyOf(histogram, size) >= randomThreshold(size)) {
    return "Random-looking data (encrypted or compressed)";
  }
  if (isText(sample)) return "Plain text";
  return totalSize > 0 ? "Binary data (unknown type)" : "Empty file";
}

// Readable text: valid UTF-8 with almost no control characters
export function isText(sample) {
  // The sample may end in the middle of a multi-byte character, so allow up to 3 bytes to be cut off
  let text = null;
  for (let cut = 0; cut <= 3 && text === null; cut++) {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(sample.subarray(0, sample.length - cut));
    } catch {
      text = null;
    }
  }
  if (text === null) return false;
  if (!text.length) return true;
  let control = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c < 32 && c !== 9 && c !== 10 && c !== 13) control++;
  }
  return control / text.length < 0.02;
}

export const REASON_TEXT = {
  "ransom-extension": "Renamed with a ransomware extension",
  "ransom-note": "Looks like a ransom note",
  "type-mismatch": "Content doesn't match the file type",
  "random-text": "Text file turned into random data",
  "became-random": "File turned into random data",
  "device-frozen": "Device was frozen when this arrived",
  "mass-delete": "Part of a mass deletion",
};