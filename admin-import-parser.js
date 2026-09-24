(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MengshixianImportParser = api;
}(typeof window !== 'undefined' ? window : null, function () {
  const HEADER_ALIASES = {
    productCode: ['商品编码', 'SPU编码'],
    skuCode: ['规格编码', 'SKU编码'],
    name: ['商品名称', '品名', '名称'],
    category: ['分类', '商品分类', '分类名称'],
    spec: ['规格', '规格名称', '商品规格'],
    unit: ['包装单位', '单位', '销售单位']
  };
  const MAX_ROWS = 3000;

  function parseCsv(text) {
    const source = String(text || '').replace(/^\uFEFF/, '');
    const rows = [];
    let cells = [], cell = '', quoted = false, line = 1, rowLine = 1;
    for (let i = 0; i < source.length; i += 1) {
      const char = source[i];
      if (char === '"') {
        if (quoted && source[i + 1] === '"') { cell += '"'; i += 1; }
        else if (!quoted && !cell) quoted = true;
        else if (quoted) quoted = false;
        else throw new Error(`第 ${line} 行的引号格式不正确。`);
      } else if (char === ',' && !quoted) {
        cells.push(cell); cell = '';
      } else if ((char === '\n' || char === '\r') && !quoted) {
        cells.push(cell);
        if (cells.some((value) => String(value).trim())) rows.push({ line: rowLine, cells });
        cells = []; cell = '';
        if (char === '\r' && source[i + 1] === '\n') i += 1;
        line += 1; rowLine = line;
      } else {
        cell += char;
        if (char === '\n') line += 1;
      }
    }
    if (quoted) throw new Error(`第 ${rowLine} 行的引号未闭合。`);
    cells.push(cell);
    if (cells.some((value) => String(value).trim())) rows.push({ line: rowLine, cells });
    return rows;
  }

  function prepareTable(grid, sourceFile, fileName) {
    if (!grid.length) throw new Error('表格为空，请填写模板后重试。');
    if (grid.length - 1 > MAX_ROWS) throw new Error(`单次最多导入 ${MAX_ROWS} 行，请拆成多个表格。`);
    const headers = grid[0].cells.map((value) => String(value || '').trim().replace(/\s+/g, ''));
    const index = {};
    for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
      index[key] = headers.findIndex((header) => aliases.includes(header));
    }
    if (index.name < 0 || index.category < 0 || index.productCode < 0 || index.skuCode < 0) throw new Error('表格第一行必须有“商品编码、规格编码、商品名称、分类”四列，请使用页面提供的模板。');
    const ready = [], invalid = [], duplicates = [], seen = new Map(), products = new Map();
    const get = (cells, key) => index[key] < 0 ? '' : String(cells[index[key]] ?? '').trim();
    for (const row of grid.slice(1)) {
      const [productCode, skuCode, name, categoryName, specName, packageUnit] = ['productCode', 'skuCode', 'name', 'category', 'spec', 'unit'].map((key) => get(row.cells, key));
      const issues = [];
      if (!productCode) issues.push('缺少商品编码');
      if (!skuCode) issues.push('缺少规格编码');
      if (productCode && !/^[A-Za-z0-9._-]{1,60}$/.test(productCode)) issues.push('商品编码只能使用英文字母、数字、点、横线或下划线，最多 60 字');
      if (skuCode && !/^[A-Za-z0-9._-]{1,60}$/.test(skuCode)) issues.push('规格编码只能使用英文字母、数字、点、横线或下划线，最多 60 字');
      if (!name) issues.push('缺少商品名称');
      if (!categoryName) issues.push('缺少分类');
      if (name.length > 100) issues.push('商品名称超过 100 字');
      if (categoryName.length > 30) issues.push('分类超过 30 字');
      if (specName.length > 100 || packageUnit.length > 100) issues.push('规格或单位超过 100 字');
      const item = { line: row.line, productCode, skuCode, name, categoryName, specName, packageUnit, issues };
      const productKey = productCode.toUpperCase(), skuKey = skuCode.toUpperCase();
      const priorProduct = products.get(productKey);
      if (priorProduct && (priorProduct.name !== name || priorProduct.categoryName !== categoryName)) issues.push(`商品编码与第 ${priorProduct.line} 行对应的名称或分类不一致`);
      if (!priorProduct && productCode) products.set(productKey, item);
      if (issues.length) { invalid.push(item); continue; }
      if (seen.has(skuKey)) { item.issues.push(`规格编码与第 ${seen.get(skuKey)} 行重复`); duplicates.push(item); continue; }
      seen.set(skuKey, row.line);
      const warnings = [];
      if (!specName) warnings.push('缺少规格，保存后需补齐；不会自动上架。');
      if (!packageUnit) warnings.push('缺少包装单位，保存后需补齐。');
      warnings.push('缺少价格，需在商品管理中补齐。', '缺少主图，需在商品管理中补齐。');
      ready.push({
        sourceRowNo: row.line,
        source: { id: `row-${row.line}`, productCode, skuCode, name, category: categoryName, unit: packageUnit, fileName },
        parsed: { productCode, skuCode, name, categoryName, specName, packageUnit },
        mappingWarnings: warnings
      });
    }
    if (!ready.length && !invalid.length && !duplicates.length) throw new Error('表格没有商品数据行。');
    return { sourceFile, fileName, total: ready.length + invalid.length + duplicates.length, ready, invalid, duplicates, grid };
  }

  function prepareJson(text, fileName) {
    let data;
    try { data = JSON.parse(text); } catch (_) { throw new Error('草稿文件不是有效的 JSON。'); }
    if (!Array.isArray(data.rows) || !data.rows.length) throw new Error('草稿文件没有商品数据。');
    if (data.rows.length > MAX_ROWS) throw new Error(`单次最多导入 ${MAX_ROWS} 行，请拆分文件。`);
    const ready = [], invalid = [], duplicates = [], seen = new Map(), products = new Map();
    data.rows.forEach((row, index) => {
      const source = row && row.source || {};
      const parsed = row && row.parsed || {};
      const id = String(source.id || '').trim();
      const name = String(parsed.name || source.name || '').trim();
      const categoryName = String(parsed.categoryName || source.category || '').trim();
      const item = { line: Number(row && row.sourceRowNo) || index + 1, name, categoryName, specName: parsed.specName || '', packageUnit: parsed.packageUnit || source.unit || '' };
      const productCode = String(parsed.productCode || source.productCode || '').trim();
      const skuCode = String(parsed.skuCode || source.skuCode || '').trim();
      item.productCode = productCode; item.skuCode = skuCode;
      const issues = [];
      if (!productCode) issues.push('缺少商品编码');
      if (!skuCode) issues.push('缺少规格编码');
      if (!name) issues.push('缺少商品名称');
      if (!categoryName) issues.push('缺少分类');
      if (productCode && !/^[A-Za-z0-9._-]{1,60}$/.test(productCode)) issues.push('商品编码格式不正确');
      if (skuCode && !/^[A-Za-z0-9._-]{1,60}$/.test(skuCode)) issues.push('规格编码格式不正确');
      if (issues.length) { invalid.push({ ...item, issues }); return; }
      const key = skuCode.toUpperCase();
      if (seen.has(key)) { duplicates.push({ ...item, issues: [`规格编码与第 ${seen.get(key)} 行重复`] }); return; }
      seen.set(key, item.line);
      const previous = products.get(productCode.toUpperCase());
      if (previous && (previous.name !== name || previous.categoryName !== categoryName)) { invalid.push({ ...item, issues: [`商品编码与第 ${previous.line} 行对应的名称或分类不一致`] }); return; }
      products.set(productCode.toUpperCase(), item);
      ready.push({ ...row, sourceRowNo: item.line, source: { ...source, fileName }, parsed: { ...parsed, productCode, skuCode, name, categoryName }, mappingWarnings: [...(Array.isArray(row.mappingWarnings) ? row.mappingWarnings : []), '需核对价格和主图后再上架。'] });
    });
    return { sourceFile: fileName.slice(0, 120), fileName, total: data.rows.length, ready, invalid, duplicates };
  }

  function xmlNodes(node, name) { return [...node.getElementsByTagNameNS('*', name)]; }
  function xmlDoc(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('Excel 表格内部格式不正确。');
    return doc;
  }

  async function readZipEntry(data, entryName) {
    const view = new DataView(data);
    let end = -1;
    for (let p = data.byteLength - 22; p >= Math.max(0, data.byteLength - 65557); p -= 1) {
      if (view.getUint32(p, true) === 0x06054b50) { end = p; break; }
    }
    if (end < 0) throw new Error('Excel 文件不是有效的 XLSX。');
    const count = view.getUint16(end + 10, true);
    if (count > 5000) throw new Error('Excel 文件内容过大。');
    let offset = view.getUint32(end + 16, true);
    const decoder = new TextDecoder('utf-8');
    for (let i = 0; i < count; i += 1) {
      if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('Excel 压缩目录损坏。');
      const method = view.getUint16(offset + 10, true);
      const compressedSize = view.getUint32(offset + 20, true);
      const uncompressedSize = view.getUint32(offset + 24, true);
      const nameLen = view.getUint16(offset + 28, true);
      const extraLen = view.getUint16(offset + 30, true);
      const commentLen = view.getUint16(offset + 32, true);
      const localOffset = view.getUint32(offset + 42, true);
      const name = decoder.decode(new Uint8Array(data, offset + 46, nameLen));
      offset += 46 + nameLen + extraLen + commentLen;
      if (name !== entryName) continue;
      if (uncompressedSize > 12 * 1024 * 1024) throw new Error('Excel 工作表内容过大。');
      if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error('Excel 文件内容损坏。');
      const start = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
      const bytes = new Uint8Array(data, start, compressedSize);
      if (method === 0) return decoder.decode(bytes);
      if (method !== 8 || typeof DecompressionStream === 'undefined') throw new Error('当前浏览器无法读取此 Excel 文件，请改用 CSV 模板。');
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      const unzipped = await new Response(stream).arrayBuffer();
      if (unzipped.byteLength !== uncompressedSize) throw new Error('Excel 文件解压不完整。');
      return decoder.decode(unzipped);
    }
    return null;
  }

  async function parseXlsx(buffer) {
    const sharedText = await readZipEntry(buffer, 'xl/sharedStrings.xml');
    const shared = sharedText ? xmlNodes(xmlDoc(sharedText), 'si').map((node) => xmlNodes(node, 't').map((t) => t.textContent).join('')) : [];
    const workbookText = await readZipEntry(buffer, 'xl/workbook.xml');
    if (!workbookText) throw new Error('Excel 文件缺少工作表。');
    const workbook = xmlDoc(workbookText);
    const firstSheet = xmlNodes(workbook, 'sheet')[0];
    if (!firstSheet) throw new Error('Excel 文件没有工作表。');
    const relationId = firstSheet.getAttribute('r:id') || firstSheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
    const relText = await readZipEntry(buffer, 'xl/_rels/workbook.xml.rels');
    const relation = relText && xmlNodes(xmlDoc(relText), 'Relationship').find((node) => node.getAttribute('Id') === relationId);
    const target = relation && relation.getAttribute('Target') || 'worksheets/sheet1.xml';
    const sheetPath = target.startsWith('/') ? target.slice(1) : target.startsWith('xl/') ? target : `xl/${target.replace(/^\.\//, '')}`;
    if (sheetPath.includes('..')) throw new Error('Excel 工作表路径不正确。');
    const sheetText = await readZipEntry(buffer, sheetPath);
    if (!sheetText) throw new Error('无法读取 Excel 的第一个工作表。');
    const grid = [];
    for (const row of xmlNodes(xmlDoc(sheetText), 'row')) {
      const cells = [];
      for (const cell of xmlNodes(row, 'c')) {
        const ref = cell.getAttribute('r') || '';
        const letters = (ref.match(/^[A-Z]+/) || [''])[0];
        let col = 0;
        for (const letter of letters) col = col * 26 + letter.charCodeAt(0) - 64;
        if (col < 1 || col > 200) continue;
        const type = cell.getAttribute('t');
        const value = xmlNodes(cell, 'v')[0];
        let text = type === 'inlineStr' ? xmlNodes(cell, 't').map((node) => node.textContent).join('') : value ? value.textContent : '';
        if (type === 's') text = shared[Number(text)] || '';
        cells[col - 1] = text;
      }
      if (cells.some((value) => String(value || '').trim())) grid.push({ line: Number(row.getAttribute('r')) || grid.length + 1, cells });
      if (grid.length > MAX_ROWS + 1) throw new Error(`单次最多导入 ${MAX_ROWS} 行。`);
    }
    return grid;
  }

  async function parseFile(file) {
    if (!file || file.size > 8 * 1024 * 1024) throw new Error('表格不能超过 8 MB。');
    const name = String(file.name || '未命名文件');
    if (/\.json$/i.test(name)) return prepareJson(await file.text(), name);
    if (!/\.(csv|xlsx)$/i.test(name)) throw new Error('请选择 Excel .xlsx、CSV .csv 或旧版草稿 .json 文件。');
    const bytes = await file.arrayBuffer();
    const grid = /\.csv$/i.test(name) ? parseCsv(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) : await parseXlsx(bytes);
    // 使用可见表格内容而非 XLSX 压缩包字节识别重试：Excel 另存后压缩元数据可能变化。
    const canonical = JSON.stringify(grid.map((row) => [row.line, row.cells.map((cell) => String(cell == null ? '' : cell).trim())]));
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
    const digest = [...new Uint8Array(hash)].map((n) => n.toString(16).padStart(2, '0')).join('').slice(0, 32);
    const sourceFile = `table-${digest}`;
    return prepareTable(grid, sourceFile, name);
  }

  return { parseCsv, parseXlsx, prepareTable, prepareJson, parseFile };
}));
