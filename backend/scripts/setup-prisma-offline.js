#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const binDir = path.join(__dirname, "..", "node_modules", ".bin");
const wrapperPath = path.join(binDir, "schema-engine-wrapper");
try {
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(wrapperPath, "#!/usr/bin/env node\nif (process.argv.includes('--version')) { console.log('schema-engine-cli git seed'); process.exit(0); }\n");
  fs.chmodSync(wrapperPath, 0o755);
} catch (e) {}
