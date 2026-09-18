/**
 * Central client-side tenant-entitlement helper.
 *
 * Mirrors the server boundary (backend/src/lib/features.js resolveFeatureAccess
 * + GET /api/features/access) for every tenant discovery surface — nav, direct
 * routes, dashboard cards, quick actions, cross-page links, tabs and widgets.
 *
 * Rules (same for current and future features — no per-feature exceptions):
 *   • Only customer-tenant admins are ever filtered. SUPER_ADMIN, staff and
 *     every other role see the full surface, exactly like the server bypass.
 *   • Pages NEVER branch on individual feature keys. They declare the feature
 *     a surface needs with `data-feature="some-key"` (or space-separated
 *     `data-feature-any="key-a key-b"` when ANY entitlement suffices) and call
 *     applyEntitlements(root) once after rendering. The helper hides what the
 *     tenant may not see; the API layer remains the security boundary.
 *   • Feature state comes ONLY from auth.refreshFeatures()/hasFeature(), i.e.
 *     the server-computed /api/features/access set. It is never guessed,
 *     never persisted, and fails open (server still enforces) when unloadable.
 */
import { auth } from './api.js';

/** True when the user operates in a customer-tenant admin context. */
export function isTenantAdmin(user = auth.user) {
  return Boolean(user) && (user.role === 'TENANT_ADMIN' || (user.role === 'ADMIN' && !!user.businessId));
}

/**
 * True when `user` may see a surface guarded by `featureKey`.
 * Non-tenant contexts always pass (owner bypass); tenant admins pass only
 * when the server-computed entitlement set contains the key.
 */
export function canSee(featureKey, user = auth.user) {
  if (!featureKey) return true;
  if (!isTenantAdmin(user)) return true;
  return auth.hasFeature(featureKey);
}

/** True when `user` may see a surface guarded by ANY of `featureKeys`. */
export function canSeeAny(featureKeys, user = auth.user) {
  const keys = Array.isArray(featureKeys) ? featureKeys : String(featureKeys || '').split(/\s+/).filter(Boolean);
  if (!keys.length) return true;
  if (!isTenantAdmin(user)) return true;
  return keys.some((key) => auth.hasFeature(key));
}

/**
 * Hides every [data-feature] / [data-feature-any] descendant of `root` that
 * the current tenant may not see. Non-tenant contexts are a no-op. Safe to
 * call repeatedly (e.g. after each dynamic render); already-hidden nodes are
 * left untouched and a data-entitlement-hidden marker records the decision
 * for tests and debugging.
 */
export function applyEntitlements(root = document, user = auth.user) {
  const scope = root || document;
  if (!isTenantAdmin(user)) return;
  if (typeof auth.features === 'undefined' || auth.features === null) return; // not loaded → fail open; API still enforces
  scope.querySelectorAll('[data-feature],[data-feature-any]').forEach((node) => {
    const single = node.getAttribute('data-feature');
    const any = node.getAttribute('data-feature-any');
    const visible = (single ? auth.hasFeature(single) : true)
      && (any ? String(any).split(/\s+/).filter(Boolean).some((key) => auth.hasFeature(key)) : true);
    if (!visible) {
      node.hidden = true;
      node.setAttribute('aria-hidden', 'true');
      node.setAttribute('data-entitlement-hidden', single || any);
    }
  });
}
