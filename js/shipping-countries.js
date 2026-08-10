/* ============================================
   BECKY WEXLIN CREATIVE — Shipping eligibility
   --------------------------------------------
   Single source of truth for the browser. The checkout worker keeps its own
   copy of BLOCKED_COUNTRIES because it deploys separately — if you edit the
   list here, edit it in checkout-worker.js too or the two will disagree.
   ============================================ */

window.BW_SHIPPING = (function () {
  // Destinations we cannot ship to. Ukraine is listed as a whole country,
  // which covers the separately-restricted Crimea, Donetsk and Luhansk regions.
  var BLOCKED = {
    "CU": "Cuba",
    "IR": "Iran",
    "KP": "North Korea",
    "UA": "Ukraine (incl. Crimea, Donetsk and Luhansk)",
    "RU": "Russia",
    "BY": "Belarus",
    "PS": "Palestine (Gaza Strip)",
    "SY": "Syria"
};

  // Countries with no postal code system — demanding one makes their address
  // impossible to enter honestly.
  var NO_POSTAL = ["AE", "AG", "AO", "AW", "BF", "BI", "BJ", "BS", "BW", "BZ", "CD", "CF", "CG", "CI", "CK", "CM", "DJ", "DM", "ER", "FJ", "GD", "GH", "GM", "GN", "GQ", "GY", "HK", "IE", "JM", "KE", "KI", "KM", "KN", "LC", "LY", "ML", "MO", "MR", "MS", "MU", "MW", "NR", "NU", "PA", "QA", "RW", "SB", "SC", "SL", "SO", "SR", "ST", "TF", "TK", "TL", "TO", "TT", "TV", "TZ", "UG", "VU", "YE", "ZW"];

  // Carriers reject these without a state / province / prefecture.
  var REGION_REQUIRED = ["AR", "AU", "BR", "CA", "CN", "ES", "ID", "IN", "IT", "JP", "MX", "MY", "PH", "US"];

  function isBlocked(code) {
    return Object.prototype.hasOwnProperty.call(BLOCKED, String(code || '').toUpperCase());
  }
  function blockedName(code) {
    return BLOCKED[String(code || '').toUpperCase()] || 'that destination';
  }
  function needsPostal(code) {
    return NO_POSTAL.indexOf(String(code || '').toUpperCase()) === -1;
  }
  function needsRegion(code) {
    return REGION_REQUIRED.indexOf(String(code || '').toUpperCase()) !== -1;
  }
  // The message a customer sees. Kept in one place so the form, the worker
  // error path and the address autocomplete all say the same thing.
  function message(code) {
    return "Sorry — we're unable to ship to " + blockedName(code) + ". "
         + "Trade restrictions mean our print partners can't fulfil orders to this "
         + "destination. If you have another delivery address we'd love your order, "
         + "or email hello@beckywexlin.com and we'll help.";
  }

  return {
    BLOCKED: BLOCKED,
    isBlocked: isBlocked,
    blockedName: blockedName,
    needsPostal: needsPostal,
    needsRegion: needsRegion,
    message: message
  };
})();
