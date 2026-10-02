import path from "node:path";
/** Platform-independent containment; path.win32 can be supplied by host-independent tests. */
export function isWithinDirectory(directory, filename, pathAPI = path) {
  const relative = pathAPI.relative(
    pathAPI.resolve(directory),
    pathAPI.resolve(filename),
  );
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(".." + pathAPI.sep) &&
    !pathAPI.isAbsolute(relative)
  );
}
