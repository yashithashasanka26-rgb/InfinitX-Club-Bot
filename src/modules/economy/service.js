const mongoose = require('mongoose');
const { Economy, EconomyTransaction } = require('../../database/models');

const MAX_BALANCE = Number.MAX_SAFE_INTEGER;
const PERIODS = {
  daily: { field: 'lastDailyAt', durationMs: 24 * 60 * 60 * 1000 },
  weekly: { field: 'lastWeeklyAt', durationMs: 7 * 24 * 60 * 60 * 1000 },
};

function validateAmount(amount) {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new TypeError('Amount must be a positive safe integer.');
  }
}

async function ensureAccount(guildId, userId) {
  try {
    await Economy.updateOne(
      { guildId, userId },
      { $setOnInsert: { guildId, userId } },
      { upsert: true, setDefaultsOnInsert: true },
    );
  } catch (error) {
    if (error.code !== 11000) throw error;
  }
}

async function claimReward({ guildId, userId, kind, amount }) {
  validateAmount(amount);
  const period = PERIODS[kind];
  if (!period) throw new TypeError('Unsupported reward period.');
  await ensureAccount(guildId, userId);
  const session = await mongoose.startSession();
  const now = new Date();
  try {
    let account;
    let reason;
    await session.withTransaction(async () => {
      account = await Economy.findOneAndUpdate(
        {
          guildId,
          userId,
          coins: { $lte: MAX_BALANCE - amount },
          $or: [
            { [period.field]: null },
            { [period.field]: { $lte: new Date(now.getTime() - period.durationMs) } },
          ],
        },
        { $inc: { coins: amount }, $set: { [period.field]: now } },
        { new: true, session },
      );
      if (!account) {
        const current = await Economy.findOne({ guildId, userId }).session(session).lean();
        reason = current?.[period.field] && now - current[period.field] < period.durationMs
          ? 'cooldown'
          : 'balance-limit';
        return;
      }
      await EconomyTransaction.create([{
        guildId,
        type: kind,
        amount,
        recipientId: userId,
        details: { balance: account.coins },
      }], { session });
    });
    return { account: account || null, reason };
  } finally {
    await session.endSession();
  }
}

async function claimDaily(guildId, userId, amount = 100) {
  return claimReward({ guildId, userId, kind: 'daily', amount });
}

async function claimWeekly(guildId, userId, amount = 500) {
  return claimReward({ guildId, userId, kind: 'weekly', amount });
}

async function work({ guildId, userId, min = 25, max = 100, cooldownHours = 1, random = Math.random }) {
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min <= 0 || max < min) {
    throw new TypeError('Work reward range is invalid.');
  }
  if (!Number.isSafeInteger(cooldownHours) || cooldownHours < 1 || cooldownHours > 168) {
    throw new TypeError('Work cooldown must be between 1 and 168 hours.');
  }
  const amount = Math.floor(random() * (max - min + 1)) + min;
  validateAmount(amount);
  await ensureAccount(guildId, userId);
  const now = new Date();
  const cooldownMs = cooldownHours * 60 * 60 * 1000;
  const session = await mongoose.startSession();
  try {
    let account;
    let reason;
    await session.withTransaction(async () => {
      account = await Economy.findOneAndUpdate(
        {
          guildId,
          userId,
          coins: { $lte: MAX_BALANCE - amount },
          $or: [{ lastWorkAt: null }, { lastWorkAt: { $lte: new Date(now.getTime() - cooldownMs) } }],
        },
        { $inc: { coins: amount }, $set: { lastWorkAt: now } },
        { new: true, session },
      );
      if (!account) {
        const current = await Economy.findOne({ guildId, userId }).session(session).lean();
        reason = current?.lastWorkAt && now - current.lastWorkAt < cooldownMs ? 'cooldown' : 'balance-limit';
        return;
      }
      await EconomyTransaction.create([{
        guildId,
        type: 'work',
        amount,
        recipientId: userId,
        details: { balance: account.coins },
      }], { session });
    });
    return { account: account || null, amount, reason };
  } finally {
    await session.endSession();
  }
}

async function pay({ guildId, senderId, recipientId, amount }) {
  validateAmount(amount);
  if (senderId === recipientId) throw new TypeError('You cannot pay yourself.');
  await Promise.all([ensureAccount(guildId, senderId), ensureAccount(guildId, recipientId)]);

  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const debit = await Economy.updateOne(
        { guildId, userId: senderId, coins: { $gte: amount } },
        { $inc: { coins: -amount } },
        { session },
      );
      if (debit.modifiedCount !== 1) {
        const sender = await Economy.findOne({ guildId, userId: senderId }).session(session).lean();
        throw new Error(sender?.coins > MAX_BALANCE - amount ? 'balance-limit' : 'insufficient-funds');
      }
      const credit = await Economy.updateOne(
        { guildId, userId: recipientId, coins: { $lte: MAX_BALANCE - amount } },
        { $inc: { coins: amount } },
        { session },
      );
      if (credit.modifiedCount !== 1) throw new Error('recipient-balance-limit');
      await EconomyTransaction.create([{
        guildId,
        type: 'pay',
        amount,
        senderId,
        recipientId,
      }], { session });
      const [sender, recipient] = await Promise.all([
        Economy.findOne({ guildId, userId: senderId }).session(session).lean(),
        Economy.findOne({ guildId, userId: recipientId }).session(session).lean(),
      ]);
      result = { sender, recipient };
    });
    return result;
  } catch (error) {
    if (['insufficient-funds', 'balance-limit', 'recipient-balance-limit'].includes(error.message)) {
      return { reason: error.message };
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

async function purchaseItem({ guildId, userId, item, quantity = 1 }) {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99) {
    throw new TypeError('Quantity must be between 1 and 99.');
  }
  if (!item || typeof item.itemId !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(item.itemId)) {
    throw new TypeError('Shop item is invalid.');
  }
  const total = item.price * quantity;
  validateAmount(total);
  await ensureAccount(guildId, userId);

  const inventory = { $ifNull: ['$inventory', []] };
  const itemId = { $literal: item.itemId };
  const hasSpace = {
    $or: [
      { $lt: [{ $size: inventory }, 100] },
      {
        $gt: [{
          $size: {
            $filter: {
              input: inventory,
              as: 'entry',
              cond: {
                $and: [
                  { $eq: ['$$entry.itemId', itemId] },
                  { $lte: ['$$entry.quantity', 1_000_000 - quantity] },
                ],
              },
            },
          },
        }, 0],
      },
    ],
  };
  const session = await mongoose.startSession();
  try {
    let account;
    await session.withTransaction(async () => {
      account = await Economy.findOneAndUpdate(
        { guildId, userId, coins: { $gte: total }, $expr: hasSpace },
        [{
          $set: {
            coins: { $subtract: ['$coins', total] },
            inventory: {
              $cond: [
                { $in: [itemId, { $map: { input: inventory, as: 'entry', in: '$$entry.itemId' } }] },
                {
                  $map: {
                    input: inventory,
                    as: 'entry',
                    in: {
                      $cond: [
                        { $eq: ['$$entry.itemId', itemId] },
                        { $mergeObjects: ['$$entry', { quantity: { $add: ['$$entry.quantity', quantity] } }] },
                        '$$entry',
                      ],
                    },
                  },
                },
                {
                  $concatArrays: [
                    inventory,
                    [{ itemId, quantity: { $literal: quantity } }],
                  ],
                },
              ],
            },
          },
        }],
        { new: true, session },
      );
      if (!account) return;
      await EconomyTransaction.create([{
        guildId,
        type: 'purchase',
        amount: total,
        recipientId: userId,
        itemId: item.itemId,
        details: { quantity, balance: account.coins },
      }], { session });
    });
    if (account) return { account, reason: null };
    const current = await Economy.findOne({ guildId, userId }).lean();
    return {
      account: null,
      reason: current?.coins < total ? 'insufficient-funds' : 'inventory-limit',
    };
  } finally {
    await session.endSession();
  }
}

async function getBalance(guildId, userId) {
  const account = await Economy.findOne({ guildId, userId }).lean();
  return account || { guildId, userId, coins: 0, inventory: [] };
}

async function getInventory(guildId, userId) {
  const account = await Economy.findOne({ guildId, userId }).lean();
  return account?.inventory || [];
}

module.exports = {
  claimDaily,
  claimReward,
  claimWeekly,
  ensureAccount,
  getBalance,
  getInventory,
  pay,
  purchaseItem,
  work,
};
