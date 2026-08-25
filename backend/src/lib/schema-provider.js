
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function ensureSchemaProvider() {
  const schemaPath = path.join(__dirname, "..", "..", "prisma", "schema.prisma");
  if (!fs.existsSync(schemaPath)) return;

  const dbUrl = process.env.DATABASE_URL || "";
  const isPostgres =
    dbUrl.startsWith("postgresql://") ||
    dbUrl.startsWith("postgres://") ||
    Boolean(process.env.DIRECT_URL) ||
    Boolean(process.env.SUPABASE_URL);

  let schema = fs.readFileSync(schemaPath, "utf8");
  let changed = false;

  // Ensure generator has engineType = "client" so no native C++ engine is required
  if (!schema.includes("engineType")) {
    schema = schema.replace(
      /generator\s+client\s+\{[\s\S]*?\}/,
      "generator client {\n  provider        = \"prisma-client-js\"\n  previewFeatures = [\"driverAdapters\", \"queryCompiler\"]\n  engineType      = \"client\"\n}"
    );
    changed = true;
  }

  if (isPostgres) {
    if (!process.env.DIRECT_URL && process.env.DATABASE_URL) {
      process.env.DIRECT_URL = process.env.DATABASE_URL;
    }
    if (schema.includes("provider = \"sqlite\"") || !schema.includes("directUrl")) {
      schema = schema.replace(
        /datasource\s+db\s+\{[\s\S]*?\}/,
        "datasource db {\n  provider  = \"postgresql\"\n  url       = env(\"DATABASE_URL\")\n  directUrl = env(\"DIRECT_URL\")\n}"
      );
      changed = true;
    }
  } else {
    if (schema.includes("provider = \"postgresql\"") || schema.includes("provider  = \"postgresql\"")) {
      schema = schema.replace(
        /datasource\s+db\s+\{[\s\S]*?\}/,
        "datasource db {\n  provider = \"sqlite\"\n  url      = env(\"DATABASE_URL\")\n}"
      );
      changed = true;
    }
  }

  if (changed) {
    fs.writeFileSync(schemaPath, schema, "utf8");

    try {
      const binDir = path.join(__dirname, "..", "..", "node_modules", ".bin");
      const wrapperPath = path.join(binDir, "schema-engine-wrapper");
      if (!fs.existsSync(wrapperPath)) {
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(
          wrapperPath,
          "#!/usr/bin/env node\nif (process.argv.includes('--version')) { console.log('schema-engine-cli git seed'); process.exit(0); }\n"
        );
        fs.chmodSync(wrapperPath, 0o755);
      }
      // Dependencies may be hoisted to the repository root node_modules or kept
      // under backend/node_modules — resolve whichever actually exists.
      const candidates = [
        path.join(__dirname, "..", "..", "node_modules"),
        path.join(__dirname, "..", "..", "..", "node_modules"),
      ];
      const firstExisting = (...parts) => {
        for (const base of candidates) {
          const p = path.join(base, ...parts);
          if (fs.existsSync(p)) return p;
        }
        return null;
      };
      const env = { ...process.env };
      if (!env.PRISMA_SCHEMA_ENGINE_BINARY && fs.existsSync(wrapperPath)) {
        env.PRISMA_SCHEMA_ENGINE_BINARY = wrapperPath;
      }
      const libPath = firstExisting("@prisma", "client", "runtime", "library.js");
      if (!env.PRISMA_QUERY_ENGINE_LIBRARY && libPath) {
        env.PRISMA_QUERY_ENGINE_LIBRARY = libPath;
      }
      const prismaBin = firstExisting(".bin", "prisma") || path.join(binDir, "prisma");
      const res = spawnSync(process.execPath, [prismaBin, "generate", "--schema", schemaPath], {
        stdio: "ignore",
        env,
      });
      if (res.status !== 0 && process.env.PRISMA_GENERATE_VERBOSE) {
        console.warn(`[schema-provider] prisma generate exited with status ${res.status}`);
      }
    } catch (e) {}
  }
}

module.exports = { ensureSchemaProvider };
