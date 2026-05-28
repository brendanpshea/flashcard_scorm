#!/usr/bin/env node
// Build a SCORM 2004 zip package.
// Usage: node build.js --deck decks/sample-logic/cards.json \
//                      --settings decks/sample-logic/settings-5week.json \
//                      --out dist/phil101-summer.zip

const fs = require("fs");
const path = require("path");

function arg(flag, def) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? def : process.argv[i + 1];
}

const deckPath = arg("--deck");
const settingsPath = arg("--settings");
const outPath = arg("--out", "dist/package.zip");
const previewDir = arg("--preview");

if (!deckPath || !settingsPath) {
  console.error("Usage: node build.js --deck <cards.json> --settings <settings.json> --out <zip> [--preview <dir>]");
  process.exit(1);
}

const root = __dirname;
const runtimeDir = path.join(root, "runtime");
const manifestSrc = path.join(root, "manifest-template", "imsmanifest.xml");

const deck = JSON.parse(fs.readFileSync(deckPath, "utf8"));
const deckTitle = deck.deck?.title || "Flashcards";
const deckId = deck.deck?.id || "deck";
const manifestId = `MAN-${deckId}-${Date.now()}`;

const manifest = fs.readFileSync(manifestSrc, "utf8")
  .replace(/\{\{MANIFEST_ID\}\}/g, manifestId)
  .replace(/\{\{DECK_TITLE\}\}/g, escapeXml(deckTitle));

function run() {
  const files = collectFiles();
  if (previewDir) {
    writePreview(previewDir, files);
    console.log(`Preview written to ${previewDir} — open ${path.join(previewDir, "index.html")} in a browser.`);
  } else {
    writeZip(outPath, files);
    console.log(`Built ${outPath} (${files.length} files).`);
  }
}

// --- helpers ---

function collectFiles() {
  const out = [];
  for (const name of fs.readdirSync(runtimeDir)) {
    if (name === "package.json") continue;  // Node-only scoping, not a runtime asset
    out.push({ name, data: fs.readFileSync(path.join(runtimeDir, name)) });
  }
  out.push({ name: "cards.json", data: fs.readFileSync(deckPath) });
  out.push({ name: "class_settings.json", data: fs.readFileSync(settingsPath) });
  out.push({ name: "imsmanifest.xml", data: Buffer.from(manifest, "utf8") });
  return out;
}

function writePreview(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(dir, f.name), f.data);
}

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, c => ({
    "<":"&lt;",">":"&gt;","&":"&amp;","\"":"&quot;","'":"&apos;"
  }[c]));
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Minimal zip writer (store, no compression) so we don't need an npm dep.
function writeZip(outPath, files) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const localParts = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf8");
    const data = f.data;
    const crc = crc32(data);
    const size = data.length;

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version
    local.writeUInt16LE(0, 6);             // flags
    local.writeUInt16LE(0, 8);             // method: store
    local.writeUInt16LE(0, 10);            // time
    local.writeUInt16LE(0, 12);            // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    localParts.push(local, data);

    const cd = Buffer.alloc(46 + nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(size, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    nameBuf.copy(cd, 46);
    central.push(cd);

    offset += local.length + data.length;
  }

  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  fs.writeFileSync(outPath, Buffer.concat([...localParts, cdBuf, end]));
}
run();
