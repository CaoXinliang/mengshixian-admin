const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createAdminMediaChunks, CHUNK_SIZE } = require('../lib/admin-media-chunks');

async function test() {
  const jobs = new Map(), files = new Map(), audits = [];
  const store = {
    async list(_, { where = {} } = {}) { const rows = [...jobs.values()].filter((row) => Object.entries(where).every(([key, value]) => row[key] === value)); return { rows, total: rows.length }; },
    async findOne(_, where) { return jobs.get(where._id) || null; },
    async create(_, item) { jobs.set(item._id, item); return item; },
    async update(_, id, patch) { jobs.set(id, { ...jobs.get(id), ...patch }); }
  };
  const service = createAdminMediaChunks({
    store, getAdmin: async (payload) => { if (payload.adminToken !== 'owner') throw new Error('unauthorized'); return { admin: { _id: 'admin1' } }; },
    audit: async (...parts) => audits.push(parts), clock: () => new Date('2026-09-23T10:00:00Z'),
    storageUploader: async ({ cloudPath, contentBase64, fileContent }) => {
      const id = `cloud://test/${cloudPath}`;
      files.set(id, fileContent || Buffer.from(contentBase64, 'base64'));
      return id;
    },
    storageDownloader: async (id) => files.get(id),
    storageDeleter: async (ids) => ids.forEach((id) => files.delete(id))
  });
  const body = Buffer.alloc(4 * CHUNK_SIZE + 11, 7);
  const payload = { adminToken: 'owner', fileName: '视频.mp4', type: 'video', mimeType: 'video/mp4', sizeBytes: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex') };
  await assert.rejects(() => service.begin({ ...payload, adminToken: 'other' }), /unauthorized/);
  const started = await service.begin(payload);
  assert.equal(started.chunkCount, 5);
  assert.equal((await service.begin(payload)).uploadId, started.uploadId, 'Retry must resume the same upload');
  await assert.rejects(() => service.finish({ adminToken: 'owner', uploadId: started.uploadId }), (error) => error.code === 'MEDIA_UPLOAD_INCOMPLETE');
  for (let index = 0; index < 5; index += 1) {
    const contentBase64 = body.subarray(index * CHUNK_SIZE, Math.min(body.length, (index + 1) * CHUNK_SIZE)).toString('base64');
    const result = await service.uploadPart({ adminToken: 'owner', uploadId: started.uploadId, index, contentBase64 });
    assert.equal(result.uploaded, true);
    if (index === 1) assert.deepEqual((await service.begin(payload)).uploadedParts, [0, 1], 'Resume must identify uploaded parts');
  }
  assert.equal((await service.uploadPart({ adminToken: 'owner', uploadId: started.uploadId, index: 0 })).alreadyUploaded, true);
  const completed = await service.finish({ adminToken: 'owner', uploadId: started.uploadId });
  assert.ok(completed.fileId.includes('视频'));
  assert.deepEqual(files.get(completed.fileId), body);
  assert.equal(files.size, 1, 'Temporary chunks should be removed after success');
  assert.equal((await service.finish({ adminToken: 'owner', uploadId: started.uploadId })).alreadyUploaded, true);
  assert.equal(audits.length, 1);
  const reused = await service.begin(payload);
  assert.equal(reused.completed, true, 'Selecting a completed file must reuse its uploaded file');
  assert.equal(reused.fileId, completed.fileId);
  const corruptPayload = { ...payload, sha256: '0'.repeat(64) };
  const corrupt = await service.begin(corruptPayload);
  for (let index = 0; index < 5; index += 1) await service.uploadPart({ adminToken: 'owner', uploadId: corrupt.uploadId, index, contentBase64: body.subarray(index * CHUNK_SIZE, Math.min(body.length, (index + 1) * CHUNK_SIZE)).toString('base64') });
  await assert.rejects(() => service.finish({ adminToken: 'owner', uploadId: corrupt.uploadId }), (error) => error.code === 'MEDIA_CONTENT_INVALID');
  assert.equal(jobs.get(corrupt.uploadId).status, 'failed');
  assert.notEqual((await service.begin(corruptPayload)).uploadId, corrupt.uploadId, 'A failed checksum must allow a new upload rather than looping on corrupt chunks');
  assert.equal(files.size, 1, 'Failed temporary chunks must not replace the successful historical file');
  console.log('admin chunked media upload: passed');
}
test().catch((error) => { console.error(error); process.exitCode = 1; });
