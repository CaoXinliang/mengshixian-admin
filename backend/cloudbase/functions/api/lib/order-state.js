const { fail } = require('./response');

const TRANSITIONS = {
  pending_payment: ['pending_confirmation', 'cancelled'],
  pending_confirmation: ['picking', 'cancelled'],
  picking: ['shipping', 'cancelled'],
  shipping: ['completed'],
  delivered: ['completed'],
  completed: ['shipping', 'cancelled'],
  cancelled: []
};

function assertTransition(from, to, actor) {
  if (!Object.prototype.hasOwnProperty.call(TRANSITIONS, from) || !Object.prototype.hasOwnProperty.call(TRANSITIONS, to)) {
    fail('ORDER_STATUS_INVALID', '订单状态不合法。');
  }
  if (!TRANSITIONS[from].includes(to)) fail('ORDER_STATUS_TRANSITION_INVALID', '当前订单不能执行该状态流转。');
  if (actor === 'customer' && !(from === 'delivered' && to === 'completed')) {
    fail('ORDER_STATUS_FORBIDDEN', '用户只能确认已送达订单。');
  }
  return true;
}

module.exports = { TRANSITIONS, assertTransition };
