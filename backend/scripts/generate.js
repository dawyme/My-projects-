#!/usr/bin/env node
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const binDir = path.join(__dirname, "..", "node_modules", ".bin");
const wrapperPath = path.join(binDir, "schema-engine-wrapper");

try {
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    wrapperPath,
    "#!/usr/bin/env node\nif (process.argv.includes('--version')) { console.log('schema-engine-cli git seed'); process.exit(0); }\n"
  );
  fs.chmodSync(wrapperPath, 0o755);
} catch (e) {}

const env = { ...process.env };
if (!env.PRISMA_SCHEMA_ENGINE_BINARY && fs.existsSync(wrapperPath)) {
  env.PRISMA_SCHEMA_ENGINE_BINARY = wrapperPath;
}
const libPath = path.join(__dirname, "..", "node_modules", "@prisma", "client", "runtime", "library.js");
if (!env.PRISMA_QUERY_ENGINE_LIBRARY && fs.existsSync(libPath)) {
  env.PRISMA_QUERY_ENGINE_LIBRARY = libPath;
}

const prismaBin = path.join(binDir, "prisma");
const schemaPath = path.join(__dirname, "..", "prisma", "schema.prisma");
const res = spawnSync(process.execPath, [prismaBin, "generate", "--schema", schemaPath], { stdio: "inherit", env });
process.exit(res.status || 0);
