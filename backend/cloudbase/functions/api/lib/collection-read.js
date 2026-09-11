async function collectPageMatches(store, collection, options, matches, config = {}) {
  const maxPages = Math.max(1, Math.min(50, Number(config.maxPages) || 20));
  const pageSize = Math.max(1, Math.min(100, Number(config.pageSize) || 100));
  const matched = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const listed = await store.list(collection, { ...options, page, pageSize });
    for (const item of listed.rows) {
      if (await matches(item)) matched.push(item);
    }
    const complete = typeof config.isComplete === 'function' && config.isComplete(matched);
    if (complete || listed.rows.length < pageSize || page * pageSize >= (listed.total || 0)) break;
  }
  return matched;
}

module.exports = { collectPageMatches };
