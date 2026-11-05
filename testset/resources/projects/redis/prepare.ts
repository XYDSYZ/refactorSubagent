import { spawnSync } from "node:child_process";
import { blocked, cloneSource, envDir } from "../../../runner/case-api.js";
if (process.platform !== "linux") blocked("Redis evaluation currently requires a native Linux/WSL host");
// Redis' launcher searches versioned Tcl names, not just an arbitrary tclsh.
const tcl = ["tclsh9.0", "tclsh8.7", "tclsh8.6", "tclsh8.5"].some((name) => {
  const probe = spawnSync(name, [], { input: "puts [info patchlevel]\n", encoding: "utf8", timeout: 5000 });
  return probe.status === 0 && /^\d+\.\d+/m.test(probe.stdout ?? "");
});
if (/redis-r[25]-/.test(process.env["CASE_ID"] ?? "") && !tcl) {
  blocked("This Redis reference scenario requires Tcl 8.5+ (for example tclsh8.6) on PATH");
}
cloneSource("redis", { into: envDir() });
