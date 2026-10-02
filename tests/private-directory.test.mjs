import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { preparePrivateDirectory, WINDOWS_PRIVATE_DIRECTORY_SCRIPT } from "../lib/private-directory.mjs";
import { assertPrivateWindowsAcl, makeWindowsAclPermissiveForTest, windowsAclTestEnvironment } from "./fixtures/windows-acl.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "luheng-private-directory-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("Windows ACL fixture isolates Windows PowerShell modules from a PowerShell 7 parent", () => {
  const env = { SystemRoot: String.raw`C:\Windows`, PSModulePath: String.raw`C:\Program Files\PowerShell\7\Modules`, psmodulepath: "inherited-alias", PATH: "retained" };
  const child = windowsAclTestEnvironment(String.raw`C:\temporary\报告 [1]`, env);
  assert.equal(child.PSModulePath, String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\Modules`);
  assert.equal(child.psmodulepath, undefined);
  assert.equal(child.PATH, "retained");
  assert.equal(child.LUHENG_TEST_ACL_PATH, String.raw`C:\temporary\报告 [1]`);
  assert.equal(env.psmodulepath, "inherited-alias");
  assert.throws(() => windowsAclTestEnvironment("unused", {}), /system root/);
});

test("native private directory creation and repair remove permissive access and protect inheritance", t => {
  const root = fixture(t), directory = join(root, "nested", "报告 ' [1] & $() 空格");
  preparePrivateDirectory(directory);
  const file = join(directory, "document.txt");
  writeFileSync(file, "synthetic test artifact", { mode: 0o600, flag: "wx" });
  if (process.platform === "win32") makeWindowsAclPermissiveForTest(directory);
  else chmodSync(directory, 0o755);
  preparePrivateDirectory(directory);
  assert.equal(readdirSync(directory).length, 1);
  if (process.platform === "win32") {
    assertPrivateWindowsAcl(directory, { directory: true });
    assertPrivateWindowsAcl(file);
  } else {
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }
});

test("private directory rejects directory links and regular files before mutation", t => {
  const root = fixture(t), target = join(root, "target"), link = join(root, "linked");
  mkdirSync(target);
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => preparePrivateDirectory(link), /符号链接/);
  const file = join(root, "file"); writeFileSync(file, "sentinel");
  assert.throws(() => preparePrivateDirectory(file), /符号链接/);
  assert.throws(() => preparePrivateDirectory("relative"), /绝对路径/);
});

test("Windows ACL runner uses a fixed OS executable, fixed source and data-only paths", () => {
  const directory = String.raw`C:\private\报告 ' [1] & $()`, calls = [];
  preparePrivateDirectory(directory, { platform: "win32", env: { SystemRoot: String.raw`C:\Windows` }, run: (...args) => {
    calls.push(args); return { status: 0, stdout: "LUHENG_PRIVATE_DIRECTORY_READY\r\n" };
  } });
  const [executable, args, options] = calls[0];
  assert.equal(executable, String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`);
  assert.equal(args.at(-1), WINDOWS_PRIVATE_DIRECTORY_SCRIPT);
  assert.ok(!args.join(" ").includes(directory));
  assert.ok(!args.includes("-ExecutionPolicy"));
  assert.equal(options.env.LUHENG_PRIVATE_DIRECTORY, directory);
  assert.equal(options.shell, false);
  assert.equal(options.windowsHide, true);
  assert.equal(options.timeout, 15000);
});

test("Windows ACL errors, timeouts and missing verification fail closed without leaking diagnostics", () => {
  const directory = String.raw`C:\private\reports`, env = { SystemRoot: String.raw`C:\Windows` };
  for (const result of [{ status: 1, stderr: "PRIVATE-DETAIL" }, { status: null, error: new Error("PRIVATE-DETAIL") }, { status: 0, stdout: "" }, { status: 0, stdout: "not-confirmed" }]) {
    assert.throws(() => preparePrivateDirectory(directory, { platform: "win32", env, run: () => result }), error => /未保存文件/.test(error.message) && !error.message.includes("PRIVATE-DETAIL"));
  }
  assert.throws(() => preparePrivateDirectory(directory, { platform: "win32", env: {}, run: () => assert.fail("must not run without SystemRoot") }), /未保存文件/);
  assert.throws(() => preparePrivateDirectory(directory, { platform: "win32", env, run: () => { throw new Error("PRIVATE-DETAIL"); } }), error => /未保存文件/.test(error.message) && !error.message.includes("PRIVATE-DETAIL"));
});
