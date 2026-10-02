import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { isWithinDirectory } from "../lib/paths.mjs";
test("Windows static asset containment allows legitimate files and rejects traversal", () => {
  const root = "C:\\Users\\Tester\\App\\backend\\public";
  assert.equal(
    isWithinDirectory(root, root + "\\index.html", path.win32),
    true,
  );
  assert.equal(
    isWithinDirectory(root, root + "\\nested\\app.js", path.win32),
    true,
  );
  assert.equal(
    isWithinDirectory(root, root + "\\..\\server.mjs", path.win32),
    false,
  );
  assert.equal(
    isWithinDirectory(root, "D:\\other\\index.html", path.win32),
    false,
  );
  assert.equal(
    isWithinDirectory(root, root + "-evil\\app.js", path.win32),
    false,
  );
});
test("POSIX static asset containment allows legitimate files and rejects traversal", () => {
  const root = "/app/public";
  assert.equal(isWithinDirectory(root, root + "/index.html", path.posix), true);
  assert.equal(
    isWithinDirectory(root, root + "/../server.mjs", path.posix),
    false,
  );
  assert.equal(
    isWithinDirectory(root, root + "-evil/app.js", path.posix),
    false,
  );
});
