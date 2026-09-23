const { fail } = require('./response');
function pad2(n) { return String(n).padStart(2, '0'); }
function formatDateTimeLocal(date) {
  if (!(date instanceof Date)) date = new Date(date);
  const cn = new Date(date.getTime() + 8 * 3600 * 1000);
  return cn.getUTCFullYear() + '-' + pad2(cn.getUTCMonth() + 1) + '-' + pad2(cn.getUTCDate())
    + ' ' + pad2(cn.getUTCHours()) + ':' + pad2(cn.getUTCMinutes()) + ':' + pad2(cn.getUTCSeconds());
}

const { randomId } = require('./security');
const { groupMemberId } = require('./transaction-ids');

function active(campaign, now) {
  if (!campaign || campaign.status !== 'active') return false;
  const point = now.getTime();
  return !(campaign.startAt && new Date(campaign.startAt).getTime() > point) && !(campaign.endAt && new Date(campaign.endAt).getTime() < point);
}

async function createGroup({ store, user, campaign, now }) {
  const size = Number(campaign.groupSize || 0);
  if (!Number.isInteger(size) || size < 2 || size > 12) fail('GROUP_SIZE_INVALID', '拼团人数必须为 2 到 12 人。');
  const timestamp = formatDateTimeLocal(now);
  return store.create('groups', {
    groupNo: `G${randomId('').slice(-12).toUpperCase()}`,
    campaignId: campaign._id,
    ownerUserId: user._id,
    groupSize: size,
    status: 'open',
    reservedMemberCount: 0,
    memberCount: 0,
    reservedUserIds: [],
    reservedOrderIds: [],
    memberUserIds: [],
    memberOrderIds: [],
    orderIds: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: formatDateTimeLocal(new Date(now.getTime() + Number(campaign.durationMinutes) * 60 * 1000))
  });
}

async function reserveSlot(tx, { groupId, campaignId, userId, orderId, now }) {
  const group = await tx.getById('groups', groupId);
  if (!group || group.campaignId !== campaignId || group.status !== 'open') fail('GROUP_NOT_AVAILABLE', '拼团不存在、已结束或活动不匹配。');
  if (Number(group.reservedMemberCount || 0) >= Number(group.groupSize || 0)) fail('GROUP_FULL', '该拼团名额已满。');
  const reservedUsers = group.reservedUserIds || [];
  const memberUsers = group.memberUserIds || [];
  if (reservedUsers.includes(userId) || memberUsers.includes(userId)) fail('GROUP_ALREADY_JOINED', '当前用户已参加该拼团。');
  const timestamp = formatDateTimeLocal(now);
  await tx.update('groups', group._id, {
    reservedMemberCount: Number(group.reservedMemberCount || 0) + 1,
    reservedUserIds: [...reservedUsers, userId],
    reservedOrderIds: [...(group.reservedOrderIds || []), orderId],
    orderIds: [...(group.orderIds || []), orderId],
    updatedAt: timestamp
  });
  return { ...group, reservedMemberCount: Number(group.reservedMemberCount || 0) + 1 };
}

async function releaseSlot(tx, { groupId, orderId, now }) {
  if (!groupId) return false;
  const group = await tx.getById('groups', groupId);
  if (!group) return false;
  const member = await tx.getById('group_members', groupMemberId(groupId, orderId));
  if (member && member.status === 'active') return false;
  const order = await tx.getById('orders', orderId);
  const userId = order && order.userId;
  const reservedOrderIds = (group.reservedOrderIds || []).filter((id) => id !== orderId);
  const reservedUserIds = userId ? (group.reservedUserIds || []).filter((id) => id !== userId) : (group.reservedUserIds || []);
  if (reservedOrderIds.length === (group.reservedOrderIds || []).length) return false;
  await tx.update('groups', group._id, {
    reservedMemberCount: Math.max(Number(group.memberCount || 0), Number(group.reservedMemberCount || 0) - 1),
    reservedOrderIds,
    reservedUserIds,
    updatedAt: formatDateTimeLocal(now)
  });
  return true;
}

async function recordPaidMember(tx, { groupId, orderId, userId, now }) {
  const group = await tx.getById('groups', groupId);
  if (!group || group.status !== 'open') fail('GROUP_NOT_AVAILABLE', '拼团已结束，不能确认本次参团。');
  const memberDocumentId = groupMemberId(groupId, orderId);
  const existing = await tx.getById('group_members', memberDocumentId);
  if (existing && existing.status === 'active') return { group, idempotent: true };
  if (Number(group.memberCount || 0) >= Number(group.groupSize || 0)) fail('GROUP_FULL', '拼团已满。');
  const timestamp = formatDateTimeLocal(now);
  const member = { _id: memberDocumentId, groupId, orderId, userId, status: 'active', paidAt: timestamp, createdAt: existing && existing.createdAt || timestamp, updatedAt: timestamp };
  await tx.set('group_members', memberDocumentId, member);
  const memberCount = Number(group.memberCount || 0) + 1;
  const success = memberCount >= Number(group.groupSize || 0);
  const memberOrderIds = [...new Set([...(group.memberOrderIds || []), orderId])];
  const memberUserIds = [...new Set([...(group.memberUserIds || []), userId])];
  await tx.update('groups', group._id, {
    memberCount,
    status: success ? 'success' : 'open',
    successAt: success ? timestamp : '',
    memberOrderIds,
    memberUserIds,
    reservedOrderIds: (group.reservedOrderIds || []).filter((id) => id !== orderId),
    reservedUserIds: (group.reservedUserIds || []).filter((id) => id !== userId),
    updatedAt: timestamp
  });
  if (success) await Promise.all(memberOrderIds.map((id) => tx.update('orders', id, { groupStatus: 'success', updatedAt: timestamp })));
  return { group: { ...group, memberCount, status: success ? 'success' : 'open', memberOrderIds, memberUserIds }, member, idempotent: false };
}

async function removePaidMember(tx, { groupId, orderId, now }) {
  if (!groupId) return false;
  const memberDocumentId = groupMemberId(groupId, orderId);
  const member = await tx.getById('group_members', memberDocumentId);
  if (!member || member.status !== 'active') return false;
  const group = await tx.getById('groups', groupId);
  if (!group) return false;
  const timestamp = formatDateTimeLocal(now);
  await tx.update('group_members', memberDocumentId, { status: 'refunded', refundedAt: timestamp, updatedAt: timestamp });
  await tx.update('groups', group._id, {
    memberCount: Math.max(0, Number(group.memberCount || 0) - 1),
    memberOrderIds: (group.memberOrderIds || []).filter((id) => id !== orderId),
    memberUserIds: (group.memberUserIds || []).filter((id) => id !== member.userId),
    status: 'open',
    successAt: '',
    updatedAt: timestamp
  });
  return true;
}

module.exports = { active, createGroup, reserveSlot, releaseSlot, recordPaidMember, removePaidMember };
