const _ = require('lodash');
const { Op, Sequelize, QueryTypes } = require('sequelize');
const moment = require('moment');
const PERIODS = require('../../constants/periods');
const { ALL_METRICS, getValueKey, getRankKey, getMeasure, isSkill } = require('../../constants/metrics');
const { Group, Membership, Player, sequelize } = require('../../../database');
const { generateVerification, verifyCode } = require('../../util/verification');
const { getCombatLevel, getTotalLevel, get200msCount, getLevel } = require('../../util/level');
const { BadRequestError } = require('../../errors');
const playerService = require('../players/player.service');
const deltaService = require('../deltas/delta.service');
const achievementService = require('../achievements/achievement.service');
const competitionService = require('../competitions/competition.service');
const recordService = require('../records/record.service');
const snapshotService = require('../snapshots/snapshot.service');

function sanitizeName(name) {
  return name
    .replace(/_/g, ' ')
    .replace(/-/g, ' ')
    .replace(/ +(?= )/g, '')
    .trim();
}

function format(group) {
  return _.omit(group.toJSON(), ['verificationHash']);
}

/**
 * Returns a list of all groups that partially match the given name.
 */
async function list(name, pagination) {
  // Fetch all groups that match the name
  const groups = await Group.findAll({
    where: name && { name: { [Op.iLike]: `%${sanitizeName(name)}%` } },
    order: [
      ['score', 'DESC'],
      ['id', 'ASC']
    ],
    limit: pagination.limit,
    offset: pagination.offset
  });

  // Fetch and attach member counts for each group
  const completeGroups = await attachMembersCount(groups.map(format));

  return completeGroups;
}

/**
 * Returns a list of all groups of which a given player is a member.
 */
async function findForPlayer(playerId, pagination) {
  if (!playerId) {
    throw new BadRequestError(`Invalid player id.`);
  }

  // Find all memberships for the player
  const memberships = await Membership.findAll({
    where: { playerId },
    include: [{ model: Group }]
  });

  // Extract all the unique groups from the memberships, and format them.
  const groups = _.uniqBy(memberships, m => m.group.id)
    .slice(pagination.offset, pagination.offset + pagination.limit)
    .map(p => p.group)
    .sort((a, b) => b.score - a.score)
    .map(format);

  const completeGroups = await attachMembersCount(groups);

  return completeGroups;
}

/**
 * Given a list of groups, it will fetch the member count of each,
 * and inserts a "memberCount" field in every group object.
 */
async function attachMembersCount(groups) {
  /**
   * Will return a members count for every group, with the format:
   * [ {groupId: 35, count: "4"}, {groupId: 41, count: "31"} ]
   */
  const membersCount = await Membership.findAll({
    where: { groupId: groups.map(g => g.id) },
    attributes: ['groupId', [Sequelize.fn('COUNT', Sequelize.col('groupId')), 'count']],
    group: ['groupId']
  });

  /**
   * Convert the counts fetched above, into a key:value format:
   * { 35: 4, 41: 31 }
   */
  const countMap = _.mapValues(
    _.keyBy(
      membersCount.map(c => ({ groupId: c.groupId, count: parseInt(c.toJSON().count, 10) })),
      c => c.groupId
    ),
    c => c.count
  );

  return groups.map(g => ({ ...g, memberCount: countMap[g.id] || 0 }));
}

/**
 * Get all the data on a given group. (Info and members)
 */
async function view(id) {
  if (!id) {
    throw new BadRequestError('Invalid group id.');
  }

  const group = await Group.findOne({ where: { id } });

  if (!group) {
    throw new BadRequestError(`Group of id ${id} was not found.`);
  }

  return format(group);
}

async function getMonthlyTopPlayer(groupId) {
  if (!groupId) {
    throw new BadRequestError('Invalid group id.');
  }

  const memberships = await Membership.findAll({
    where: { groupId },
    attributes: ['playerId']
  });

  const memberIds = memberships.map(m => m.playerId);

  if (!memberIds.length) {
    return null;
  }

  const pagination = { limit: 1, offset: 0 };
  const leaderboard = await deltaService.getGroupLeaderboard('overall', 'month', memberIds, pagination);

  const monthlyTopPlayer = leaderboard[0] || null;

  return monthlyTopPlayer;
}

/**
 * Gets the current gains leaderboard for a specific metric and period,
 * between the members of a group.
 */
async function getDeltas(groupId, period, metric, pagination) {
  if (!groupId) {
    throw new BadRequestError('Invalid group id.');
  }

  if (!period || !PERIODS.includes(period)) {
    throw new BadRequestError(`Invalid period: ${period}.`);
  }

  if (!metric || !ALL_METRICS.includes(metric)) {
    throw new BadRequestError(`Invalid metric: ${metric}.`);
  }

  const memberships = await Membership.findAll({
    where: { groupId },
    attributes: ['playerId']
  });

  const memberIds = memberships.map(m => m.playerId);

  if (!memberIds.length) {
    throw new BadRequestError(`That group has no members.`);
  }

  const leaderboard = await deltaService.getGroupLeaderboard(metric, period, memberIds, pagination);
  return leaderboard;
}

/**
 * Get the 10 most recent player achievements for a given group.
 */
async function getAchievements(groupId, pagination) {
  if (!groupId) {
    throw new BadRequestError('Invalid group id.');
  }

  const memberships = await Membership.findAll({
    where: { groupId },
    attributes: ['playerId'],
    include: [{ model: Player }]
  });

  if (!memberships.length) {
    throw new BadRequestError(`That group has no members.`);
  }

  const members = memberships.map(m => m.player);
  const memberMap = _.keyBy(members, 'id');
  const memberIds = members.map(m => m.id);

  const achievements = await achievementService.findAllForGroup(memberIds, pagination);

  const formatted = achievements.map(a => {
    const { id, username, displayName, type } = memberMap[a.playerId];
    return {
      ...a.toJSON(),
      player: { id, username, displayName, type }
    };
  });

  return formatted;
}

/**
 * Gets the top records for a specific metric and period,
 * between the members of a group.
 */
async function getRecords(groupId, metric, period, pagination) {
  if (!groupId) {
    throw new BadRequestError('Invalid group id.');
  }

  if (!period || !PERIODS.includes(period)) {
    throw new BadRequestError(`Invalid period: ${period}.`);
  }

  if (!metric || !ALL_METRICS.includes(metric)) {
    throw new BadRequestError(`Invalid metric: ${metric}.`);
  }

  const memberships = await Membership.findAll({
    where: { groupId },
    attributes: ['playerId']
  });

  if (!memberships.length) {
    throw new BadRequestError(`That group has no members.`);
  }

  const memberIds = memberships.map(m => m.playerId);
  const records = await recordService.getGroupLeaderboard(metric, period, memberIds, pagination);

  return records;
}

async function getMembersList(id) {
  if (!id) {
    throw new BadRequestError('Invalid group id.');
  }

  const group = await Group.findOne({ where: { id } });

  if (!group) {
    throw new BadRequestError(`Group of id ${id} was not found.`);
  }

  // Fetch all memberships for the group
  const memberships = await Membership.findAll({
    attributes: ['groupId', 'playerId', 'role'],
    where: { groupId: id },
    include: [{ model: Player }]
  });

  if (!memberships || memberships.length === 0) {
    return [];
  }

  const query = `
    SELECT s."playerId", s."overallExperience"
    FROM (SELECT q."playerId", MAX(q."createdAt") AS max_date
          FROM public.snapshots q
          WHERE q."playerId" IN (${memberships.map(m => m.player.id).join(',')})
          GROUP BY q."playerId"
          ) r
    JOIN public.snapshots s
      ON s."playerId" = r."playerId" AND s."createdAt" = r.max_date
    ORDER BY s."playerId"
  `;

  // Execute the query above, which returns the latest snapshot for each member,
  // in the following format: [{playerId: 61, overallExerience: "4465456"}]
  // Note: this used to be a sequelize query, but it was very slow for large groups
  const experienceSnapshots = await sequelize.query(query, { type: QueryTypes.SELECT });

  // Formats the experience snapshots to a key:value map, like: {"61": 4465456}.
  const experienceMap = _.mapValues(_.keyBy(experienceSnapshots, 'playerId'), d =>
    parseInt(d.overallExperience, 10)
  );

  // Format all the members, add each experience to its respective player, and sort them by role
  return memberships
    .map(({ player, role }) => ({ ...player.toJSON(), role }))
    .map(member => ({ ...member, overallExperience: experienceMap[member.id] || 0 }))
    .sort((a, b) => a.role.localeCompare(b.role));
}

/**
 * Gets the group hiscores for a specific metric.
 * All members which HAVE SNAPSHOTS will included and sorted by rank.
 */
async function getHiscores(id, metric, pagination) {
  if (!id) {
    throw new BadRequestError('Invalid group id.');
  }

  if (!metric || !ALL_METRICS.includes(metric)) {
    throw new BadRequestError(`Invalid metric: ${metric}.`);
  }

  const group = await Group.findOne({ where: { id } });

  if (!group) {
    throw new BadRequestError(`Group of id ${id} was not found.`);
  }

  // Fetch all memberships for the group
  const memberships = await Membership.findAll({
    attributes: ['playerId'],
    where: { groupId: id },
    include: [{ model: Player }]
  });

  if (!memberships || memberships.length === 0) {
    return [];
  }

  const valueKey = getValueKey(metric);
  const rankKey = getRankKey(metric);
  const measure = getMeasure(metric);
  const memberIds = memberships.map(m => m.player.id);

  const query = `
    SELECT s.*
    FROM (SELECT q."playerId", MAX(q."createdAt") AS max_date
          FROM public.snapshots q
          WHERE q."playerId" IN (${memberIds.join(',')})
          GROUP BY q."playerId"
          ) r
    JOIN public.snapshots s
      ON s."playerId" = r."playerId" AND s."createdAt" = r.max_date
    ORDER BY s."${valueKey}" DESC
    LIMIT :limit
    OFFSET :offset
  `;

  // Execute the query above, which returns the latest snapshot for each member
  const latestSnapshots = await sequelize.query(query, {
    type: QueryTypes.SELECT,
    replacements: { ...pagination }
  });

  // Formats the experience snapshots to a key:value map.
  // Example: { '1623': { rank: 350567, experience: 6412215 } }
  const experienceMap = _.mapValues(_.keyBy(latestSnapshots, 'playerId'), d => {
    const data = {
      rank: parseInt(d[rankKey], 10),
      [measure]: parseInt(d[valueKey], 10)
    };

    if (isSkill(metric)) {
      data.level = metric === 'overall' ? getTotalLevel(d) : getLevel(data.experience);
    }

    return data;
  });

  // Format all the members, add each experience to its respective player, and sort them by exp
  return memberships
    .filter(({ playerId }) => experienceMap[playerId] && experienceMap[playerId].rank > 0)
    .map(({ player }) => ({ ...player.toJSON(), ...experienceMap[player.id] }))
    .sort((a, b) => b[measure] - a[measure]);
}

/**
 * Gets the stats for every member of a group (latest snapshot)
 */
async function getMemberStats(id) {
  if (!id) {
    throw new BadRequestError('Invalid group id.');
  }

  const group = await Group.findOne({ where: { id } });

  if (!group) {
    throw new BadRequestError(`Group of id ${id} was not found.`);
  }

  // Fetch all memberships for the group
  const memberships = await Membership.findAll({
    attributes: ['playerId'],
    where: { groupId: id }
  });

  if (!memberships || memberships.length === 0) {
    return [];
  }

  const memberIds = memberships.map(m => m.playerId);

  const query = `
    SELECT s.*
    FROM (SELECT q."playerId", MAX(q."createdAt") AS max_date
          FROM public.snapshots q
          WHERE q."playerId" IN (${memberIds.join(',')})
          GROUP BY q."playerId"
          ) r
    JOIN public.snapshots s
      ON s."playerId" = r."playerId" AND s."createdAt" = r.max_date
  `;

  // Execute the query above, which returns the latest snapshot for each member
  const latestSnapshots = await sequelize.query(query, { type: QueryTypes.SELECT });

  // Formats the snapshots to a playerId:snapshot map, for easier lookup
  const snapshotMap = _.mapValues(_.keyBy(latestSnapshots, 'playerId'));

  // Format all the members, add each experience to its respective player, and sort them by exp
  return memberships
    .filter(({ playerId }) => snapshotMap[playerId])
    .map(({ playerId }) => ({ ...snapshotMap[playerId] }));
}

async function getStatistics(id) {
  if (!id) {
    throw new BadRequestError('Invalid group id.');
  }

  const stats = await getMemberStats(id);

  if (!stats || stats.length === 0) {
    throw new BadRequestError("Couldn't find any stats for this group.");
  }

  const maxedCombatCount = stats.filter(s => getCombatLevel(s) === 126).length;
  const maxedTotalCount = stats.filter(s => getTotalLevel(s) === 2277).length;
  const maxed200msCount = stats.map(s => get200msCount(s)).reduce((acc, cur) => acc + cur, 0);
  const averageStats = snapshotService.format(snapshotService.average(stats));

  return { maxedCombatCount, maxedTotalCount, maxed200msCount, averageStats };
}

async function create(name, clanChat, members) {
  if (!name) {
    throw new BadRequestError('Invalid group name.');
  }

  const sanitizedName = sanitizeName(name);
  const sanitizedClanChat = clanChat && clanChat.length ? playerService.sanitize(clanChat) : null;

  if (await Group.findOne({ where: { name: sanitizedName } })) {
    throw new BadRequestError(`Group name '${sanitizedName}' is already taken.`);
  }

  // If not all elements of members array have a "username" key.
  if (members && members.filter(m => m.username).length !== members.length) {
    throw new BadRequestError('Invalid members list. Each array element must have a username key.');
  }

  // Check if every username in the list is valid
  if (members && members.length > 0) {
    const invalidUsernames = members
      .map(({ username }) => username)
      .filter(username => !playerService.isValidUsername(username));

    if (invalidUsernames.length > 0) {
      throw new BadRequestError(
        `${invalidUsernames.length} Invalid usernames: Names must be 1-12 characters long, 
         contain no special characters, and/or contain no space at the beginning or end of the name.`,
        invalidUsernames
      );
    }
  }

  const [verificationCode, verificationHash] = await generateVerification();

  const group = await Group.create({
    name: sanitizedName,
    clanChat: sanitizedClanChat,
    verificationCode,
    verificationHash
  });

  if (!members) {
    return { ...format(group), members: [] };
  }

  const newMembers = await setMembers(group, members);

  return { ...format(group), members: newMembers };
}

/**
 * Edit a group
 *
 * Note: If "members" is defined, it will replace the existing members.
 */
async function edit(id, name, clanChat, verificationCode, members) {
  if (!id) {
    throw new BadRequestError('Invalid group id.');
  }

  if (!verificationCode) {
    throw new BadRequestError('Invalid verification code.');
  }

  if (!name && !members && !clanChat) {
    throw new BadRequestError('You must either include a new name, clan chat or members list.');
  }

  if (name) {
    const sanitizedName = sanitizeName(name);
    const matchingGroup = await Group.findOne({ where: { name: sanitizedName } });

    // If attempting to change to some other group's name.
    if (matchingGroup && matchingGroup.id !== parseInt(id, 10)) {
      throw new BadRequestError(`Group name '${sanitizedName}' is already taken.`);
    }
  }

  const group = await Group.findOne({ where: { id } });

  if (!group) {
    throw new BadRequestError(`Group of id ${id} was not found.`);
  }

  const verified = await verifyCode(group.verificationHash, verificationCode);

  if (!verified) {
    throw new BadRequestError('Incorrect verification code.');
  }

  let groupMembers;

  // Check if every username in the list is valid
  if (members) {
    const invalidUsernames = members
      .map(({ username }) => username)
      .filter(username => !playerService.isValidUsername(username));

    if (invalidUsernames.length > 0) {
      throw new BadRequestError(
        `${invalidUsernames.length} Invalid usernames: Names must be 1-12 characters long, 
         contain no special characters, and/or contain no space at the beginning or end of the name.`,
        invalidUsernames
      );
    }

    groupMembers = await setMembers(group, members);
  } else {
    const memberships = await group.getMembers();
    groupMembers = memberships.map(p => ({ ...p.toJSON(), memberships: undefined }));
  }

  if (name || clanChat) {
    const sanitizedName = name && sanitizeName(name);
    const sanitizedClanChat = clanChat && clanChat.length ? playerService.sanitize(clanChat) : null;

    await group.update({
      name: sanitizedName,
      clanChat: sanitizedClanChat
    });
  }

  return { ...format(group), members: groupMembers };
}

/**
 * Permanently delete a group and all associated memberships.
 */
async function destroy(id, verificationCode) {
  if (!id) {
    throw new BadRequestError('Invalid group id.');
  }

  if (!verificationCode) {
    throw new BadRequestError('Invalid verification code.');
  }

  const group = await Group.findOne({ where: { id } });

  if (!group) {
    throw new BadRequestError(`Group of id ${id} was not found.`);
  }

  const { name } = group;
  const verified = await verifyCode(group.verificationHash, verificationCode);

  if (!verified) {
    throw new BadRequestError('Incorrect verification code.');
  }

  await group.destroy();
  return name;
}

/**
 * Set the members of a group.
 *
 * Note: This will replace any existing members.
 * Note: The members array should have this format:
 * [{username: "ABC", role: "member"}]
 */
async function setMembers(group, members) {
  if (!group) {
    throw new BadRequestError(`Invalid group.`);
  }

  const uniqueNames = _.uniqBy(
    members.map(m => m.username),
    m => m.toLowerCase()
  );

  const players = await playerService.findAllOrCreate(uniqueNames);

  const newMemberships = players.map((p, i) => ({
    playerId: p.id,
    groupId: group.id,
    role: members[i].role || 'member'
  }));

  // Remove all existing memberships
  await Membership.destroy({ where: { groupId: group.id } });

  // Add all the new memberships
  await Membership.bulkCreate(newMemberships, { ignoreDuplicates: true });

  const allMembers = await group.getMembers();

  const formatted = allMembers.map(member =>
    _.omit({ ...member.toJSON(), role: member.memberships.role }, ['memberships'])
  );

  return formatted;
}

/**
 * Adds all the usernames as group members.
 *
 * Note: The members array should have this format:
 * [{username: "ABC", role: "member"}]
 */
async function addMembers(id, verificationCode, members) {
  if (!id) {
    throw new BadRequestError('Invalid group id.');
  }

  if (!verificationCode) {
    throw new BadRequestError('Invalid verification code.');
  }

  if (!members || members.length === 0) {
    throw new BadRequestError('Invalid members list.');
  }

  // If not all elements of members array have a "username" key.
  if (members.filter(m => m.username).length !== members.length) {
    throw new BadRequestError('Invalid members list. Each array element must have a username key.');
  }

  const group = await Group.findOne({ where: { id } });

  if (!group) {
    throw new BadRequestError(`Group of id ${id} was not found.`);
  }

  const verified = await verifyCode(group.verificationHash, verificationCode);

  if (!verified) {
    throw new BadRequestError('Incorrect verification code.');
  }

  // Find all existing members
  const existingIds = (await group.getMembers()).map(p => p.id);

  // Find or create all players with the given usernames
  const players = await playerService.findAllOrCreate(members.map(m => m.username));

  const newPlayers = players.filter(p => existingIds && !existingIds.includes(p.id));

  if (!newPlayers || !newPlayers.length) {
    throw new BadRequestError('All players given are already members.');
  }

  await group.addMembers(newPlayers);

  const leaderUsernames = members
    .filter(m => m.role === 'leader')
    .map(m => playerService.standardize(m.username));

  // If there's any new leaders, we have to re-add them, forcing the leader role
  if (leaderUsernames && leaderUsernames.length > 0) {
    const allMembers = await group.getMembers();
    const leaders = allMembers.filter(m => leaderUsernames.includes(m.username));
    await group.addMembers(leaders, { through: { role: 'leader' } });
  }

  // Update the "updatedAt" timestamp on the group model
  await group.changed('updatedAt', true);
  await group.save();

  const allMembers = await group.getMembers();

  const formatted = allMembers.map(member =>
    _.omit({ ...member.toJSON(), role: member.memberships.role }, ['memberships'])
  );

  return formatted;
}

/**
 * Removes all the usernames (members) from a group.
 */
async function removeMembers(id, verificationCode, usernames) {
  if (!id) {
    throw new BadRequestError('Invalid group id.');
  }

  if (!verificationCode) {
    throw new BadRequestError('Invalid verification code.');
  }

  if (!usernames || usernames.length === 0) {
    throw new BadRequestError('Invalid members list.');
  }

  const group = await Group.findOne({ where: { id } });

  if (!group) {
    throw new BadRequestError(`Group of id ${id} was not found.`);
  }

  const verified = await verifyCode(group.verificationHash, verificationCode);

  if (!verified) {
    throw new BadRequestError('Incorrect verification code.');
  }

  const playersToRemove = await playerService.findAll(usernames);

  if (!playersToRemove || !playersToRemove.length) {
    throw new BadRequestError('No valid tracked players were given.');
  }

  // Remove all specific players, and return the removed count
  const removedPlayersCount = await group.removeMembers(playersToRemove);

  if (!removedPlayersCount) {
    throw new BadRequestError('None of the players given were members of that group.');
  }

  // Update the "updatedAt" timestamp on the group model
  await group.changed('updatedAt', true);
  await group.save();

  return removedPlayersCount;
}

/**
 * Change the role of a given username, in a group.
 */
async function changeRole(id, username, role, verificationCode) {
  if (!id) {
    throw new BadRequestError('Invalid group id.');
  }

  if (!username) {
    throw new BadRequestError('Invalid username.');
  }

  if (!role) {
    throw new BadRequestError(`Invalid group role.`);
  }

  if (!verificationCode) {
    throw new BadRequestError('Invalid verification code.');
  }

  const group = await Group.findOne({ where: { id } });

  if (!group) {
    throw new BadRequestError(`Group of id ${id} was not found.`);
  }

  const verified = await verifyCode(group.verificationHash, verificationCode);

  if (!verified) {
    throw new BadRequestError('Incorrect verification code.');
  }

  const membership = await Membership.findOne({
    where: { groupId: id },
    include: [
      {
        model: Player,
        where: { username: playerService.standardize(username) }
      }
    ]
  });

  if (!membership) {
    throw new BadRequestError(`'${username}' is not a member of ${group.name}.`);
  }

  const oldRole = membership.role;

  if (membership.role === role) {
    throw new BadRequestError(`'${username}' already has the role of ${role}.`);
  }

  await membership.update({ role });

  // Update the "updatedAt" timestamp on the group model
  await group.changed('updatedAt', true);
  await group.save();

  return { player: { ...membership.player.toJSON(), role: membership.role }, newRole: role, oldRole };
}

/**
 * Get all members for a specific group id.
 */
async function getMembers(groupId) {
  // Fetch all members
  const memberships = await Membership.findAll({
    where: { groupId },
    include: [{ model: Player }]
  });

  // Format the members
  const members = memberships.map(({ player, role }) => {
    return { ...player.toJSON(), role };
  });

  return members;
}

async function findOne(groupId) {
  const group = await Group.findOne({ where: { id: groupId } });
  return group;
}

/**
 * Update all members of a group.
 *
 * An update action must be supplied, to be executed for
 * every member. This is to prevent calling jobs from
 * within the service. I'd rather call them from the controller.
 *
 * Note: this is a soft update, meaning it will only create a new
 * snapshot. It won't import from CML or determine player type.
 */
async function updateAllMembers(id, updateAction) {
  if (!id) {
    throw new BadRequestError('Invalid group id.');
  }

  const members = await getOutdatedMembers(id);

  if (!members || members.length === 0) {
    throw new BadRequestError('This group has no members that should be updated.');
  }

  // Execute the update action for every member
  members.forEach(player => updateAction(player));

  return members;
}

/**
 * Get outdated members of a specific group id.
 * A member is considered outdated 10 minutes after their last update
 */
async function getOutdatedMembers(groupId) {
  if (!groupId) {
    throw new BadRequestError('Invalid group id.');
  }

  const tenMinsAgo = moment().subtract(10, 'minute');

  const membersToUpdate = await Membership.findAll({
    attributes: ['groupId', 'playerId'],
    where: { groupId },
    include: [
      {
        model: Player,
        where: {
          updatedAt: { [Op.lt]: tenMinsAgo.toDate() }
        }
      }
    ]
  });

  return membersToUpdate.map(({ player }) => player);
}

async function refreshScores() {
  const allGroups = await Group.findAll();

  await Promise.all(
    allGroups.map(async group => {
      const currentScore = group.score;
      const newScore = await calculateScore(group);

      if (newScore !== currentScore) {
        await group.update({ score: newScore });
      }
    })
  );
}

async function calculateScore(group) {
  let score = 0;

  const now = new Date();
  const members = await getMembersList(group.id);
  const competitions = await competitionService.findForGroup(group.id, { limit: 10000, offset: 0 });
  const averageOverallExp = members.reduce((acc, cur) => acc + cur, 0) / members.length;

  if (!members || members.length === 0) {
    return score;
  }

  // If has atleast one leader
  if (members.filter(m => m.role === 'leader').length >= 1) {
    score += 30;
  }

  // If has atleast 10 players
  if (members.length >= 10) {
    score += 20;
  }

  // If has atleast 50 players
  if (members.length >= 50) {
    score += 40;
  }

  // If average member overall exp > 30m
  if (averageOverallExp >= 30000000) {
    score += 30;
  }

  // If average member overall exp > 100m
  if (averageOverallExp >= 100000000) {
    score += 60;
  }

  // If has valid clan chat
  if (group.clanChat && group.clanChat.length > 0) {
    score += 50;
  }

  // If is verified (clan leader is in our discord)
  if (group.verified) {
    score += 100;
  }

  // If has atleast one ongoing competition
  if (competitions.filter(c => c.startsAt <= now && c.endsAt >= now).length >= 1) {
    score += 50;
  }

  // If has atleast one upcoming competition
  if (competitions.filter(c => c.startsAt >= now).length >= 1) {
    score += 30;
  }

  return score;
}

exports.format = format;
exports.list = list;
exports.findForPlayer = findForPlayer;
exports.view = view;
exports.getMonthlyTopPlayer = getMonthlyTopPlayer;
exports.getDeltas = getDeltas;
exports.getAchievements = getAchievements;
exports.getRecords = getRecords;
exports.getHiscores = getHiscores;
exports.getStatistics = getStatistics;
exports.getMembersList = getMembersList;
exports.create = create;
exports.edit = edit;
exports.destroy = destroy;
exports.addMembers = addMembers;
exports.removeMembers = removeMembers;
exports.changeRole = changeRole;
exports.getMembers = getMembers;
exports.findOne = findOne;
exports.updateAllMembers = updateAllMembers;
exports.refreshScores = refreshScores;
