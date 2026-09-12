function normalizePage(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function isMissingCollectionError(error) {
  const code = Number(error && (error.errCode !== undefined ? error.errCode : error.code));
  const message = String(error && (error.errMsg || error.message) || '');
  return code === -502005 || /database collection not exists|Db or Table not exist/i.test(message);
}

function createDocumentStore(db) {
  async function getById(collection, id) {
    if (!id) return null;
    try {
      const result = await db.collection(collection).doc(String(id)).get();
      const data = result && result.data;
      if (Array.isArray(data)) return data[0] || null;
      return data || null;
    } catch (error) {
      // CloudBase document.get throws for an absent _id, while the rest of
      // the domain layer treats a missing record as null (not as a failure).
      const message = String(error && (error.errMsg || error.message) || '');
      if (/does not exist|not exist/i.test(message)) return null;
      throw error;
    }
  }

  async function set(collection, id, data) {
    const normalizedId = String(id);
    const record = { ...data };
    delete record._id;
    await db.collection(collection).doc(normalizedId).set({ data: record });
    return { _id: normalizedId, ...record };
  }

  async function update(collection, id, patch) {
    const normalizedId = String(id);
    const cleanPatch = { ...patch };
    delete cleanPatch._id;
    await db.collection(collection).doc(normalizedId).update({ data: cleanPatch });
    return { _id: normalizedId, ...cleanPatch };
  }

  async function remove(collection, id) {
    await db.collection(collection).doc(String(id)).remove();
  }

  return { getById, set, update, remove };
}

function createCloudStore(db) {
  const documentStore = createDocumentStore(db);

  async function list(collection, options = {}) {
    const page = normalizePage(options.page, 1);
    const pageSize = Math.min(normalizePage(options.pageSize, 20), 100);
    let query = db.collection(collection);
    if (options.where && Object.keys(options.where).length) query = query.where(options.where);
    (options.orderBy || []).forEach(({ field, direction }) => { query = query.orderBy(field, direction === 'desc' ? 'desc' : 'asc'); });
    try {
      const [result, counted] = await Promise.all([
        query.skip((page - 1) * pageSize).limit(pageSize).get(),
        query.count()
      ]);
      return { rows: result.data || [], total: counted.total || 0, page, pageSize };
    } catch (error) {
      // Newly enabled optional modules can legitimately have no collection yet.
      // Callers must opt in explicitly so core catalog/order schema drift is not
      // hidden as a false empty result.
      if (options.allowMissingCollection === true && isMissingCollectionError(error)) {
        return { rows: [], total: 0, page, pageSize };
      }
      throw error;
    }
  }

  async function findOne(collection, where, options = {}) {
    const result = await list(collection, { ...options, where, page: 1, pageSize: 1 });
    return result.rows[0] || null;
  }

  async function create(collection, data) {
    const result = await db.collection(collection).add({ data });
    return { ...data, _id: result._id };
  }

  async function runTransaction(work) {
    // CloudBase transactions only support document operations. Deliberately do
    // not expose list/findOne/create here, so future business code cannot add a
    // collection query inside a transaction by accident.
    return db.runTransaction(async (transaction) => work(createDocumentStore(transaction)));
  }

  return { list, findOne, create, ...documentStore, runTransaction };
}

module.exports = { createCloudStore };
