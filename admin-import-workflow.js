(function (global, document) {
  function text(value) { return String(value == null ? '' : value); }
  function cell(row, value) { const node = document.createElement('td'); node.textContent = text(value); row.appendChild(node); }

  function start(options) {
    const fileInput = document.getElementById('stagingFile');
    const preview = document.getElementById('importPreview');
    const summary = document.getElementById('importPreviewSummary');
    const rows = document.getElementById('importPreviewRows');
    const saveButton = document.getElementById('saveImportDrafts');
    const templateButton = document.getElementById('downloadImportTemplate');
    if (!fileInput || !preview || !summary || !rows || !saveButton || !templateButton) return;
    let current = null;
    let saving = false;
    let selectionVersion = 0;

    templateButton.addEventListener('click', () => {
      const link = document.createElement('a');
      link.href = 'outputs/01a0cd53-41af-7eb2-824f-c1e8b42fa25d/商品导入空白模板.xlsx';
      link.download = '商品导入空白模板.xlsx';
      document.body.appendChild(link);
      link.click();
      link.remove();
    });

    function render(data) {
      rows.replaceChildren();
      const display = [
        ...data.invalid.map((item) => ({ item, status: `不能导入：${item.issues.join('；')}` })),
        ...data.duplicates.map((item) => ({ item, status: item.issues.join('；') })),
        ...data.ready.map((item) => ({ item: {
          line: item.sourceRowNo, productCode: item.parsed.productCode, skuCode: item.parsed.skuCode,
          name: item.parsed.name, categoryName: item.parsed.categoryName,
          specName: item.parsed.specName, packageUnit: item.parsed.packageUnit
        }, status: `${item.serverMapping || '可保存草稿'}；${item.mappingWarnings.join('；')}` }))
      ];
      display.forEach(({ item, status }) => {
        const tr = document.createElement('tr');
        cell(tr, item.line); cell(tr, item.productCode); cell(tr, item.skuCode); cell(tr, item.name); cell(tr, item.categoryName);
        cell(tr, item.specName || '待补'); cell(tr, item.packageUnit || '待补'); cell(tr, status);
        rows.appendChild(tr);
      });
      summary.textContent = `${data.fileName}：共 ${data.total} 行；可保存 ${data.ready.length} 行，编码/关联错误 ${data.invalid.length} 行，重复 ${data.duplicates.length} 行。保存后仍是待补齐草稿，不会发布商品。`;
      saveButton.disabled = !data.ready.length;
      saveButton.textContent = `确认仅保存 ${data.ready.length} 条草稿`;
      preview.hidden = false;
    }

    async function verifyAndRender(parsed, version) {
      current = null;
      saveButton.disabled = true;
      preview.hidden = true;
      options.message('正在核对最新编码关系，请等待预览完成后再保存。');
      for (let index = 0; index < parsed.ready.length; index += 50) {
        const part = parsed.ready.slice(index, index + 50);
        const checked = await options.call('admin.imports.preview', { rows: part });
        if (version !== selectionVersion) return;
        checked.rows.forEach((result, offset) => {
          const item = part[offset];
          if (result.status === 'invalid') parsed.invalid.push({ line: item.sourceRowNo, ...item.parsed, issues: result.issues });
          else if (result.status === 'already_staged') parsed.duplicates.push({ line: item.sourceRowNo, ...item.parsed, issues: ['规格编码已有导入草稿；可到下方继续核对'] });
          else { item.serverMapping = `${result.mapping.product}、${result.mapping.sku}`; item.mappingWarnings = result.warnings; }
        });
      }
      const invalidLines = new Set(parsed.invalid.map((item) => item.line));
      const duplicateLines = new Set(parsed.duplicates.map((item) => item.line));
      parsed.ready = parsed.ready.filter((item) => !invalidLines.has(item.sourceRowNo) && !duplicateLines.has(item.sourceRowNo));
      if (version !== selectionVersion) return;
      current = parsed;
      render(parsed);
      options.message('预览已生成。请逐行核对编码、名称和关联，再决定是否仅保存草稿。');
    }

    fileInput.addEventListener('change', async () => {
      if (saving) return;
      const version = ++selectionVersion;
      current = null;
      saveButton.disabled = true;
      preview.hidden = true;
      document.getElementById('importMapping').hidden = true;
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      try {
        options.message('正在本机检查表格；此时不会写入云端。');
        const parsed = await global.MengshixianImportParser.parseFile(file);
        if (version !== selectionVersion) return;
        await verifyAndRender(parsed, version);
        if (version !== selectionVersion) return;
        const missingCode = parsed.invalid.some((item) => item.issues.some((issue) => /缺少商品编码|缺少规格编码/.test(issue)));
        if (missingCode && global.MengshixianImportMapping) {
          let products = [];
          try { products = (await global.MengshixianAdminPaging.listAll((action, params) => options.call(action, params), 'admin.products.list')).rows; }
          catch (_) { if (version === selectionVersion) options.message('现有商品列表暂不可读取；仍可为新商品生成编码。', true); }
          if (version !== selectionVersion) return;
          global.MengshixianImportMapping.mount(parsed, products, async (mapped) => {
            if (version !== selectionVersion || saving) return;
            try { await verifyAndRender(mapped, version); }
            catch (error) { if (version === selectionVersion) options.message(error.message || '编码核对失败。', true); }
          }, (error) => { if (version === selectionVersion) options.message(error.message || '无法建立编码关系，请检查表格。', true); });
        } else document.getElementById('importMapping').hidden = true;
      } catch (error) {
        if (version === selectionVersion) options.message(error.message || '无法读取这个文件。', true);
      } finally {
        if (version === selectionVersion) fileInput.value = '';
      }
    });

    saveButton.addEventListener('click', async () => {
      if (!current || saving || !current.ready.length) return;
      const data = current;
      if (!global.confirm(`将 ${data.ready.length} 条商品保存到友方后台“待审核草稿”。\n不会上架、不会填入价格或图片。\n${data.invalid.length + data.duplicates.length} 条错误或重复行将跳过。\n\n确认继续吗？`)) return;
      saving = true;
      fileInput.disabled = true;
      saveButton.disabled = true;
      let saved = 0, existing = 0, failed = 0;
      try {
        for (let index = 0; index < data.ready.length; index += 50) {
          const response = await options.call('admin.imports.stage', { sourceFile: data.sourceFile, rows: data.ready.slice(index, index + 50) });
          const result = response.staged || [];
          saved += result.filter((row) => row.status === 'staged').length;
          existing += result.filter((row) => row.status === 'already_staged').length;
          failed += result.filter((row) => row.status === 'invalid').length;
          options.message(`保存进度 ${Math.min(index + 50, data.ready.length)} / ${data.ready.length} 条；新建 ${saved} 条，已存在 ${existing} 条。`);
        }
        await options.refresh();
        options.message(`导入完成：新建 ${saved} 条待补齐草稿，重复跳过 ${existing + data.duplicates.length} 条，编码或关联错误 ${failed + data.invalid.length} 条。尚未上架。`);
        saveButton.textContent = '已保存；再次点击仅检查重复';
      } catch (error) {
        options.message(`保存中断：已新建 ${saved} 条，已存在 ${existing} 条。可再次点击继续；相同文件不会重复建立草稿。${error.message || ''}`, true);
      } finally {
        saving = false;
        fileInput.disabled = false;
        saveButton.disabled = false;
      }
    });
  }

  global.MengshixianImportWorkflow = { start };
}(window, document));
