const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// Local-practice persistence only. CloudBase remains the authoritative hosted store.
async function createLocalStore(dataDir) {
  await fs.mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, 'practice-data.json');
  let state;
  try { state = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = { tables: {} };
  }
  let tail = Promise.resolve();
  const copy = value => value == null ? value : structuredClone(value);
  const persist = async next => {
    const temporary = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
    await fs.rename(temporary, file);
  };
  const rows = (data, collection) => data.tables[collection] || [];
  const matches = (row, where = {}) => Object.entries(where).every(([key, value]) => row[key] === value);
  function adapter(data) {
    return {
      async list(collection, options = {}) {
        const page = Math.max(1, Number(options.page) || 1);
        const pageSize = Math.max(1, Number(options.pageSize) || 20);
        let selected = rows(data, collection).filter(row => matches(row, options.where));
        for (const { field, direction } of (options.orderBy || []).slice().reverse()) {
          selected = selected.slice().sort((a, b) =>
            ((a[field] ?? '') > (b[field] ?? '') ? 1 : (a[field] ?? '') < (b[field] ?? '') ? -1 : 0) * (direction === 'desc' ? -1 : 1));
        }
        return { rows: copy(selected.slice((page - 1) * pageSize, page * pageSize)), total: selected.length, page, pageSize };
      },
      async getById(collection, id) { return copy(rows(data, collection).find(row => row._id === id) || null); },
      async findOne(collection, where = {}) { return copy(rows(data, collection).find(row => matches(row, where)) || null); },
      async create(collection, item) {
        const record = copy({ ...item, _id: item._id || `${collection}-${randomUUID()}` });
        data.tables[collection] = [...rows(data, collection), record];
        return copy(record);
      },
      async set(collection, id, item) {
        const record = copy({ ...item, _id: id });
        const current = rows(data, collection);
        data.tables[collection] = current.some(row => row._id === id)
          ? current.map(row => row._id === id ? record : row) : [...current, record];
        return copy(record);
      },
      async update(collection, id, patch) {
        data.tables[collection] = rows(data, collection).map(row => row._id === id ? { ...row, ...copy(patch) } : row);
        return copy({ _id: id, ...patch });
      },
      async remove(collection, id) { data.tables[collection] = rows(data, collection).filter(row => row._id !== id); }
    };
  }
  const schedule = work => {
    const run = async () => {
      const draft = copy(state);
      const result = await work(adapter(draft));
      await persist(draft);
      state = draft;
      return result;
    };
    const pending = tail.then(run);
    tail = pending.then(() => undefined, () => undefined);
    return pending;
  };
  const store = {};
  for (const method of ['list', 'getById', 'findOne']) store[method] = (...args) => adapter(state)[method](...args);
  for (const method of ['create', 'set', 'update', 'remove']) store[method] = (...args) => schedule(tx => tx[method](...args));
  store.runTransaction = work => schedule(work);
  return store;
}

module.exports = { createLocalStore };
