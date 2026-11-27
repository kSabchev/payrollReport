// Четене на .xlsx без допълнителни пакети: zip архив с XML файлове.
// readWorkbook(buffer) -> [{ name, rows: Map(номер на ред -> { "A": стойност, … }) }]
// Стойностите са числа или текст. При формула се взема изчислената стойност, записана във файла.
const zlib = require("zlib");

const MAX_ENTRY = 50 * 1024 * 1024; // защита от „zip бомба“

// Файловете в архива по централната директория
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Файлът не е .xlsx (Excel 2007 или по-нов)");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("Повреден .xlsx файл");
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    entries.set(name, { method, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return (name) => {
    const e = entries.get(name);
    if (!e) return null;
    const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
    const data = buf.subarray(start, start + e.size);
    if (e.method === 0) return data.toString("utf8");
    if (e.method !== 8) throw new Error("Неподдържано компресиране в .xlsx файла");
    return zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY }).toString("utf8");
  };
}

const unxml = (s) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[\da-f]+);/gi, (_, e) =>
  ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" }[e.toLowerCase()]
    ?? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1)))));

// Текстът от <t> елементите (и при форматиран текст на части)
const texts = (s) => [...s.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)].map((m) => unxml(m[1] || "")).join("");
const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

function readWorkbook(buf) {
  const read = unzip(buf);
  const wb = read("xl/workbook.xml");
  if (!wb) throw new Error("Файлът не е Excel таблица");
  const rels = new Map([...(read("xl/_rels/workbook.xml.rels") || "").matchAll(/<Relationship\b[^>]*>/g)]
    .map(([t]) => [attr(t, "Id"), attr(t, "Target")]));
  const shared = [...(read("xl/sharedStrings.xml") || "").matchAll(/<si>([\s\S]*?)<\/si>/g)]
    // без фонетичните подсказки (<rPh>)
    .map((m) => texts(m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, "")));

  return [...wb.matchAll(/<sheet\b[^>]*>/g)].map(([tag]) => {
    let target = rels.get(attr(tag, "r:id")) || "";
    target = target.startsWith("/") ? target.slice(1) : "xl/" + target.replace(/^\.\//, "");
    const xml = read(target) || "";
    const rows = new Map();
    for (const [, rowAttrs, body] of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const r = Number(attr(rowAttrs, "r"));
      const cells = {};
      for (const [, cAttrs, inner = ""] of (body || "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = attr(cAttrs, "r"), type = attr(cAttrs, "t");
        if (!ref) continue;
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        let value;
        if (type === "s") value = shared[Number(v)];
        else if (type === "inlineStr") value = texts(inner);
        else if (type === "str" || type === "e") value = v == null ? undefined : unxml(v);
        else if (type === "b") value = v === "1";
        else value = v == null ? undefined : Number(v);
        if (value === undefined || value === "") continue;
        cells[ref.replace(/\d+$/, "")] = value;
      }
      if (Object.keys(cells).length) rows.set(r, cells);
    }
    return { name: unxml(attr(tag, "name") || ""), rows };
  });
}

// "A" -> 0, "AA" -> 26
const colIndex = (c) => [...c].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

module.exports = { readWorkbook, colIndex };
