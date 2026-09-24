function currentPrice(rule, now) {
  return rule.status === 'active' && Number.isSafeInteger(rule.amountCent) && rule.amountCent > 0
    && (!rule.validFrom || new Date(rule.validFrom).getTime() <= now.getTime())
    && (!rule.validTo || new Date(rule.validTo).getTime() >= now.getTime());
}

function personalMiniappPrice(rule, now) {
  return currentPrice(rule, now) && (!rule.channel || ['all', 'miniapp'].includes(rule.channel))
    && (rule.scopeType === 'public' || (rule.scopeType === 'customer_type' && rule.scopeId === 'c'));
}

module.exports = { currentPrice, personalMiniappPrice };
