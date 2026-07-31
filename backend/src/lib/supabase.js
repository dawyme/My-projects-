const supabaseConfig = () => {
  const url = process.env.SUPABASE_URL || null;
  const anonKey = process.env.SUPABASE_ANON_KEY || null;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || null;
  const databaseUrl = process.env.DATABASE_URL || null;
  const directUrl = process.env.DIRECT_URL || databaseUrl;
  const jwtSecret = process.env.JWT_SECRET || null;

  const isSupabaseConfigured = Boolean(url && (anonKey || serviceRoleKey));
  const isDatabaseConfigured = Boolean(databaseUrl);

  return {
    configured: isSupabaseConfigured && isDatabaseConfigured,
    supabaseUrl: url,
    hasAnonKey: Boolean(anonKey),
    hasServiceRoleKey: Boolean(serviceRoleKey),
    hasDatabaseUrl: Boolean(databaseUrl),
    hasDirectUrl: Boolean(directUrl),
    hasJwtSecret: Boolean(jwtSecret),
  };
};

function getSupabaseClient(useServiceRole = true) {
  const url = process.env.SUPABASE_URL;
  const key = useServiceRole
    ? (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY)
    : (process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY);

  if (!url || !key) {
    return null;
  }

  try {
    const { createClient } = require('@supabase/supabase-js');
    return createClient(url, key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  } catch (err) {
    return null;
  }
}

function verifySupabaseConfig() {
  const config = supabaseConfig();
  const missing = [];
  if (!config.hasDatabaseUrl) missing.push('DATABASE_URL');
  if (!config.hasDirectUrl) missing.push('DIRECT_URL');
  if (!config.supabaseUrl) missing.push('SUPABASE_URL');
  if (!config.hasAnonKey) missing.push('SUPABASE_ANON_KEY');
  if (!config.hasServiceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!config.hasJwtSecret) missing.push('JWT_SECRET');

  return {
    success: missing.length === 0,
    missing,
    config,
  };
}

module.exports = {
  supabaseConfig,
  getSupabaseClient,
  verifySupabaseConfig,
};
