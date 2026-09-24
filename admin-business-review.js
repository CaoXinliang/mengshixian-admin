(function attachBusinessReview(global, document) {
  'use strict';
  const dialog = document.getElementById('businessReviewDialog');
  if (!dialog) return;
  const status = document.getElementById('businessReviewStatus');
  const fields = document.getElementById('businessReviewFields');
  const confirmed = document.getElementById('businessReviewConfirmed');
  const decisions = [...dialog.querySelectorAll('[data-business-decision]')];
  const evidence = [
    { image: document.getElementById('businessStorefrontImage'), status: document.getElementById('businessStorefrontStatus'), field: 'storefrontPreviewUrl', label: '门头照片', loaded: false },
    { image: document.getElementById('businessLicenseImage'), status: document.getElementById('businessLicenseStatus'), field: 'licensePreviewUrl', label: '营业执照', loaded: false }
  ];
  const labels = [
    ['companyName', '企业名称'], ['storeName', '门店名称'], ['storeAddress', '门店地址'],
    ['mainBusinessType', '主营类型'], ['unifiedCode', '统一社会信用代码'],
    ['contactName', '联系人'], ['contactPhoneMasked', '联系电话']
  ];
  let dependencies;
  let current;
  let generation = 0;
  let busy = false;

  function canDecide() {
    return current?.status === 'pending' && Boolean(current.reviewToken) && confirmed.checked && evidence.every((item) => item.loaded) && !busy;
  }

  function updateDecisions() {
    for (const button of decisions) button.disabled = !canDecide();
  }

  function clearEvidence() {
    for (const item of evidence) {
      item.loaded = false;
      item.image.onload = null;
      item.image.onerror = null;
      item.image.removeAttribute('src');
      item.image.style.display = 'none';
      item.status.textContent = '等待预览';
    }
  }

  function showFields(detail) {
    fields.replaceChildren();
    for (const [key, label] of labels) {
      const term = document.createElement('dt');
      const value = document.createElement('dd');
      term.textContent = label;
      value.textContent = key === 'mainBusinessType' ? ({ restaurant: '餐饮', retail: '零售' }[detail[key]] || detail[key] || '未填写') : detail[key] || '未填写';
      fields.append(term, value);
    }
  }

  function loadEvidence(item, detail, request) {
    const url = detail[item.field];
    if (!url) {
      item.status.textContent = `缺少${item.label}或预览地址，不能提交审核。`;
      return;
    }
    item.status.textContent = '正在加载图片…';
    item.image.onload = () => {
      if (request !== generation) return;
      item.loaded = item.image.naturalWidth > 0;
      item.image.style.display = item.loaded ? 'block' : 'none';
      item.status.textContent = item.loaded ? '已加载，请核对实际内容。' : '图片无法显示，不能提交审核。';
      updateDecisions();
    };
    item.image.onerror = () => {
      if (request !== generation) return;
      item.loaded = false;
      item.image.style.display = 'none';
      item.status.textContent = '图片加载失败，请稍后重试；当前不能提交审核。';
      updateDecisions();
    };
    item.image.src = url;
  }

  async function open(record) {
    if (!record?._id) throw new Error('找不到这条企业申请，请刷新后重试。');
    const request = ++generation;
    current = null;
    busy = false;
    confirmed.checked = false;
    fields.replaceChildren();
    clearEvidence();
    status.textContent = '正在读取申请资料…';
    updateDecisions();
    if (!dialog.open) dialog.showModal();
    try {
      const detail = await dependencies.call('admin.businessApplications.reviewDetail', { id: record._id });
      if (request !== generation || !dialog.open) return;
      current = detail;
      showFields(detail);
      status.textContent = detail.status === 'pending' ? '请先核对申请信息与两张图片，再选择审核结果。' : '该申请已处理，不能重复审核。';
      for (const item of evidence) loadEvidence(item, detail, request);
      updateDecisions();
    } catch (error) {
      if (request !== generation) return;
      status.textContent = `申请资料读取失败：${error.message || '请稍后重试。'}`;
      updateDecisions();
    }
  }

  async function submit(decision) {
    if (!canDecide() || !['approved', 'rejected'].includes(decision)) return;
    const detail = current;
    const confirmType = decision === 'approved' ? 'businessApprove' : 'businessReject';
    if (!global.MengshixianAdminOperationsConfirm.ask(confirmType, detail)) return;
    busy = true;
    updateDecisions();
    try {
      await dependencies.call('admin.businessApplications.review', { id: detail._id, decision, reviewToken: detail.reviewToken });
      dialog.close();
      await dependencies.refresh();
      dependencies.message(decision === 'approved' ? '企业申请已通过。' : '企业申请已驳回。');
    } catch (error) {
      if (error.code === 'BUSINESS_APPLICATION_CHANGED') {
        current = null;
        confirmed.checked = false;
        clearEvidence();
        status.textContent = '申请人已修改资料，请关闭后重新打开核对。';
        try { await dependencies.refresh(); } catch (_) { /* Keep the original conflict visible. */ }
      } else {
        status.textContent = `审核未保存：${error.message || '请稍后重试。'}`;
      }
      dependencies.message(error.message || '审核未保存。', true);
    } finally {
      busy = false;
      updateDecisions();
    }
  }

  function mount(options) {
    dependencies = options;
    document.getElementById('businessReviewClose').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => { generation += 1; current = null; clearEvidence(); confirmed.checked = false; updateDecisions(); });
    confirmed.addEventListener('change', updateDecisions);
    for (const button of decisions) button.addEventListener('click', () => { void submit(button.dataset.businessDecision); });
  }

  global.MengshixianBusinessReview = Object.freeze({ mount, open });
}(window, document));
