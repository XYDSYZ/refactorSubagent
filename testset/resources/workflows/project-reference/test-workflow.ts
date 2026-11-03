export const workflowKind = "test-workflow-driven";
// Material hashes are generated from the checked-in reference files, not read
// from a pin file that could travel with a modified candidate.
const PINS = {
  "r1-sds": "refactor-task/reference/oracle.c=49ba26231227b29b4bd5afb78c32d9e18f68186bcf945a48f5819f19b717721e;refactor-task/reference/scenario.json=0658237b2153c0c4de2f28334abab326445512b2854d147f2878da53faf51d88;refactor-task/reference/support/check.h=799d3fd3690d5fecf486e0bb1136c209ff1a2b618ed443b93baf5ad5a60ff8ec;refactor-task/reference/support/redis_client.h=923c678437ca3feb9fd8685f586e87b4027e8014413cf02bb6d03e663bc3e006",
  "r2-set": "refactor-task/reference/oracle.c=91ec8d13fb6995616b390b3236db9281ae6407c55ede0bacefd42589bb6e3df7;refactor-task/reference/scenario.json=ad6bb1951a89afca23db1aa1a46b6eace19e70c0617ed22bd90c605843b18a1d;refactor-task/reference/support/check.h=799d3fd3690d5fecf486e0bb1136c209ff1a2b618ed443b93baf5ad5a60ff8ec;refactor-task/reference/support/redis_client.h=923c678437ca3feb9fd8685f586e87b4027e8014413cf02bb6d03e663bc3e006",
  "r3-listpack": "refactor-task/reference/oracle.c=506dde379c7ae609515e30abb890131294ab59053a96c142c3cf44ae136d308e;refactor-task/reference/scenario.json=dd189b641b4fd42ec51ed9946e7469952c2032a39dfbeb8c58c79756652f6032;refactor-task/reference/support/check.h=799d3fd3690d5fecf486e0bb1136c209ff1a2b618ed443b93baf5ad5a60ff8ec;refactor-task/reference/support/redis_client.h=923c678437ca3feb9fd8685f586e87b4027e8014413cf02bb6d03e663bc3e006",
  "r4-dict": "refactor-task/reference/oracle.c=8db24fa2730498c390c8399b342056a5230d0cc166b6f48fb96d4a15db84acff;refactor-task/reference/scenario.json=97459f69d8bd03c0d2aac1f78a2f201056831ce31af033200fb79a7ebca85097;refactor-task/reference/support/check.h=799d3fd3690d5fecf486e0bb1136c209ff1a2b618ed443b93baf5ad5a60ff8ec;refactor-task/reference/support/redis_client.h=923c678437ca3feb9fd8685f586e87b4027e8014413cf02bb6d03e663bc3e006",
  "r5-resp": "refactor-task/reference/oracle.c=d153364450fa36f72ee5897b0e92ce575983a553882b2746b6b3ace02354a315;refactor-task/reference/scenario.json=9fa4a4eb5a9282b942e2ef3046fa31252da411c624802a9a28b80d7b1b0c583d;refactor-task/reference/support/check.h=799d3fd3690d5fecf486e0bb1136c209ff1a2b618ed443b93baf5ad5a60ff8ec;refactor-task/reference/support/redis_client.h=923c678437ca3feb9fd8685f586e87b4027e8014413cf02bb6d03e663bc3e006",
  "r6-aof": "refactor-task/reference/manifest.c=1bcc9d46201ac561704e5173b9b69d04dd74d200c767acba376809e38c33a123;refactor-task/reference/oracle.c=374cd63652d99e25dff6599909fbfd0c5b7fd354d573cbad5856a772d3dc38bb;refactor-task/reference/scenario.json=79f49c7be3bb24f882e73dd04feaefb6cfe9d710eed6b147e3f78d2160aa31f8;refactor-task/reference/support/check.h=799d3fd3690d5fecf486e0bb1136c209ff1a2b618ed443b93baf5ad5a60ff8ec;refactor-task/reference/support/redis_client.h=923c678437ca3feb9fd8685f586e87b4027e8014413cf02bb6d03e663bc3e006",
  "mock-transport": "refactor-task/reference/oracle.c=b39ed874924ef321bd3606623c160fb56e389d0cf6c43d1e4626b00ab30de8ad;refactor-task/reference/scenario.json=788028717c4d2cd43fd5ea57ecf4fedb40cf32961e0b497ffe9492d776bbe741;refactor-task/reference/support/check.h=799d3fd3690d5fecf486e0bb1136c209ff1a2b618ed443b93baf5ad5a60ff8ec;refactor-task/reference/support/redis_client.h=923c678437ca3feb9fd8685f586e87b4027e8014413cf02bb6d03e663bc3e006"
};
export default async (ctx) => {
  const spec = JSON.parse(await ctx.fs.readFile("refactor-task/reference/scenario.json"));
  const suffix = ctx.facts.host.executable_suffix;
  const snapshot = async () => {
    const files = await ctx.fs.snapshot("refactor-task/reference");
    return Object.entries(files).map(([path, hash]) => path + "=" + hash).sort().join(";");
  };
  const before = await snapshot();
  if (before !== PINS[spec.id]) throw new Error("reference material integrity mismatch for " + spec.id);
  const protectedSources = async () => {
    for (const [path, hash] of Object.entries(spec.protectedFiles)) {
      const snapshot = await ctx.fs.snapshot(path);
      if (snapshot[path] !== hash) throw new Error("protected test/contract source changed: " + path);
    }
  };
  await protectedSources();
  const execute = async (program, args = []) => {
    const result = await ctx.process.run({ program, args, timeoutMs: 30000 });
    if (result.status !== "exited" || result.exitCode !== 0 || result.signal) {
      throw new Error("reference process failed: " + program + " " + result.status + " " + result.exitCode + " :: " + result.stderr);
    }
    return result.stdout;
  };
  const observe = (prefix, stdout, expected) => {
    const lines = stdout.trim().split(/\r?\n/);
    if (lines.length !== expected + 1 || lines.at(-1) !== "checks=" + expected) throw new Error("reference checks missing: " + stdout);
    const names = new Set();
    for (const line of lines.slice(0, -1)) {
      const match = /^([a-z0-9-]+)=([01])$/.exec(line);
      if (!match || names.has(match[1])) throw new Error("malformed/duplicate reference observation: " + line);
      names.add(match[1]);
      ctx.expect(prefix + match[1], "both-matches", match[2], "^1$");
    }
  };
  const oracle = "build/verification/oracle" + suffix;
  if (!spec.service) {
    observe("", await execute(oracle), spec.checks);
  } else {
    let server = null;
    const start = async () => {
      server = await ctx.process.start({
        program: "build/verification/redis-server" + suffix, cwd: "build/verification",
        args: ["--port", "0", "--unixsocket", "server.sock", "--unixsocketperm", "700", "--daemonize", "no", "--save", "", "--dir", ".", "--loglevel", "warning",
          "--appendonly", spec.id === "r6-aof" ? "yes" : "no", "--appendfsync", "always", "--auto-aof-rewrite-percentage", "0"],
        ready: { kind: "file", path: "build/verification/server.sock", timeoutMs: 10000 },
      });
      const pong = await execute("build/verification/redis-cli" + suffix, ["-s", "build/verification/server.sock", "PING"]);
      if (pong.trim() !== "PONG") throw new Error("Redis not ready: " + pong);
    };
    const shutdown = async () => {
      await execute("build/verification/redis-cli" + suffix, ["-s", "build/verification/server.sock", "SHUTDOWN", "NOSAVE"]);
      const exit = await ctx.process.wait(server, 10000);
      if (exit.status !== "exited" || exit.exitCode !== 0) throw new Error("Redis did not exit cleanly");
      server = null;
    };
    try {
      if (spec.id === "r6-aof") observe("", await execute("build/verification/manifest" + suffix), 5);
      await start();
      observe("", await execute(oracle, spec.id === "r6-aof" ? ["write"] : []), spec.checks);
      await shutdown();
      if (spec.id === "r6-aof") {
        const dir = "build/verification/appendonlydir/";
        const manifest = dir + "appendonly.aof.manifest";
        const contents = await ctx.fs.readFile(manifest);
        if (!/^file .+ seq \d+ type b/m.test(contents) || !/^file .+ seq \d+ type i/m.test(contents)) throw new Error("missing real AOF files");
        await ctx.fs.writeFile(dir + "extra.2.incr.aof", "*3\r\n$3\r\nSET\r\n$11\r\npersist:key\r\n$6\r\nlatest\r\n");
        await ctx.fs.writeFile(manifest, contents + "file extra.2.incr.aof seq 2 type i\n");
        await start(); observe("", await execute(oracle, ["read"]), 3); await shutdown();
        // Malformed manifest must fail specifically while loading the manifest.
        await ctx.fs.writeFile(manifest, "file missing.aof seq invalid type i\n");
        const bad = await ctx.process.run({ program: "build/verification/redis-server" + suffix,
          cwd: "build/verification", args: ["--port", "0", "--unixsocket", "server.sock", "--save", "", "--dir", ".", "--appendonly", "yes"], timeoutMs: 10000 });
        if (bad.status !== "exited" || bad.signal) throw new Error("invalid-manifest check did not finish normally");
        ctx.expect("invalid-manifest-rejected", "both-matches", String(bad.exitCode === 1 && /Invalid AOF manifest file format/i.test(bad.stdout + bad.stderr)), "^true$");
      }
      if (spec.unit) {
        // These units use TCP. Avoid the upstream helper's absolute socket path,
        // which exceeds Linux's Unix socket limit in nested evaluation worktrees.
        const upstream = await ctx.process.run({ program: "bash", args: ["./runtest", "--single", spec.unit, "--clients", "1", "--timeout", "120", "--no-latency", "--tags", "-slow", "--config", "unixsocket", '""', "--dump-logs"], timeoutMs: 150000 });
        if (upstream.status !== "exited" || upstream.signal || ![0, 1].includes(upstream.exitCode)) {
          throw new Error("upstream test infrastructure failed: " + upstream.status + " exit=" + upstream.exitCode + " :: " + upstream.stderr + upstream.stdout);
        }
        const clean = upstream.stdout.replace(/\x1b\[[0-9;]*m/g, "");
        if (/\[TIMEOUT\]/i.test(clean) || !clean.includes("[1/1 done]: " + spec.unit + " ")) {
          throw new Error("upstream tests did not complete: " + upstream.stderr + clean);
        }
        const failures = /\[err\]|\[exception\]/i.test(clean);
        ctx.expect("upstream-exit", "both-matches", String(upstream.exitCode), "^0$");
        ctx.expect("upstream-no-failures", "both-matches", String(!failures), "^true$");
        const names = clean.split(/\r?\n/).filter(line => line.includes("[ok]:")).map(line => line.slice(line.indexOf("[ok]:") + 5).replace(/ \(\d+ ms\)$/, "").trim()).sort();
        if (!names.length && !failures) throw new Error("zero upstream tests executed: " + upstream.stderr + clean);
        if (upstream.exitCode === 0 && !spec.requiredTests.every(name => names.includes(name))) throw new Error("expected upstream tests did not run");
        ctx.expect("upstream-tests", names.join("\n"));
      }
    } finally {
      if (server) await ctx.process.stop(server);
    }
  }
  if (await snapshot() !== before) throw new Error("reference materials changed while executing");
  await protectedSources();
};
