const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const simpleHtml = fs.readFileSync(path.join(root, 'simple.html'), 'utf8');
const simpleSource = fs.readFileSync(path.join(root, 'simple.js'), 'utf8');
const advancedHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const advancedSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

assert.equal([...simpleHtml.matchAll(/<button data-view="(dashboard|orders|products|inventory|refunds|customers|delivery|marketing|settings)"[^>]*>/g)].length, 9, '售后工作台不得增加第十个一级入口');
assert.match(simpleHtml, /id="refundChips"[\s\S]*data-refund-filter="manual"/, '普通后台必须提供人工退款待办筛选');
assert.match(simpleSource, /api\.call\('admin\.refunds\.get', \{ id \}\)/, '普通后台必须读取售后详情');
assert.match(simpleSource, /api\.call\('admin\.refunds\.review', \{ id, decision, reviewNote, idempotencyKey: newIdempotencyKey\(\) \}\)/, '普通后台审核必须携带说明和幂等键');
assert.match(simpleSource, /api\.call\('admin\.refunds\.process', \{ id, action: 'channel_pending', idempotencyKey: newIdempotencyKey\(\), note \}\)/, '普通后台只能登记 channel_pending');
assert.match(simpleSource, /登记为已提交退款渠道/, '普通后台必须使用准确的渠道登记文案');
assert.match(simpleSource, /此操作不代表退款成功/, '普通后台危险操作必须明确不是退款成功');
assert.match(simpleSource, /status === 'succeeded' && refund\.channelStatus !== 'succeeded'/, '普通后台不得无渠道成功时显示退款成功');
assert.match(simpleSource, /creditAdjustmentCent/, '普通后台必须展示账期应收冲减');
assert.match(simpleSource, /cashRefundRequiredCent/, '普通后台必须展示仍需原路退款金额');

assert.match(advancedHtml, /id="advancedRefundFilter"/, '高级后台必须提供售后筛选');
assert.match(advancedHtml, /id="advancedRefundDetail"/, '高级后台必须提供售后详情区');
assert.match(advancedSource, /call\('admin\.refunds\.get', \{ id \}\)/, '高级后台必须读取售后详情');
assert.match(advancedSource, /售后详情加载失败[\s\S]*data-refund-detail=/, '高级后台详情失败时必须允许重试');
assert.match(advancedSource, /action: 'channel_pending', idempotencyKey: newIdempotencyKey\(\), note:/, '高级后台只能登记 channel_pending 并携带幂等键');
assert.match(advancedSource, /审核通过不代表退款成功/, '高级后台审核通过前必须明确后续渠道边界');
assert.match(advancedSource, /此操作不代表退款成功/, '高级后台渠道登记前必须二次确认');
assert.match(advancedSource, /refund\.status === 'succeeded' && refund\.channelStatus !== 'succeeded'/, '高级后台不得无渠道成功时显示退款成功');
assert.match(advancedSource, /creditAdjustmentCent/, '高级后台必须展示账期应收冲减');
assert.match(advancedSource, /cashRefundRequiredCent/, '高级后台必须展示仍需原路退款金额');
assert.match(advancedSource, /售后退款不代表退货商品已经入库/, '后台不得暗示退款自动回补库存');
assert.match(simpleSource, /item\.paidSubtotalCent === undefined \? item\.amountCent : item\.paidSubtotalCent/, '普通后台售后明细必须优先展示订单项实付分摊');
assert.match(advancedSource, /item\.paidSubtotalCent === undefined \? item\.amountCent : item\.paidSubtotalCent/, '高级后台售后明细必须优先展示订单项实付分摊');

for (const forbidden of ['mark_manual_pending', 'manual_success', "action: 'succeeded'", "action: 'retry_channel'"]) {
  assert(!simpleSource.includes(forbidden) && !advancedSource.includes(forbidden), `frontend must not invent ${forbidden}`);
}

console.log('admin refund workbench contract: passed');
