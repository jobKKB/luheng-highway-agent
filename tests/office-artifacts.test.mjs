import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inflateRawSync } from "node:zlib";
import { generateWeeklyReport, generateTaskWorkbook, normalizeOfficeData, saveOfficeArtifact, OFFICE_MIME_TYPES } from "../lib/office-artifacts.mjs";

const sample = () => ({
  title: "青岚高速养护工作周报", period: "2026年9月28日至10月4日", organization: "演示养护组", author: "演示经办人", demo: true,
  summary: "本周巡查发现三项需处理事项。当前一项完成、一项进行中、一项受阻，数量以本清单为准。",
  rows: [
    { id: "DEMO-01", task: "核验并清理排水沟", location: "K18+200", owner: "演示甲", dueDate: "2026-10-02", status: "in_progress", priority: "high", notes: "清理后留存照片，并由经办人复核。", source: "虚构台账 DEMO-001" },
    { id: "DEMO-02", task: "复核护栏维修结果", location: "K20+100", owner: "演示乙", dueDate: "2026-09-30", status: "completed", priority: "medium", source: "虚构台账 DEMO-002" },
    { id: "DEMO-03", task: "补充路面病害位置照片", location: "K12+500", status: "blocked", notes: "责任人与截止日期尚待确认。", source: "虚构台账 DEMO-003" },
  ],
  risks: ["第三项缺少责任人和计划日期，请核实后安排。"], nextSteps: ["核验排水沟清理后的实际结果。"], sources: ["所有地名、人员、数据均为软件测试样例。"],
});

// Independent ZIP reader for validation, deliberately not an import from the writer.
function unpack(buffer) {
  assert.ok(Buffer.isBuffer(buffer));
  const end = buffer.length - 22;
  assert.equal(buffer.readUInt32LE(end), 0x06054b50);
  const entries = buffer.readUInt16LE(end + 10), directoryAt = buffer.readUInt32LE(end + 16);
  assert.ok(entries > 0);
  const parts = new Map();
  let cursor = directoryAt;
  for (let i = 0; i < entries; i++) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50);
    const size = buffer.readUInt32LE(cursor + 20), rawSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28), extraLength = buffer.readUInt16LE(cursor + 30), commentLength = buffer.readUInt16LE(cursor + 32);
    const localAt = buffer.readUInt32LE(cursor + 42), name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString();
    assert.equal(buffer.readUInt32LE(localAt), 0x04034b50);
    const dataAt = localAt + 30 + buffer.readUInt16LE(localAt + 26) + buffer.readUInt16LE(localAt + 28);
    const raw = inflateRawSync(buffer.subarray(dataAt, dataAt + size));
    assert.equal(raw.length, rawSize);
    let crc = 0xffffffff;
    for (const byte of raw) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    assert.equal((crc ^ 0xffffffff) >>> 0, buffer.readUInt32LE(cursor + 16));
    assert.ok(!parts.has(name));
    parts.set(name, raw.toString("utf8"));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(cursor, end);
  return parts;
}

test("DOCX is a standard compressed OOXML package with editable Chinese report and repeated table headers", () => {
  const parts = unpack(generateWeeklyReport(sample()));
  assert.equal(parts.size, 6);
  const xml = parts.get("word/document.xml");
  assert.match(parts.get("[Content_Types].xml"), /wordprocessingml\.document\.main\+xml/);
  assert.match(xml, /w:pStyle w:val="Title"/);
  assert.match(xml, /虚构演示数据/);
  assert.match(xml, /本清单共3项，其中已完成1项/);
  assert.match(xml, /<w:tblHeader\/>/);
  assert.match(xml, /DEMO-03/);
  assert.match(xml, /风险与待协调事项/);
  assert.match(parts.get("word/styles.xml"), /w:eastAsia="Noto Sans CJK SC"/);
  assert.ok([...parts.values()].every(part => !/vbaProject|TargetMode="External"|<w:hyperlink|<w:instrText/.test(part)));
});

test("XLSX contains typed dates, recalculable safe counts, filtering, frozen headers and input validation", () => {
  const parts = unpack(generateTaskWorkbook(sample()));
  assert.equal(parts.size, 7);
  const xml = parts.get("xl/worksheets/sheet1.xml");
  assert.match(xml, /xSplit="2" ySplit="8"/);
  assert.match(xml, /autoFilter ref="A8:I11"/);
  assert.match(xml, /<c r="B4" s="4"><f>COUNTA\(B9:B11\)<\/f><v>3<\/v>/);
  assert.match(xml, /<c r="D4" s="4"><f>COUNTIFS\(F9:F11,&quot;已完成&quot;\)<\/f><v>1<\/v>/);
  assert.match(xml, /<c r="E9" s="5" t="n"><v>46297<\/v>/);
  assert.match(xml, /<dataValidations count="2">/);
  assert.match(xml, /conditionalFormatting sqref="F9:F11"/);
  assert.match(parts.get("xl/workbook.xml"), /fullCalcOnLoad="1"/);
});

test("untrusted text cannot inject formulas, XML, relationships or executable content", () => {
  const attacks = ['=HYPERLINK("https://example.invalid","click")', '+cmd|\'/C calc\'!A0', '-1+2', '@SUM(A1:A2)', '\t=1+2', '<f>WEBSERVICE("https://example.invalid")</f>', '</w:t><w:instrText>INCLUDETEXT evil</w:instrText><w:t>', 'https://example.invalid/?a=1&b=2', '_x003D_HYPERLINK("fake")'];
  const data = { rows: attacks.map((task, i) => ({ task, id: `T${i}`, notes: 'Chinese 中文 & < > " \' 😀' })) };
  const xlsx = unpack(generateTaskWorkbook(data));
  const xml = xlsx.get("xl/worksheets/sheet1.xml");
  assert.equal((xml.match(/<f>/g) || []).length, 4);
  assert.match(xml, /t="inlineStr"><is><t xml:space="preserve">=HYPERLINK/);
  assert.match(xml, /&lt;f&gt;WEBSERVICE/);
  assert.match(xml, /&lt;\/w:t&gt;&lt;w:instrText&gt;/);
  assert.match(xml, /_x005F_x003D_HYPERLINK/);
  assert.ok([...xlsx.values()].every(part => !/TargetMode="External"|<hyperlink|vbaProject|oleObject/.test(part)));
  const docx = unpack(generateWeeklyReport(data)).get("word/document.xml");
  assert.ok(!docx.includes("<w:instrText>"));
  assert.match(docx, /&amp; &lt; &gt; &quot; &apos; 😀/);
});

test("empty datasets remain explicitly unknown, with zero safe counts and no invented work", () => {
  const doc = unpack(generateWeeklyReport()).get("word/document.xml");
  assert.match(doc, /未提供结构化任务/);
  assert.match(doc, /不能据此认定不存在风险/);
  const sheet = unpack(generateTaskWorkbook()).get("xl/worksheets/sheet1.xml");
  assert.match(sheet, /COUNTA\(B9:B9\)<\/f><v>0/);
  assert.match(sheet, /autoFilter ref="A8:I9"/);
  assert.match(sheet, /<row r="9"/);
});

test("row validation rejects duplicate IDs, malformed dates, invalid categories, invalid XML and excessive input", () => {
  for (const data of [null, [], { demo: "true" }, { rows: "text" }, { rows: [null] }, { rows: [{}] }, { rows: [{ task: "a", id: "dup" }, { task: "b", id: "dup" }] }, { rows: [{ task: "x", dueDate: "2026-02-30" }] }, { rows: [{ task: "x", dueDate: "1900-02-29" }] }, { rows: [{ task: "x", dueDate: "1899-01-01" }] }, { rows: [{ task: "x", status: "finished" }] }, { rows: [{ task: "x", priority: "__proto__" }] }, { summary: "a\u0000b" }, { title: "bad\ud800" }, { rows: [{ task: { formula: "1+1" } }] }, { rows: Array.from({ length: 501 }, () => ({ task: "x" })) }, { risks: Array(51).fill("x") }, { summary: "x".repeat(50001) }]) {
    assert.throws(() => normalizeOfficeData(data));
  }
  assert.equal(normalizeOfficeData({ rows: [{ task: "x", dueDate: "2024-02-29" }] }).rows[0].dueDate, "2024-02-29");
  assert.equal(normalizeOfficeData({ rows: [{ task: "x" }] }).rows[0].owner, "待确认");
});

test("500 rows and long summaries retain every record without oversized Excel strings", () => {
  const data = { summary: "文".repeat(29999) + "😀" + "本".repeat(10000), rows: Array.from({ length: 500 }, (_, i) => ({ id: `ROW-${i}`, task: `任务 ${i}`, status: i % 2 ? "已完成" : "待确认" })) };
  const parts = unpack(generateTaskWorkbook(data)), xml = parts.get("xl/worksheets/sheet1.xml");
  assert.match(xml, /ROW-499/);
  assert.match(xml, /autoFilter ref="A8:I508"/);
  assert.match(xml, /<v>500<\/v>/);
  assert.match(xml, /<v>250<\/v>/);
  assert.match(xml, /工作摘要 续/);
  assert.match(xml, /😀/);
  assert.ok([...xml.matchAll(/<t xml:space="preserve">(.*?)<\/t>/gs)].every(match => match[1].length <= 30000));
});

test("local save allows safe basename-only paths, rejects overwrites and symlinks, and applies private permissions", () => {
  const directory = mkdtempSync(join(tmpdir(), "office-artifacts-"));
  const destination = join(directory, "docs");
  try {
    for (const filename of ["../escape.docx", "dir/escape.docx", "dir\\escape.docx", "/tmp/escape.docx", "bad.xlsm", "trailing.docx ", "CON.docx", "a:b.docx", "a\u0000.docx", "中".repeat(100) + ".docx"]) assert.throws(() => saveOfficeArtifact({ directory: destination, filename, format: "docx", data: {} }));
    assert.throws(() => saveOfficeArtifact({ directory: "relative", filename: "x.docx", format: "docx" }));
    assert.throws(() => saveOfficeArtifact({ directory: destination, filename: "x.xlsm", format: "xlsm" }));
    const metadata = saveOfficeArtifact({ directory: destination, filename: "养护周报.docx", format: "docx", data: sample() });
    assert.equal(metadata.mimeType, OFFICE_MIME_TYPES.docx);
    assert.equal(metadata.size, statSync(join(destination, metadata.filename)).size);
    assert.equal(statSync(join(destination, metadata.filename)).mode & 0o777, 0o600);
    assert.equal(statSync(destination).mode & 0o777, 0o700);
    assert.throws(() => saveOfficeArtifact({ directory: destination, filename: metadata.filename, format: "docx" }), /EEXIST/);
    symlinkSync(join(destination, metadata.filename), join(destination, "linked.docx"));
    assert.throws(() => saveOfficeArtifact({ directory: destination, filename: "linked.docx", format: "docx" }));
    const linkedDir = join(directory, "linked-directory");
    symlinkSync(destination, linkedDir, "dir");
    assert.throws(() => saveOfficeArtifact({ directory: linkedDir, filename: "x.docx", format: "docx" }), /符号链接/);
    assert.equal(unpack(readFileSync(join(destination, metadata.filename))).size, 6);
    assert.equal(saveOfficeArtifact({ directory: destination, filename: "清单.xlsx", format: "xlsx", data: sample() }).mimeType, OFFICE_MIME_TYPES.xlsx);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
