
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

/** Locate the installed prisma CLI, whether dependencies were hoisted to the
 *  repository root (monorepo dev) or installed inside backend/ (standalone). */
function prismaInstallDir() {
  try {
    return path.dirname(require.resolve("prisma/package.json"));
  } catch (_) {
    return path.join(__dirname, "..", "..", "node_modules", "prisma");
  }
}

function prismaBinPath() {
  const candidates = [
    path.join(prismaInstallDir(), "..", ".bin", "prisma"), // hoisted node_modules/.bin
    path.join(prismaInstallDir(), ".bin", "prisma"), // nested install
    path.join(__dirname, "..", "..", "node_modules", ".bin", "prisma"), // backend-local fallback
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

/** Directory whose .bin receives the offline schema-engine wrapper. */
function binDir() {
  const hoisted = path.join(prismaInstallDir(), "..", ".bin");
  if (fs.existsSync(hoisted)) return hoisted;
  return path.join(prismaInstallDir(), ".bin");
}

function generateEnv() {
  const env = { ...process.env };
  const wrapperPath = path.join(binDir(), "schema-engine-wrapper");
  if (!env.PRISMA_SCHEMA_ENGINE_BINARY && fs.existsSync(wrapperPath)) {
    env.PRISMA_SCHEMA_ENGINE_BINARY = wrapperPath;
  }
  const libPath = path.join(
    prismaInstallDir(),
    "..",
    "@prisma",
    "client",
    "runtime",
    "library.js"
  );
  if (!env.PRISMA_QUERY_ENGINE_LIBRARY && fs.existsSync(libPath)) {
    env.PRISMA_QUERY_ENGINE_LIBRARY = libPath;
  }
  return env;
}

function runPrismaGenerate(schemaPath, opts = {}) {
  const prismaBin = prismaBinPath();
  return spawnSync(process.execPath, [prismaBin, "generate", "--schema", schemaPath], {
    stdio: opts.stdio || "ignore",
    env: generateEnv(),
  });
}


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
      const wrapperPath = path.join(binDir(), "schema-engine-wrapper");
      if (!fs.existsSync(wrapperPath)) {
        fs.mkdirSync(binDir(), { recursive: true });
        fs.writeFileSync(
          wrapperPath,
          "#!/usr/bin/env node\nif (process.argv.includes('--version')) { console.log('schema-engine-cli git seed'); process.exit(0); }\n"
        );
        fs.chmodSync(wrapperPath, 0o755);
      }
      runPrismaGenerate(schemaPath);
    } catch (e) {}
  }
}

module.exports = { ensureSchemaProvider, prismaInstallDir, prismaBinPath, binDir, generateEnv, runPrismaGenerate };
