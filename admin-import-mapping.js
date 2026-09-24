(function importMapping(global, document) {
  'use strict';
  const owners = new WeakMap();
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const freshCode = (kind) => `MSX-${kind}-${global.crypto.randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
  function downloadCsv(data) {
    const csvCell = (value) => `"${String(value == null ? '' : value).replace(/"/g, '""')}"`;
    const text = '\uFEFF' + data.grid.map((row) => row.cells.map(csvCell).join(',')).join('\r\n') + '\r\n';
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    link.download = `${data.fileName.replace(/\.[^.]+$/, '')}-已建立编码.csv`;
    document.body.appendChild(link); link.click(); link.remove();
    global.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }
  function mount(data, products, onMapped, onError = () => {}) {
    const host = document.getElementById('importMapping');
    const owner = {};
    owners.set(host, owner);
    const missing = data.invalid.filter((item) => item.issues.some((issue) => /缺少商品编码|缺少规格编码/.test(issue)));
    if (!data.grid || !missing.length) { host.hidden = true; host.replaceChildren(); return; }
    const catalog = products.filter((item) => item.spuCode);
    const previous = data.grid.slice(1).filter((row) => row.cells.some((cell) => String(cell || '').trim()));
    host.innerHTML = `<h4>先建立缺失的编码对应关系</h4><p>选择“新商品”会由后台生成业务编码；同一商品的多个规格，请在后续行选择“与前一行同商品”。这一步仅在本机整理表格，不写云端；完成后会下载带编码版本，供以后重导使用。</p>
      <div class="table-wrap"><table><thead><tr><th>行</th><th>商品名称</th><th>商品对应关系</th><th>规格编码</th></tr></thead><tbody>${missing.map((item) => {
        const earlier = previous.filter((row) => row.line < item.line).slice(-30);
        return `<tr data-map-line="${item.line}"><td>${item.line}</td><td>${esc(item.name)}</td><td><select data-map-product><option value="new">新商品：自动生成业务编码</option>${earlier.map((row) => `<option value="row:${row.line}">与第 ${row.line} 行同商品</option>`).join('')}${catalog.map((product) => `<option value="existing:${esc(product.spuCode)}">现有商品：${esc(product.name)}（${esc(product.spuCode)}）</option>`).join('')}</select></td><td>${item.skuCode ? esc(item.skuCode) : '自动生成规格编码'}</td></tr>`;
      }).join('')}</tbody></table></div><button type="button" id="applyImportMapping">建立关系并下载带编码表</button>`;
    host.hidden = false;
    const applyButton = host.querySelector('#applyImportMapping');
    let checking = false;
    applyButton.addEventListener('click', async () => {
      if (checking || owners.get(host) !== owner) return;
      checking = true;
      applyButton.disabled = true;
      try {
      const headers = data.grid[0].cells.map((value) => String(value || '').trim().replace(/\s+/g, ''));
      const productIndex = headers.findIndex((value) => ['商品编码', 'SPU编码'].includes(value));
      const skuIndex = headers.findIndex((value) => ['规格编码', 'SKU编码'].includes(value));
      if (productIndex < 0 || skuIndex < 0) throw new Error('模板缺少商品编码或规格编码列。');
      const grid = data.grid.map((row) => ({ line: row.line, cells: [...row.cells] }));
      const byLine = new Map(grid.map((row) => [row.line, row]));
      for (const row of grid.slice(1)) {
        const selected = host.querySelector(`[data-map-line="${row.line}"] [data-map-product]`)?.value || 'new';
        if (!String(row.cells[productIndex] || '').trim()) {
          if (selected.startsWith('existing:')) row.cells[productIndex] = selected.slice(9);
          else if (selected.startsWith('row:')) row.cells[productIndex] = byLine.get(Number(selected.slice(4)))?.cells[productIndex] || '';
          else row.cells[productIndex] = freshCode('P');
        }
        if (!String(row.cells[skuIndex] || '').trim()) row.cells[skuIndex] = freshCode('S');
      }
      const mapped = global.MengshixianImportParser.prepareTable(grid, data.sourceFile, data.fileName);
      mapped.grid = grid;
      downloadCsv(mapped);
      await onMapped(mapped);
      if (owners.get(host) === owner) host.hidden = true;
      } catch (error) { if (owners.get(host) === owner) onError(error); }
      finally { checking = false; applyButton.disabled = false; }
    });
  }
  global.MengshixianImportMapping = Object.freeze({ mount, downloadCsv });
}(window, document));
