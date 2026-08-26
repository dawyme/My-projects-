/**
 * Countries, regions and currencies for the Global Supplier Marketplace.
 *
 * Everything here is *reference data* — it encodes no legal opinion. Whether a
 * product may be shipped somewhere is always decided by operator-configured
 * rules (Supplier.allowedCountries/blockedCountries, SupplierProduct
 * restrictions and SupplierShippingRule). See docs/SUPPLIER_MARKETPLACE.md
 * §"Country restrictions and restricted products".
 */

// code: [name, region]
const RAW = {
  AD: ['Andorra', 'EUROPE'], AE: ['United Arab Emirates', 'MIDDLE_EAST'], AF: ['Afghanistan', 'ASIA'],
  AG: ['Antigua and Barbuda', 'CARIBBEAN'], AI: ['Anguilla', 'CARIBBEAN'], AL: ['Albania', 'EUROPE'],
  AM: ['Armenia', 'ASIA'], AO: ['Angola', 'AFRICA'], AR: ['Argentina', 'SOUTH_AMERICA'],
  AS: ['American Samoa', 'OCEANIA'], AT: ['Austria', 'EUROPE'], AU: ['Australia', 'OCEANIA'],
  AW: ['Aruba', 'CARIBBEAN'], AX: ['Åland Islands', 'EUROPE'], AZ: ['Azerbaijan', 'ASIA'],
  BA: ['Bosnia and Herzegovina', 'EUROPE'], BB: ['Barbados', 'CARIBBEAN'], BD: ['Bangladesh', 'ASIA'],
  BE: ['Belgium', 'EUROPE'], BF: ['Burkina Faso', 'AFRICA'], BG: ['Bulgaria', 'EUROPE'],
  BH: ['Bahrain', 'MIDDLE_EAST'], BI: ['Burundi', 'AFRICA'], BJ: ['Benin', 'AFRICA'],
  BL: ['Saint Barthélemy', 'CARIBBEAN'], BM: ['Bermuda', 'CARIBBEAN'], BN: ['Brunei', 'ASIA'],
  BO: ['Bolivia', 'SOUTH_AMERICA'], BQ: ['Bonaire, Sint Eustatius and Saba', 'CARIBBEAN'],
  BR: ['Brazil', 'SOUTH_AMERICA'], BS: ['Bahamas', 'CARIBBEAN'], BT: ['Bhutan', 'ASIA'],
  BW: ['Botswana', 'AFRICA'], BY: ['Belarus', 'EUROPE'], BZ: ['Belize', 'CENTRAL_AMERICA'],
  CA: ['Canada', 'NORTH_AMERICA'], CC: ['Cocos (Keeling) Islands', 'ASIA'],
  CD: ['Congo (DRC)', 'AFRICA'], CF: ['Central African Republic', 'AFRICA'], CG: ['Congo', 'AFRICA'],
  CH: ['Switzerland', 'EUROPE'], CI: ["Côte d'Ivoire", 'AFRICA'], CK: ['Cook Islands', 'OCEANIA'],
  CL: ['Chile', 'SOUTH_AMERICA'], CM: ['Cameroon', 'AFRICA'], CN: ['China', 'ASIA'],
  CO: ['Colombia', 'SOUTH_AMERICA'], CR: ['Costa Rica', 'CENTRAL_AMERICA'], CU: ['Cuba', 'CARIBBEAN'],
  CV: ['Cape Verde', 'AFRICA'], CW: ['Curaçao', 'CARIBBEAN'], CX: ['Christmas Island', 'OCEANIA'],
  CY: ['Cyprus', 'EUROPE'], CZ: ['Czechia', 'EUROPE'], DE: ['Germany', 'EUROPE'],
  DJ: ['Djibouti', 'AFRICA'], DK: ['Denmark', 'EUROPE'], DM: ['Dominica', 'CARIBBEAN'],
  DO: ['Dominican Republic', 'CARIBBEAN'], DZ: ['Algeria', 'AFRICA'], EC: ['Ecuador', 'SOUTH_AMERICA'],
  EE: ['Estonia', 'EUROPE'], EG: ['Egypt', 'AFRICA'], ER: ['Eritrea', 'AFRICA'], ES: ['Spain', 'EUROPE'],
  ET: ['Ethiopia', 'AFRICA'], FI: ['Finland', 'EUROPE'], FJ: ['Fiji', 'OCEANIA'],
  FK: ['Falkland Islands', 'SOUTH_AMERICA'], FM: ['Micronesia', 'OCEANIA'], FO: ['Faroe Islands', 'EUROPE'],
  FR: ['France', 'EUROPE'], GA: ['Gabon', 'AFRICA'], GB: ['United Kingdom', 'EUROPE'],
  GD: ['Grenada', 'CARIBBEAN'], GE: ['Georgia', 'ASIA'], GF: ['French Guiana', 'SOUTH_AMERICA'],
  GG: ['Guernsey', 'EUROPE'], GH: ['Ghana', 'AFRICA'], GI: ['Gibraltar', 'EUROPE'],
  GL: ['Greenland', 'NORTH_AMERICA'], GM: ['Gambia', 'AFRICA'], GN: ['Guinea', 'AFRICA'],
  GP: ['Guadeloupe', 'CARIBBEAN'], GQ: ['Equatorial Guinea', 'AFRICA'], GR: ['Greece', 'EUROPE'],
  GT: ['Guatemala', 'CENTRAL_AMERICA'], GU: ['Guam', 'OCEANIA'], GW: ['Guinea-Bissau', 'AFRICA'],
  GY: ['Guyana', 'SOUTH_AMERICA'], HK: ['Hong Kong', 'ASIA'], HN: ['Honduras', 'CENTRAL_AMERICA'],
  HR: ['Croatia', 'EUROPE'], HT: ['Haiti', 'CARIBBEAN'], HU: ['Hungary', 'EUROPE'], ID: ['Indonesia', 'ASIA'],
  IE: ['Ireland', 'EUROPE'], IL: ['Israel', 'MIDDLE_EAST'], IM: ['Isle of Man', 'EUROPE'],
  IN: ['India', 'ASIA'], IQ: ['Iraq', 'MIDDLE_EAST'], IR: ['Iran', 'MIDDLE_EAST'], IS: ['Iceland', 'EUROPE'],
  IT: ['Italy', 'EUROPE'], JE: ['Jersey', 'EUROPE'], JM: ['Jamaica', 'CARIBBEAN'], JO: ['Jordan', 'MIDDLE_EAST'],
  JP: ['Japan', 'ASIA'], KE: ['Kenya', 'AFRICA'], KG: ['Kyrgyzstan', 'ASIA'], KH: ['Cambodia', 'ASIA'],
  KI: ['Kiribati', 'OCEANIA'], KM: ['Comoros', 'AFRICA'], KN: ['Saint Kitts and Nevis', 'CARIBBEAN'],
  KR: ['South Korea', 'ASIA'], KW: ['Kuwait', 'MIDDLE_EAST'], KY: ['Cayman Islands', 'CARIBBEAN'],
  KZ: ['Kazakhstan', 'ASIA'], LA: ['Laos', 'ASIA'], LB: ['Lebanon', 'MIDDLE_EAST'],
  LC: ['Saint Lucia', 'CARIBBEAN'], LI: ['Liechtenstein', 'EUROPE'], LK: ['Sri Lanka', 'ASIA'],
  LR: ['Liberia', 'AFRICA'], LS: ['Lesotho', 'AFRICA'], LT: ['Lithuania', 'EUROPE'],
  LU: ['Luxembourg', 'EUROPE'], LV: ['Latvia', 'EUROPE'], LY: ['Libya', 'AFRICA'], MA: ['Morocco', 'AFRICA'],
  MC: ['Monaco', 'EUROPE'], MD: ['Moldova', 'EUROPE'], ME: ['Montenegro', 'EUROPE'],
  MF: ['Saint Martin', 'CARIBBEAN'], MG: ['Madagascar', 'AFRICA'], MH: ['Marshall Islands', 'OCEANIA'],
  MK: ['North Macedonia', 'EUROPE'], ML: ['Mali', 'AFRICA'], MM: ['Myanmar', 'ASIA'], MN: ['Mongolia', 'ASIA'],
  MO: ['Macao', 'ASIA'], MP: ['Northern Mariana Islands', 'OCEANIA'], MQ: ['Martinique', 'CARIBBEAN'],
  MR: ['Mauritania', 'AFRICA'], MS: ['Montserrat', 'CARIBBEAN'], MT: ['Malta', 'EUROPE'],
  MU: ['Mauritius', 'AFRICA'], MV: ['Maldives', 'ASIA'], MW: ['Malawi', 'AFRICA'], MX: ['Mexico', 'NORTH_AMERICA'],
  MY: ['Malaysia', 'ASIA'], MZ: ['Mozambique', 'AFRICA'], NA: ['Namibia', 'AFRICA'],
  NC: ['New Caledonia', 'OCEANIA'], NE: ['Niger', 'AFRICA'], NG: ['Nigeria', 'AFRICA'],
  NI: ['Nicaragua', 'CENTRAL_AMERICA'], NL: ['Netherlands', 'EUROPE'], NO: ['Norway', 'EUROPE'],
  NP: ['Nepal', 'ASIA'], NR: ['Nauru', 'OCEANIA'], NU: ['Niue', 'OCEANIA'], NZ: ['New Zealand', 'OCEANIA'],
  OM: ['Oman', 'MIDDLE_EAST'], PA: ['Panama', 'CENTRAL_AMERICA'], PE: ['Peru', 'SOUTH_AMERICA'],
  PF: ['French Polynesia', 'OCEANIA'], PG: ['Papua New Guinea', 'OCEANIA'], PH: ['Philippines', 'ASIA'],
  PK: ['Pakistan', 'ASIA'], PL: ['Poland', 'EUROPE'], PM: ['Saint Pierre and Miquelon', 'NORTH_AMERICA'],
  PR: ['Puerto Rico', 'CARIBBEAN'], PS: ['Palestine', 'MIDDLE_EAST'], PT: ['Portugal', 'EUROPE'],
  PW: ['Palau', 'OCEANIA'], PY: ['Paraguay', 'SOUTH_AMERICA'], QA: ['Qatar', 'MIDDLE_EAST'],
  RE: ['Réunion', 'AFRICA'], RO: ['Romania', 'EUROPE'], RS: ['Serbia', 'EUROPE'], RU: ['Russia', 'EUROPE'],
  RW: ['Rwanda', 'AFRICA'], SA: ['Saudi Arabia', 'MIDDLE_EAST'], SB: ['Solomon Islands', 'OCEANIA'],
  SC: ['Seychelles', 'AFRICA'], SD: ['Sudan', 'AFRICA'], SE: ['Sweden', 'EUROPE'], SG: ['Singapore', 'ASIA'],
  SH: ['Saint Helena', 'AFRICA'], SI: ['Slovenia', 'EUROPE'], SJ: ['Svalbard and Jan Mayen', 'EUROPE'],
  SK: ['Slovakia', 'EUROPE'], SL: ['Sierra Leone', 'AFRICA'], SM: ['San Marino', 'EUROPE'],
  SN: ['Senegal', 'AFRICA'], SO: ['Somalia', 'AFRICA'], SR: ['Suriname', 'SOUTH_AMERICA'],
  SS: ['South Sudan', 'AFRICA'], ST: ['São Tomé and Príncipe', 'AFRICA'], SV: ['El Salvador', 'CENTRAL_AMERICA'],
  SX: ['Sint Maarten', 'CARIBBEAN'], SY: ['Syria', 'MIDDLE_EAST'], SZ: ['Eswatini', 'AFRICA'],
  TC: ['Turks and Caicos Islands', 'CARIBBEAN'], TD: ['Chad', 'AFRICA'], TG: ['Togo', 'AFRICA'],
  TH: ['Thailand', 'ASIA'], TJ: ['Tajikistan', 'ASIA'], TK: ['Tokelau', 'OCEANIA'],
  TL: ['Timor-Leste', 'ASIA'], TM: ['Turkmenistan', 'ASIA'], TN: ['Tunisia', 'AFRICA'], TO: ['Tonga', 'OCEANIA'],
  TR: ['Türkiye', 'EUROPE'], TT: ['Trinidad and Tobago', 'CARIBBEAN'], TV: ['Tuvalu', 'OCEANIA'],
  TW: ['Taiwan', 'ASIA'], TZ: ['Tanzania', 'AFRICA'], UA: ['Ukraine', 'EUROPE'], UG: ['Uganda', 'AFRICA'],
  US: ['United States', 'NORTH_AMERICA'], UY: ['Uruguay', 'SOUTH_AMERICA'], UZ: ['Uzbekistan', 'ASIA'],
  VA: ['Vatican City', 'EUROPE'], VC: ['Saint Vincent and the Grenadines', 'CARIBBEAN'],
  VE: ['Venezuela', 'SOUTH_AMERICA'], VG: ['British Virgin Islands', 'CARIBBEAN'],
  VI: ['U.S. Virgin Islands', 'CARIBBEAN'], VN: ['Vietnam', 'ASIA'], VU: ['Vanuatu', 'OCEANIA'],
  WF: ['Wallis and Futuna', 'OCEANIA'], WS: ['Samoa', 'OCEANIA'], YE: ['Yemen', 'MIDDLE_EAST'],
  YT: ['Mayotte', 'AFRICA'], ZA: ['South Africa', 'AFRICA'], ZM: ['Zambia', 'AFRICA'], ZW: ['Zimbabwe', 'AFRICA'],
};

const REGIONS = {
  AFRICA: 'Africa', AMERICAS: 'Americas', ASIA: 'Asia', CARIBBEAN: 'Caribbean',
  CENTRAL_AMERICA: 'Central America', EUROPE: 'Europe', MIDDLE_EAST: 'Middle East',
  NORTH_AMERICA: 'North America', OCEANIA: 'Oceania', SOUTH_AMERICA: 'South America',
};

const COUNTRIES = Object.entries(RAW).map(([code, [name, region]]) => ({ code, name, region }));
const COUNTRY_BY_CODE = Object.fromEntries(COUNTRIES.map((c) => [c.code, c]));

/** Currency reference data for supplier + selling currencies. */
const CURRENCIES = {
  USD: ['US Dollar', '$'], EUR: ['Euro', '€'], GBP: ['Pound Sterling', '£'], TTD: ['Trinidad & Tobago Dollar', 'TT$'],
  BBD: ['Barbados Dollar', 'Bds$'], JMD: ['Jamaican Dollar', 'J$'], GYD: ['Guyana Dollar', 'G$'],
  XCD: ['East Caribbean Dollar', 'EC$'], CAD: ['Canadian Dollar', 'C$'], MXN: ['Mexican Peso', 'Mex$'],
  BRL: ['Brazilian Real', 'R$'], ARS: ['Argentine Peso', 'AR$'], CLP: ['Chilean Peso', 'CLP$'],
  COP: ['Colombian Peso', 'COL$'], PEN: ['Peruvian Sol', 'S/'], AED: ['UAE Dirham', 'AED'],
  SAR: ['Saudi Riyal', 'SAR'], CNY: ['Chinese Yuan', '¥'], JPY: ['Japanese Yen', '¥'],
  INR: ['Indian Rupee', '₹'], AUD: ['Australian Dollar', 'A$'], NZD: ['New Zealand Dollar', 'NZ$'],
  SGD: ['Singapore Dollar', 'S$'], ZAR: ['South African Rand', 'R'], NGN: ['Nigerian Naira', '₦'],
  KES: ['Kenyan Shilling', 'KSh'], CHF: ['Swiss Franc', 'CHF'],
};

/** Expands region codes ("CARIBBEAN") mixed with country codes ("TT") into a
 *  de-duplicated list of ISO country codes. Unknown tokens are ignored. */
function expandCountries(tokens) {
  const out = new Set();
  for (const raw of tokens || []) {
    const token = String(raw || '').trim().toUpperCase();
    if (!token) continue;
    if (REGIONS[token]) {
      for (const c of COUNTRIES) if (c.region === token) out.add(c.code);
    } else if (COUNTRY_BY_CODE[token]) {
      out.add(token);
    }
  }
  return [...out].sort();
}

/** Normalises any user input (code, name or region) to an ISO code or null. */
function resolveCountry(input) {
  const token = String(input || '').trim().toUpperCase();
  if (!token) return null;
  if (COUNTRY_BY_CODE[token]) return token;
  const byName = COUNTRIES.find((c) => c.name.toUpperCase() === token);
  if (byName) return byName.code;
  const startsWith = COUNTRIES.find((c) => c.name.toUpperCase().startsWith(token) && token.length >= 3);
  return startsWith ? startsWith.code : null;
}

const parseList = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((v) => String(v).trim().toUpperCase()).filter(Boolean);
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((v) => String(v).trim().toUpperCase()).filter(Boolean) : [];
  } catch {
    return String(value).split(',').map((v) => v.trim().toUpperCase()).filter(Boolean);
  }
};

/**
 * The single source of truth for "can this thing ship to this country?".
 *
 * Precedence: an explicit block-list always wins over an allow-list, and
 * product-level restrictions narrow (never widen) what the supplier offers.
 *
 * @returns {{allowed:boolean, reason:string|null, restrictions:string[]}}
 */
function evaluateCountryAccess({
  destination, supplier, supplierProduct = null,
}) {
  const restrictions = [];
  const dest = resolveCountry(destination);
  if (!dest) {
    return { allowed: false, reason: 'A valid destination country is required.', restrictions, destination: null };
  }

  const supplierAllow = expandCountries(parseList(supplier?.countriesServed));
  const supplierBlock = expandCountries(parseList(supplier?.blockedCountries));

  if (supplierBlock.includes(dest)) {
    return { allowed: false, reason: `${supplier?.name || 'This supplier'} does not ship to ${COUNTRY_BY_CODE[dest].name}.`, restrictions, destination: dest };
  }
  if (supplierAllow.length && !supplierAllow.includes(dest)) {
    return {
      allowed: false,
      reason: `${supplier?.name || 'This supplier'} does not list ${COUNTRY_BY_CODE[dest].name} among the countries it serves.`,
      restrictions, destination: dest,
    };
  }

  if (supplierProduct) {
    const pAllow = expandCountries(parseList(supplierProduct.allowedCountries));
    const pBlock = expandCountries(parseList(supplierProduct.blockedCountries));
    if (pBlock.includes(dest)) {
      return { allowed: false, reason: `This product cannot be shipped to ${COUNTRY_BY_CODE[dest].name}.`, restrictions, destination: dest };
    }
    if (pAllow.length && !pAllow.includes(dest)) {
      return {
        allowed: false,
        reason: `This product is only available in ${pAllow.map((c) => COUNTRY_BY_CODE[c]?.name || c).join(', ')}.`,
        restrictions, destination: dest,
      };
    }
    if (supplierProduct.restricted) {
      restrictions.push(supplierProduct.restrictionType || 'RESTRICTED');
      if (supplierProduct.restrictionNotes) restrictions.push(supplierProduct.restrictionNotes);
    }
  }

  return { allowed: true, reason: null, restrictions, destination: dest };
}

/** Every country a supplier/product combination could possibly reach. */
function reachableCountries({ supplier, supplierProduct = null }) {
  let allow = expandCountries(parseList(supplier?.countriesServed));
  if (supplierProduct) {
    const pAllow = expandCountries(parseList(supplierProduct.allowedCountries));
    if (pAllow.length) allow = allow.length ? allow.filter((c) => pAllow.includes(c)) : pAllow;
  }
  if (!allow.length) allow = COUNTRIES.map((c) => c.code);
  const blocked = new Set([
    ...expandCountries(parseList(supplier?.blockedCountries)),
    ...expandCountries(parseList(supplierProduct?.blockedCountries)),
  ]);
  return allow.filter((c) => !blocked.has(c)).map((c) => COUNTRY_BY_CODE[c]).filter(Boolean);
}

module.exports = {
  COUNTRIES, COUNTRY_BY_CODE, REGIONS, CURRENCIES,
  expandCountries, resolveCountry, evaluateCountryAccess, reachableCountries, parseList,
};
