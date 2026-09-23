/**
 * region-picker.js
 * 配送区域级联选择器 —— 与 deliveryAreaForm 集成
 *
 * 设计原则：
 *   1. 保留原有 textarea 作为数据源（display:none），兼容现有 submit 逻辑
 *   2. textarea ←→ 标签区 双向同步
 *   3. 通过全局 MENGSHIXIAN_REGIONS_TREE / MENGSHIXIAN_REGIONS_MAP 渲染级联
 *
 * 使用方式：
 *   在 areas.html 中：
 *     <script src="region-data.js"></script>
 *     <script src="region-picker.js"></script>
 *   页面加载后自动识别 id=deliveryAreaForm 的表单并增强。
 */
(function () {
  'use strict';

  const TREE_KEY = 'MENGSHIXIAN_REGIONS_TREE';
  const MAP_KEY = 'MENGSHIXIAN_REGIONS_MAP';
  const LOOKUP_KEY = 'MENGSHIXIAN_REGIONS_LOOKUP';

  function getRegions() {
    const g = typeof window !== 'undefined' ? window : globalThis;
    return {
      tree: g[TREE_KEY] || [],
      map: g[MAP_KEY] || {},
      lookup: g[LOOKUP_KEY] || null,
    };
  }

  function lookupName(code) {
    const g = getRegions();
    if (g.map[code]) {
      const r = g.map[code];
      return r.province + ' · ' + r.city + ' · ' + r.district;
    }
    if (g.lookup) {
      const r = g.lookup(code);
      if (r) return r.province + ' · ' + r.city + ' · ' + (r.district || r.city);
    }
    return code;
  }

  function lookupShortName(code) {
    const g = getRegions();
    if (g.map[code]) return g.map[code].district;
    if (g.lookup) {
      const r = g.lookup(code);
      if (r) return r.district || r.city;
    }
    return code;
  }

  /**
   * 增强 deliveryAreaForm 表单：
   *   将 regionCodes textarea 替换为 标签区 + 选择按钮
   */
  function enhanceDeliveryAreaForm(form) {
    if (!form || form.dataset.regionPickerEnhanced) return;
    form.dataset.regionPickerEnhanced = 'true';

    const ta = form.elements.regionCodes;
    if (!ta) return;
    ta.style.display = 'none';

    // Create hidden regionNames textarea alongside
    const namesTa = document.createElement('textarea');
    namesTa.name = 'regionNames';
    namesTa.style.display = 'none';
    namesTa.setAttribute('aria-hidden', 'true');
    ta.parentNode.insertBefore(namesTa, ta.nextSibling);

    // Build the UI container
    const container = document.createElement('div');
    container.className = 'region-picker-container';
    container.innerHTML = [
      '<label class="region-picker-label">配送区域编码（自动根据所选区域生成）</label>',
      '<div class="region-picker-tags" data-role="tags"></div>',
      '<div class="region-picker-actions">',
      '  <button type="button" class="primary" data-role="open-picker">+ 选择区域</button>',
      '  <button type="button" class="region-picker-btn-clear" data-role="clear" title="清空">清空</button>',
      '</div>',
      '<p class="muted" style="font-size:12px;margin:4px 0 0;">点击上方按钮按「省 → 市 → 区县」层级选择，编码将自动写入。</p>',
    ].join('\n');

    // Insert before the warehouseIds label
    ta.parentNode.insertBefore(container, ta.nextSibling);
    // Keep ta in DOM but move it after the container (still inside form)
    container.parentNode.insertBefore(ta, container.nextSibling);

    const tagsEl = container.querySelector('[data-role="tags"]');
    const openBtn = container.querySelector('[data-role="open-picker"]');
    const clearBtn = container.querySelector('[data-role="clear"]');

    // Sync from textarea → tags
    function syncFromTextarea() {
      const codes = String(ta.value || '')
        .split(/[\r\n,，\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      // If namesTa already has values (edit mode), keep them; else derive from map
      if (!namesTa.value || !namesTa.value.trim()) {
        namesTa.value = codes.map((c) => lookupShortName(c)).join('\n');
      }
      renderTags(codes);
    }

    // Sync from tags → textarea
    const selectedCodes = new Set();
    function syncToTextarea() {
      const codes = Array.from(selectedCodes);
      ta.value = codes.join('\n');
      namesTa.value = codes.map((c) => lookupShortName(c)).join('\n');
      renderTags(codes);
    }

    function renderTags(codes) {
      selectedCodes.clear();
      codes.forEach((c) => selectedCodes.add(c));
      tagsEl.innerHTML = '';
      if (codes.length === 0) {
        tagsEl.innerHTML = '<span class="region-picker-empty">尚未选择任何配送区域</span>';
        return;
      }
      const sorted = Array.from(selectedCodes).sort();
      for (const code of sorted) {
        const tag = document.createElement('span');
        tag.className = 'region-picker-tag';
        tag.dataset.code = code;
        tag.innerHTML =
          '<span class="region-picker-tag-name">' +
            escapeHtml(lookupShortName(code)) +
          '</span>' +
          '<span class="region-picker-tag-code">' + escapeHtml(code) + '</span>' +
          '<button type="button" class="region-picker-tag-x" aria-label="移除">×</button>';
        tag.querySelector('.region-picker-tag-x').addEventListener('click', () => {
          selectedCodes.delete(code);
          syncToTextarea();
        });
        tagsEl.appendChild(tag);
      }
    }

    function escapeHtml(v) {
      return String(v).replace(/[&<>'"]/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
      }[c]));
    }

    // Button events
    openBtn.addEventListener('click', () => openPicker(selectedCodes, (newCodes) => {
      newCodes.forEach((c) => selectedCodes.add(c));
      syncToTextarea();
    }));
    clearBtn.addEventListener('click', () => {
      selectedCodes.clear();
      syncToTextarea();
    });

    // Also watch manual edits to textarea (for edge case)
    ta.addEventListener('input', syncFromTextarea);

    // Initial render
    syncFromTextarea();

    // Expose for fillDeliveryArea
    form.__syncRegionCodes = syncFromTextarea;
  }

  /**
   * 打开级联选择器 —— 独立模态，不影响 app.js 的 modal 系统
   */
  function openPicker(initialCodes, onConfirm) {
    const regions = getRegions();
    const tree = regions.tree;
    if (!tree.length) {
      alert('行政区数据尚未加载，请刷新页面。');
      return;
    }

    // Create overlay (independent of main modal system to avoid conflict)
    const overlay = document.createElement('div');
    overlay.className = 'region-picker-modal';
    overlay.innerHTML = [
      '<div class="region-picker-modal-box" role="dialog" aria-modal="true">',
      '  <div class="region-picker-modal-header">',
      '    <h3>选择配送区域（多选）</h3>',
      '    <button type="button" class="region-picker-modal-close" aria-label="关闭">×</button>',
      '  </div>',
      '  <div class="region-picker-modal-body">',
      '    <div class="region-picker-cols">',
      '      <div class="region-picker-col" data-col="province"></div>',
      '      <div class="region-picker-col" data-col="city"></div>',
      '      <div class="region-picker-col" data-col="district"></div>',
      '    </div>',
      '    <div class="region-picker-picked">',
      '      <div class="region-picker-picked-head"><strong>已选区域</strong> <span data-role="count">0</span> 项</div>',
      '      <div class="region-picker-picked-list" data-role="picked-list"></div>',
      '    </div>',
      '  </div>',
      '  <div class="region-picker-modal-footer">',
      '    <button type="button" class="region-picker-btn-secondary" data-role="cancel">取消</button>',
      '    <button type="button" class="primary" data-role="confirm">确认添加</button>',
      '  </div>',
      '</div>',
    ].join('\n');
    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';

    const colProvince = overlay.querySelector('[data-col="province"]');
    const colCity = overlay.querySelector('[data-col="city"]');
    const colDistrict = overlay.querySelector('[data-col="district"]');
    const pickedList = overlay.querySelector('[data-role="picked-list"]');
    const countEl = overlay.querySelector('[data-role="count"]');

    // State
    let picked = new Set(initialCodes || []);
    let activeProvinceCode = '';
    let activeCityCode = '';

    function updatePickedDisplay() {
      pickedList.innerHTML = '';
      const sorted = Array.from(picked).sort();
      sorted.forEach((code) => {
        const item = document.createElement('div');
        item.className = 'region-picker-picked-item';
        item.innerHTML =
          '<span>' + escapeHtml(lookupName(code)) + '</span>' +
          '<button type="button" class="region-picker-picked-x" aria-label="移除">×</button>';
        item.querySelector('button').addEventListener('click', () => {
          picked.delete(code);
          updatePickedDisplay();
          rerenderColumns();
        });
        pickedList.appendChild(item);
      });
      countEl.textContent = sorted.length;
    }

    function renderList(container, items, render, onItemClick, isPicked) {
      container.innerHTML = '';
      if (!items.length) {
        container.innerHTML = '<div class="region-picker-empty-col">—</div>';
        return;
      }
      items.forEach((item) => {
        const el = document.createElement('div');
        el.className = 'region-picker-item';
        el.innerHTML = render(item);
        if (isPicked && isPicked(item)) el.classList.add('is-picked');
        if (isPicked && !isPicked(item) && item.hasChildren) el.classList.add('is-parent');
        el.addEventListener('click', () => onItemClick(item, el));
        container.appendChild(el);
      });
    }

    function renderProvince(prov) {
      const pickedCountInProv = (prov.cities || []).reduce((sum, c) =>
        sum + (c.districts || []).filter((d) => picked.has(d.code)).length, 0);
      const extra = pickedCountInProv > 0 ? ' <small>(' + pickedCountInProv + ')</small>' : '';
      return '<span>' + escapeHtml(prov.name) + '</span>' + extra;
    }
    function renderCity(city) {
      const pickedCountInCity = (city.districts || []).filter((d) => picked.has(d.code)).length;
      const extra = pickedCountInCity > 0 ? ' <small>(' + pickedCountInCity + ')</small>' : '';
      return '<span>' + escapeHtml(city.name) + '</span>' + extra;
    }
    function renderDistrict(dist) {
      const tick = picked.has(dist.code) ? ' ✓' : '';
      return '<span>' + escapeHtml(dist.name) + '</span>' +
             '<code style="color:#999;font-size:11px;margin-left:4px">' + escapeHtml(dist.code) + '</code>' + tick;
    }

    function rerenderColumns() {
      // Provinces
      renderList(colProvince, tree, renderProvince, (prov) => {
        activeProvinceCode = prov.code;
        activeCityCode = '';
        rerenderColumns();
      }, (prov) => {
        // Any picked district in this province
        return (prov.cities || []).some((c) => (c.districts || []).some((d) => picked.has(d.code)));
      });

      // Cities (only if a province is selected)
      if (activeProvinceCode) {
        const prov = tree.find((p) => p.code === activeProvinceCode);
        const cities = prov ? prov.cities : [];
        renderList(colCity, cities, renderCity, (city) => {
          activeCityCode = city.code;
          rerenderColumns();
        }, (city) => {
          return (city.districts || []).some((d) => picked.has(d.code));
        });
        colProvince.querySelectorAll('.region-picker-item').forEach((el) => {
          if (el.textContent.includes(lookupShortName(activeProvinceCode))) {
            // mark active
          }
        });
        colCity.querySelectorAll('.region-picker-item').forEach((el) => el.classList.remove('is-active'));
        const activeCity = cities.find((c) => c.code === activeCityCode);
        colCity.querySelectorAll('.region-picker-item').forEach((el, i) => {
          if (cities[i] === activeCity) el.classList.add('is-active');
        });
      } else {
        colCity.innerHTML = '<div class="region-picker-empty-col">请先选择省份</div>';
      }

      // Districts (only if a city is selected)
      if (activeCityCode) {
        const prov = tree.find((p) => p.code === activeProvinceCode);
        const city = prov ? prov.cities.find((c) => c.code === activeCityCode) : null;
        const districts = city ? city.districts : [];
        renderList(colDistrict, districts, renderDistrict, (dist) => {
          if (picked.has(dist.code)) picked.delete(dist.code);
          else picked.add(dist.code);
          updatePickedDisplay();
          rerenderColumns();
        }, (dist) => picked.has(dist.code));
      } else {
        colDistrict.innerHTML = '<div class="region-picker-empty-col">请先选择市/区</div>';
      }

      // Highlight active province
      colProvince.querySelectorAll('.region-picker-item').forEach((el, i) => {
        const code = tree[i] && tree[i].code;
        el.classList.toggle('is-active', code === activeProvinceCode);
      });
    }

    // Initial state — pick the first province to show something useful
    if (tree.length) {
      activeProvinceCode = tree[0].code;
      activeCityCode = (tree[0].cities && tree[0].cities.length) ? tree[0].cities[0].code : '';
    }

    rerenderColumns();
    updatePickedDisplay();

    // Event bindings
    overlay.querySelector('.region-picker-modal-close').addEventListener('click', close);
    overlay.querySelector('[data-role="cancel"]').addEventListener('click', close);
    overlay.querySelector('[data-role="confirm"]').addEventListener('click', () => {
      const newCodes = Array.from(picked);
      onConfirm(newCodes);
      close();
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    function close() {
      overlay.classList.add('is-closing');
      setTimeout(() => {
        document.body.style.overflow = '';
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      }, 150);
    }
  }

  function escapeHtml(v) {
    return String(v).replace(/[&<>'"]/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
    }[c]));
  }

  // Auto-enhance on DOM ready
  function boot() {
    const form = document.getElementById('deliveryAreaForm');
    if (form) enhanceDeliveryAreaForm(form);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Expose for programmatic use
  const g = typeof window !== 'undefined' ? window : globalThis;
  g.MENGSHIXIAN_REGION_PICKER = {
    enhance: enhanceDeliveryAreaForm,
    open: openPicker,
    lookupName: lookupName,
    lookupShortName: lookupShortName,
  };
})();
