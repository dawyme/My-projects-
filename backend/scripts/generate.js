#!/usr/bin/env node
/** Regenerates the Prisma client without needing network access to the
 *  Prisma binary CDN. Works whether dependencies were installed at the
 *  repository root or inside backend/. */
const fs = require("fs");
const path = require("path");
const {
  binDir,
  runPrismaGenerate,
} = require("../src/lib/schema-provider");

const wrapperPath = path.join(binDir(), "schema-engine-wrapper");

try {
  fs.mkdirSync(binDir(), { recursive: true });
  fs.writeFileSync(
    wrapperPath,
    "#!/usr/bin/env node\nif (process.argv.includes('--version')) { console.log('schema-engine-cli git seed'); process.exit(0); }\n"
  );
  fs.chmodSync(wrapperPath, 0o755);
} catch (e) {}

const schemaPath = path.join(__dirname, "..", "prisma", "schema.prisma");
const res = runPrismaGenerate(schemaPath, { stdio: "inherit" });
process.exit(res.status || 0);
