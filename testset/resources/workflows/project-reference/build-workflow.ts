export const workflowKind = "workflow-driven";
export default async (ctx) => {
  const spec = JSON.parse(await ctx.fs.readFile("refactor-task/reference/scenario.json"));
  const host = ctx.facts.host;
  if (!host || (spec.project === "redis" && host.platform !== "linux")) throw new Error("unsupported reference host");
  const suffix = host.executable_suffix;
  await ctx.fs.mkdir("build/verification");
  const run = async (program, args, timeoutMs = 60000) => {
    const result = await ctx.process.run({ program, args, timeoutMs });
    if (result.status !== "exited" || result.exitCode !== 0) {
      throw new Error(program + " failed: " + result.status + " exit=" + result.exitCode + " :: " + (result.stderr || result.stdout || "").slice(-2000));
    }
    return result;
  };
  if (spec.service) {
    await run("make", ["-C", "src", "-j4", "MALLOC=libc", "USE_SYSTEMD=no", "OPTIMIZATION=-O2", "REDIS_CFLAGS=-DREDIS_TEST", "BUILD_TLS=no", "redis-server", "redis-cli"], 300000);
    await run("bash", ["-c", "cp src/redis-server build/verification/redis-server && cp src/redis-cli build/verification/redis-cli"]);
    await ctx.validator.assertFile("build/verification/redis-server" + suffix);
    await ctx.validator.assertFile("build/verification/redis-cli" + suffix);
  }
  const common = ["-std=gnu11", "-O1", "-g", "-ffunction-sections", "-fdata-sections", "-I", "src", "-I", "include", "-I", "refactor-task/reference/support"];
  if (spec.project === "redis") {
    common.push("-I", "deps/hiredis", "-I", "deps/lua/src", "-I", "deps/hdr_histogram", "-I", "deps/fpconv", "-I", "deps/xxhash");
  }
  const libraries = host.platform === "linux" ? ["-pthread", "-lm", "-lrt"] : [];
  const current = await ctx.fs.snapshot("src");
  const additional = Object.keys(current).filter(path => path.endsWith(".c") && !spec.upstreamSources.includes(path));
  await run("gcc", [...common, "refactor-task/reference/oracle.c", ...spec.sources, ...(spec.service ? [] : additional),
    "-Wl,--gc-sections", ...libraries, "-o", "build/verification/oracle" + suffix]);
  await ctx.validator.assertFile("build/verification/oracle" + suffix);
  if (spec.id === "r6-aof") {
    await run("gcc", [...common, "refactor-task/reference/manifest.c", "src/aof.c", "src/sds.c", "src/zmalloc.c", "src/adlist.c", "src/redisassert.c", ...additional,
      "-Wl,--gc-sections", ...libraries, "-o", "build/verification/manifest" + suffix]);
    await ctx.validator.assertFile("build/verification/manifest" + suffix);
  }
};
