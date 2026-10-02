import { constants, closeSync, fchmodSync, lstatSync, openSync, writeFileSync } from "node:fs";
import { preparePrivateDirectory } from "./private-directory.mjs";
import { basename, isAbsolute, join } from "node:path";
import { deflateRawSync } from "node:zlib";

// Small, fixed-schema OOXML exporter for this distributable Node application.
// It does not import templates, execute Office automation, evaluate user formulas,
// follow links, or download resources. It has no native or runtime dependencies.
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const SHEET = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
export const OFFICE_MIME_TYPES = Object.freeze({
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
});
export const OFFICE_ARTIFACT_LIMITS = Object.freeze({ rows: 500, text: 50000, list: 50, payload: 1000000 });
const statuses = ["待确认", "未开始", "进行中", "受阻", "已完成", "已取消"];
const priorities = ["待确认", "高", "中", "低"];
const statusAliases = { pending: "未开始", in_progress: "进行中", blocked: "受阻", completed: "已完成", cancelled: "已取消" };
const priorityAliases = { high: "高", medium: "中", low: "低" };
const invalidXml = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function text(value, field, limit = 1000, fallback = "") {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string" || value.length > limit || invalidXml.test(value)) throw new Error(`${field}须为有效文本且不超过${limit}字符`);
  return value.replace(/\r\n?/g, "\n");
}
function list(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > OFFICE_ARTIFACT_LIMITS.list) throw new Error(`${field}最多${OFFICE_ARTIFACT_LIMITS.list}项`);
  return value.map((entry) => text(entry, field, 2000));
}
function date(value, field) {
  const result = text(value, field, 10);
  if (!result) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || result < "1900-01-01" || result > "9999-12-31" || !Number.isFinite(Date.parse(`${result}T00:00:00Z`)) || new Date(`${result}T00:00:00Z`).toISOString().slice(0, 10) !== result) throw new Error(`${field}须为真实日期 YYYY-MM-DD`);
  return result;
}

/** Validate and normalize the shared DOCX/XLSX schema. Missing facts remain explicit. */
export function normalizeOfficeData(input = {}) {
  if (!plain(input)) throw new Error("办公文档数据须为对象");
  if (input.demo !== undefined && typeof input.demo !== "boolean") throw new Error("demo须为布尔值");
  const rows = input.rows ?? [];
  if (!Array.isArray(rows) || rows.length > OFFICE_ARTIFACT_LIMITS.rows) throw new Error(`任务清单最多${OFFICE_ARTIFACT_LIMITS.rows}行`);
  const seen = new Set();
  const data = {
    title: text(input.title, "标题", 120, "公路养护工作周报"),
    period: text(input.period, "报告周期", 120, "待确认"),
    organization: text(input.organization, "编报单位", 120, "待确认"),
    author: text(input.author, "编制人", 120, "待确认"),
    summary: text(input.summary, "工作摘要", OFFICE_ARTIFACT_LIMITS.text),
    demo: input.demo ?? false,
    rows: rows.map((row, i) => {
      if (!plain(row)) throw new Error(`第${i + 1}行须为对象`);
      const id = text(row.id, "任务编号", 64, `T-${String(i + 1).padStart(3, "0")}`);
      if (seen.has(id)) throw new Error(`任务编号重复：${id}`);
      seen.add(id);
      const task = text(row.task, "任务内容", 500);
      if (!task.trim()) throw new Error(`第${i + 1}行缺少任务内容`);
      let status = text(row.status, "任务状态", 30, "待确认");
      let priority = text(row.priority, "优先级", 30, "待确认");
      status = Object.hasOwn(statusAliases, status) ? statusAliases[status] : status;
      priority = Object.hasOwn(priorityAliases, priority) ? priorityAliases[priority] : priority;
      if (!statuses.includes(status)) throw new Error(`任务状态须为${statuses.join("、")}`);
      if (!priorities.includes(priority)) throw new Error(`优先级须为${priorities.join("、")}`);
      return {
        id, task,
        location: text(row.location, "路段或桩号", 200, "待确认"),
        owner: text(row.owner, "责任人", 120, "待确认"),
        dueDate: date(row.dueDate, "截止日期"),
        status, priority,
        notes: text(row.notes, "备注", 2000),
        source: text(row.source, "任务来源", 1000, "未提供"),
      };
    }),
    risks: list(input.risks, "风险事项"),
    nextSteps: list(input.nextSteps, "下一步安排"),
    sources: list(input.sources, "材料来源"),
  };
  if (Buffer.byteLength(JSON.stringify(data), "utf8") > OFFICE_ARTIFACT_LIMITS.payload) throw new Error("办公文档数据总量超出限制");
  return data;
}

const escapeXml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
const relationships = (items) => XML + `<Relationships xmlns="${REL}">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`).join("")}</Relationships>`;
const contentTypes = (overrides) => XML + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides.map(([part, type]) => `<Override PartName="/${part}" ContentType="${type}"/>`).join("")}</Types>`;
const coreProperties = (title) => XML + `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${escapeXml(title)}</dc:title><dc:creator>路衡办公智能体</dc:creator><dc:description>本地生成的可编辑办公文档 请在对外使用前人工核实</dc:description></cp:coreProperties>`;

// Standard ZIP32 (DEFLATE + CRC32). Archive names are only fixed constants below;
// source text cannot become filenames, relationships, XML tags, or attributes.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(parts) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, xml] of Object.entries(parts)) {
    const filename = Buffer.from(name), bytes = Buffer.from(xml), compressed = deflateRawSync(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8); header.writeUInt16LE(33, 12);
    header.writeUInt32LE(crc32(bytes), 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4);
    header.copy(directory, 6, 4, 28); directory.writeUInt32LE(offset, 42);
    local.push(header, filename, compressed); central.push(directory, filename);
    offset += header.length + filename.length + compressed.length;
  }
  const directoryBytes = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directoryBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directoryBytes, end]);
}

function paragraph(value, style = "Normal", runProperties = "", properties = "") {
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/>${properties}</w:pPr><w:r>${runProperties ? `<w:rPr>${runProperties}</w:rPr>` : ""}${String(value).split("\n").map((line, i) => `${i ? "<w:br/>" : ""}<w:t xml:space="preserve">${escapeXml(line)}</w:t>`).join("")}</w:r></w:p>`;
}
const heading = (value) => paragraph(value, "Heading1");
function docxTable(rows) {
  const widths = [800, 3780, 1000, 1200, 1540];
  const borders = ["top", "left", "bottom", "right", "insideH", "insideV"].map((side) => `<w:${side} w:val="single" w:sz="4" w:color="D9D9D9"/>`).join("");
  const cells = (values, index) => `<w:tr>${index === 0 ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}${values.map((value, i) => `<w:tc><w:tcPr><w:tcW w:w="${widths[i]}" w:type="dxa"/><w:shd w:fill="${index === 0 ? "E5EBF2" : index % 2 === 0 ? "F5F7FA" : "FFFFFF"}"/><w:vAlign w:val="center"/></w:tcPr>${paragraph(value, "TableText", index === 0 ? "<w:b/>" : "", i === 1 ? "" : '<w:jc w:val="center"/>')}</w:tc>`).join("")}</w:tr>`;
  return `<w:tbl><w:tblPr><w:tblW w:w="8320" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders>${borders}</w:tblBorders><w:tblCellMar><w:top w:w="100" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${widths.map(w => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>${cells(["编号", "任务与位置", "状态", "责任人", "截止日期"], 0)}${rows.map((row, i) => cells([row.id, `${row.task}\n位置：${row.location}\n优先级：${row.priority}${row.notes ? `\n备注：${row.notes}` : ""}\n来源：${row.source}`, row.status, row.owner, row.dueDate || "待确认"], i + 1)).join("")}</w:tbl>`;
}
const wordStyles = XML + `<w:styles xmlns:w="${WORD}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Noto Sans CJK SC"/><w:color w:val="000000"/><w:sz w:val="22"/><w:lang w:val="zh-CN" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:after="220"/></w:pPr><w:rPr><w:b/><w:color w:val="000000"/><w:sz w:val="36"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="220" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="000000"/><w:sz w:val="26"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="TableText"><w:name w:val="Table Text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="40" w:line="260" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="19"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Meta"><w:name w:val="Metadata"/><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="20"/></w:rPr></w:style></w:styles>`;

/** Return a macro-free, self-contained .docx Buffer. No filesystem/network effects. */
export function generateWeeklyReport(input = {}) {
  const d = normalizeOfficeData(input);
  const completed = d.rows.filter(row => row.status === "已完成").length;
  const body = [
    paragraph(d.title, "Title"),
    paragraph(`报告周期：${d.period}\n编报单位：${d.organization}    编制人：${d.author}`, "Meta"),
    ...(d.demo ? [paragraph("虚构演示数据 仅供软件功能验证 不可用于业务判断", "Normal", "<w:b/>")] : []),
    heading("一 工作概况"),
    paragraph(d.summary || "未提供工作摘要。请核实原始台账后补充，不应据此推定本期无工作事项。"),
    paragraph(`本清单共${d.rows.length}项，其中已完成${completed}项。状态、责任人与截止日期以逐项核验后的台账为准。`),
    heading("二 任务清单"),
    d.rows.length ? docxTable(d.rows) : paragraph("未提供结构化任务。请补充任务内容、责任人、截止日期、状态与依据。"),
    heading("三 风险与待协调事项"),
    ...(d.risks.length ? d.risks.map((value, i) => paragraph(`${i + 1}. ${value}`)) : [paragraph("未提供风险说明，不能据此认定不存在风险。")]),
    heading("四 下一步安排"),
    ...(d.nextSteps.length ? d.nextSteps.map((value, i) => paragraph(`${i + 1}. ${value}`)) : [paragraph("待经办人确认具体安排、责任人与完成时间。")]),
    heading("五 材料来源与核验"),
    ...(d.sources.length ? d.sources.map((value, i) => paragraph(`${i + 1}. ${value}`)) : [paragraph("未提供报告级材料来源，逐项依据见任务清单；请在使用前补齐并核验。")]),
    paragraph("使用说明：本文件在本地生成，尚未经人工签审。对外发送、上传系统或据此安排作业前，请核实事实、来源及适用的审批要求。", "Meta"),
  ].join("");
  return zip({
    "[Content_Types].xml": contentTypes([["word/document.xml", OFFICE_MIME_TYPES.docx + ".main+xml"], ["word/styles.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"], ["docProps/core.xml", "application/vnd.openxmlformats-package.core-properties+xml"]]),
    "_rels/.rels": relationships([["rId1", `${OFFICE}/officeDocument`, "word/document.xml"], ["rId2", "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties", "docProps/core.xml"]]),
    "docProps/core.xml": coreProperties(d.title),
    "word/document.xml": XML + `<w:document xmlns:w="${WORD}"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1000" w:right="1960" w:bottom="1000" w:left="1960" w:header="450" w:footer="450"/></w:sectPr></w:body></w:document>`,
    "word/_rels/document.xml.rels": relationships([["rId1", `${OFFICE}/styles`, "styles.xml"]]),
    "word/styles.xml": wordStyles,
  });
}

// Supplied text is always inlineStr, including =, +, -, @ and URLs. Only these
// internal count formulas are emitted; user data never enters formula syntax.
const sheetText = (value) => escapeXml(String(value).replace(/_x[\dA-Fa-f]{4}_/g, match => `_x005F_${match.slice(1)}`));
const stringCell = (address, value, style = 0) => `<c r="${address}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${sheetText(value)}</t></is></c>`;
const numberCell = (address, value, style = 0) => `<c r="${address}" s="${style}" t="n"><v>${value}</v></c>`;
const formulaCell = (address, formula, cached) => `<c r="${address}" s="4"><f>${escapeXml(formula)}</f><v>${cached}</v></c>`;
const rowXml = (index, cells, height = 24) => `<row r="${index}" ht="${height}" customHeight="1">${cells.join("")}</row>`;
function excelDate(value) {
  const days = (Date.parse(`${value}T00:00:00Z`) - Date.UTC(1899, 11, 31)) / 86400000;
  return days + (value >= "1900-03-01" ? 1 : 0);
}
function displayLines(value, width) {
  return String(value).split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil([...line].reduce((n, char) => n + (char.codePointAt(0) > 255 ? 2 : 1), 0) / (width - 2))), 0);
}
const columnWidths = [12, 30, 18, 12, 15, 12, 10, 35, 27];
const sheetStyles = XML + `<styleSheet xmlns="${SHEET}"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts><fonts count="4"><font><sz val="11"/><color rgb="FF17212B"/><name val="Arial"/><family val="2"/></font><font><b/><sz val="17"/><color rgb="FF000000"/><name val="Arial"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Arial"/></font><font><b/><sz val="11"/><color rgb="FF17212B"/><name val="Arial"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF24415C"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF2F5F8"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FFD9D9D9"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="8"><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="164" fontId="0" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="2"><dxf><font><color rgb="FF166534"/></font><fill><patternFill patternType="solid"><fgColor rgb="FFDCFCE7"/><bgColor rgb="FFDCFCE7"/></patternFill></fill></dxf><dxf><font><color rgb="FF9F1239"/></font><fill><patternFill patternType="solid"><fgColor rgb="FFFFE4E6"/><bgColor rgb="FFFFE4E6"/></patternFill></fill></dxf></dxfs><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/></styleSheet>`;

/** Return a portable editable .xlsx Buffer with safe typed values and count formulas. */
export function generateTaskWorkbook(input = {}) {
  const d = normalizeOfficeData(input), last = Math.max(9, d.rows.length + 8);
  const done = d.rows.filter(row => row.status === "已完成").length;
  const cancelled = d.rows.filter(row => row.status === "已取消").length;
  const blocked = d.rows.filter(row => row.status === "受阻").length;
  const rows = [
    rowXml(1, [], 12),
    rowXml(2, [stringCell("A2", d.title.replace(/周报$/, "任务清单"), 1)], 34),
    rowXml(3, [stringCell("A3", `周期：${d.period}    单位：${d.organization}    编制：${d.author}${d.demo ? "    虚构演示数据 不可用于业务判断" : ""}`, 3)], 30),
    rowXml(4, [stringCell("A4", "任务总数", 3), formulaCell("B4", `COUNTA(B9:B${last})`, d.rows.length), stringCell("C4", "已完成", 3), formulaCell("D4", `COUNTIFS(F9:F${last},"已完成")`, done), stringCell("E4", "待办理", 3), formulaCell("F4", `B4-D4-COUNTIFS(F9:F${last},"已取消")`, d.rows.length - done - cancelled), stringCell("G4", "受阻", 3), formulaCell("H4", `COUNTIFS(F9:F${last},"受阻")`, blocked)], 28),
    rowXml(5, [stringCell("A5", `统计范围为第9至${last}行；新增任务请扩展公式及筛选范围。状态可用下拉选择，缺失信息须人工补齐。`, 3)], 28),
    rowXml(6, [stringCell("A6", "本地生成 尚未经人工签审；来源文本不自动打开。较长备注可在编辑栏查看，打印前请复核版式。", 3)], 28),
    rowXml(7, [], 12),
    rowXml(8, ["编号", "任务内容", "路段或桩号", "责任人", "截止日期", "状态", "优先级", "备注", "来源"].map((label, i) => stringCell(`${String.fromCharCode(65 + i)}8`, label, 2)), 32),
    ...d.rows.map((row, index) => {
      const r = index + 9, style = index % 2 ? 6 : 0;
      const values = [row.id, row.task, row.location, row.owner, row.dueDate || "待确认", row.status, row.priority, row.notes, row.source];
      const height = Math.min(409, Math.max(32, 16 * Math.max(...values.map((v, i) => displayLines(v, columnWidths[i]))) + 10));
      return rowXml(r, values.map((value, i) => i === 4 && row.dueDate ? numberCell(`E${r}`, excelDate(row.dueDate), index % 2 ? 7 : 5) : stringCell(`${String.fromCharCode(65 + i)}${r}`, value, style)), height);
    }),
    ...(!d.rows.length ? [rowXml(9, Array.from({ length: 9 }, (_, i) => stringCell(`${String.fromCharCode(65 + i)}9`, "")), 32)] : []),
  ];
  // Keep full narrative evidence on the same sheet below the sortable task range.
  const summaryChunks = [];
  for (let offset = 0; offset < d.summary.length;) {
    let end = Math.min(offset + 30000, d.summary.length);
    if (end < d.summary.length && /[\uD800-\uDBFF]/.test(d.summary[end - 1])) end--;
    summaryChunks.push([summaryChunks.length ? "工作摘要 续" : "工作摘要", d.summary.slice(offset, end)]);
    offset = end;
  }
  const context = [
    ...summaryChunks,
    ...d.risks.map((value, i) => [`风险 ${i + 1}`, value]),
    ...d.nextSteps.map((value, i) => [`安排 ${i + 1}`, value]),
    ...d.sources.map((value, i) => [`材料 ${i + 1}`, value]),
  ];
  const merges = ["A2:I2", "A3:I3", "A5:I5", "A6:I6"];
  for (const [i, [label, value]] of context.entries()) {
    const r = last + 3 + i;
    // Excel limits cell text to 32767 UTF-16 code units; summaries are chunked.
    rows.push(rowXml(r, [stringCell(`A${r}`, label, 3), stringCell(`B${r}`, value, 3)], Math.min(409, 18 * displayLines(value, 200) + 12)));
    merges.push(`B${r}:I${r}`);
  }
  const end = context.length ? last + 2 + context.length : last;
  const sheetXml = XML + `<worksheet xmlns="${SHEET}"><sheetPr><tabColor rgb="FF24415C"/><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:I${end}"/><sheetViews><sheetView showGridLines="0" workbookViewId="0"><pane xSplit="2" ySplit="8" topLeftCell="C9" activePane="bottomRight" state="frozen"/><selection pane="bottomRight" activeCell="C9" sqref="C9"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="24"/><cols>${columnWidths.map((width, i) => `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`).join("")}</cols><sheetData>${rows.join("")}</sheetData><autoFilter ref="A8:I${last}"/><mergeCells count="${merges.length}">${merges.map(ref => `<mergeCell ref="${ref}"/>`).join("")}</mergeCells><conditionalFormatting sqref="F9:F${last}"><cfRule type="cellIs" dxfId="0" priority="1" operator="equal"><formula>&quot;已完成&quot;</formula></cfRule><cfRule type="cellIs" dxfId="1" priority="2" operator="equal"><formula>&quot;受阻&quot;</formula></cfRule></conditionalFormatting><dataValidations count="2"><dataValidation type="list" allowBlank="1" showErrorMessage="1" errorStyle="stop" errorTitle="状态无效" error="请选择清单中的状态" sqref="F9:F${last}"><formula1>&quot;${statuses.join(",")}&quot;</formula1></dataValidation><dataValidation type="list" allowBlank="1" showErrorMessage="1" errorStyle="stop" errorTitle="优先级无效" error="请选择清单中的优先级" sqref="G9:G${last}"><formula1>&quot;${priorities.join(",")}&quot;</formula1></dataValidation></dataValidations><printOptions horizontalCentered="1"/><pageMargins left="0.3" right="0.3" top="0.4" bottom="0.4" header="0.2" footer="0.2"/><pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/><headerFooter><oddFooter>&amp;C第 &amp;P 页 共 &amp;N 页</oddFooter></headerFooter></worksheet>`;
  return zip({
    "[Content_Types].xml": contentTypes([["xl/workbook.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"], ["xl/worksheets/sheet1.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"], ["xl/styles.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"], ["docProps/core.xml", "application/vnd.openxmlformats-package.core-properties+xml"]]),
    "_rels/.rels": relationships([["rId1", `${OFFICE}/officeDocument`, "xl/workbook.xml"], ["rId2", "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties", "docProps/core.xml"]]),
    "docProps/core.xml": coreProperties(d.title),
    "xl/workbook.xml": XML + `<workbook xmlns="${SHEET}" xmlns:r="${OFFICE}"><bookViews><workbookView/></bookViews><sheets><sheet name="养护任务清单" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm.Print_Titles" localSheetId="0">'养护任务清单'!$8:$8</definedName><definedName name="_xlnm.Print_Area" localSheetId="0">'养护任务清单'!$A$1:$I$${end}</definedName></definedNames><calcPr calcId="191029" fullCalcOnLoad="1" forceFullCalc="1" calcMode="auto"/></workbook>`,
    "xl/_rels/workbook.xml.rels": relationships([["rId1", `${OFFICE}/worksheet`, "worksheets/sheet1.xml"], ["rId2", `${OFFICE}/styles`, "styles.xml"]]),
    "xl/worksheets/sheet1.xml": sheetXml,
    "xl/styles.xml": sheetStyles,
  });
}

/** The directory must be trusted caller configuration, never a model/user path.
 * Reject existing destinations (including symlinks) instead of overwriting.
 * Parent directories must be owned by the host application; this is not a sandbox.
 */
export function saveOfficeArtifact({ directory, filename, format, data } = {}) {
  if (!Object.hasOwn(OFFICE_MIME_TYPES, format)) throw new Error("办公文件格式仅支持docx或xlsx");
  if (typeof directory !== "string" || !isAbsolute(directory)) throw new Error("办公文档目录必须是受信任的绝对路径");
  if (typeof filename !== "string" || !filename || filename.length > 180 || Buffer.byteLength(filename) > 240 || filename !== basename(filename) || /[\\/:*?"<>|\x00-\x1F]/.test(filename) || invalidXml.test(filename) || filename.includes("..") || !filename.endsWith(`.${format}`) || /[. ]$/.test(filename) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(filename)) throw new Error("办公文件名无效或超出工作区范围");
  const bytes = format === "docx" ? generateWeeklyReport(data) : generateTaskWorkbook(data);
  preparePrivateDirectory(directory);
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("办公文档目录不能是符号链接");
  const fd = openSync(join(directory, filename), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
  try {
    // Windows files inherit the verified private directory DACL. chmod only
    // changes the DOS read-only flag there and cannot enforce per-user access.
    if (process.platform !== "win32") fchmodSync(fd, 0o600);
    writeFileSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
  return { filename, name: filename, mimeType: OFFICE_MIME_TYPES[format], size: bytes.length };
}
