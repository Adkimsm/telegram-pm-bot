/**
 * Compile the Worker source to plain ESM that Node can run, then point a few
 * imports at local shims.
 *
 * Why not vitest-pool-workers: it runs the real `workerd` binary, which cannot
 * start in some sandboxed environments. This harness trades runtime fidelity
 * for the ability to exercise the actual handler code anywhere Node runs, and
 * it covers exactly the pieces where the logic lives — routing, ordering,
 * error recovery and SQL.
 *
 * The shims are:
 *   grammy              -> a recording fake Bot API client
 *   cloudflare:workers  -> a minimal DurableObject base class
 * D1 and the DO namespace are injected as `env` bindings by the tests.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const outDir = join(here, ".build");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".js")) out.push(p);
  }
  return out;
}

export function prepare() {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // A relaxed config: the strict pass already ran via `npm run typecheck`, and
  // here the Workers ambient types are deliberately absent.
  const tsconfig = join(outDir, "tsconfig.json");
  writeFileSync(
    tsconfig,
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        rootDir: join(root, "src"),
        outDir: join(outDir, "src"),
        strict: false,
        skipLibCheck: true,
        noEmit: false,
        noUnusedLocals: false,
        noUnusedParameters: false,
        types: [],
      },
      include: [join(root, "src", "**", "*.ts")],
    }),
  );

  // Type errors are expected (missing Workers globals); only the emit matters.
  try {
    execFileSync("npx", ["tsc", "-p", tsconfig], { cwd: root, stdio: "pipe" });
  } catch {
    /* ignore */
  }

  // Rewrite specifiers to point at the canonical `tests/shims` directory.
  // Copying the shims into the build output instead would give the tests and
  // the code under test *separate module instances*, so the recorded API calls
  // would be invisible to assertions.
  for (const file of walk(join(outDir, "src"))) {
    let code = readFileSync(file, "utf8");

    // TypeScript emits extensionless relative imports; Node ESM needs them.
    code = code.replace(
      /(from\s+")(\.[^"]*?)(")/g,
      (_m, a, spec, c) => `${a}${spec}.js${c}`,
    );

    // Directory imports ("./api", "../bot") became "./api.js".
    code = code
      .replace(/"\.\/api\.js"/g, '"./api/index.js"')
      .replace(/"\.\/bot\.js"/g, '"./bot/index.js"')
      .replace(/"\.\.\/bot\.js"/g, '"../bot/index.js"');

    // Redirect module specifiers that have no Node equivalent.
    const toShims = relative(dirname(file), join(here, "shims")).replace(
      /\\/g,
      "/",
    );
    code = code
      .replace(/"cloudflare:workers"/g, `"${toShims}/cf.js"`)
      .replace(/"grammy"/g, `"${toShims}/grammy.js"`)
      .replace(/"grammy\/types"/g, `"${toShims}/grammy.js"`);

    writeFileSync(file, code);
  }

  return join(outDir, "src");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log("built ->", prepare());
}
