/**
 * Supplier Marketplace — public façade.
 *
 * Everything the routes layer needs, in one import. Nothing outside
 * `lib/suppliers` should reach into a connector directly.
 */
module.exports = {
  registry: require('./registry'),
  credentials: require('./credentials'),
  countries: require('./countries'),
  markup: require('./markup'),
  inventory: require('./inventory'),
  importer: require('./importer'),
  catalogue: require('./catalogue'),
  shipping: require('./shipping'),
  fulfillment: require('./fulfillment'),
  syncEngine: require('./sync-engine'),
  connections: require('./connections'),
  scheduler: require('./scheduler'),
  settings: require('./settings'),
  base: require('./connectors/base'),
};
