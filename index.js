require('dotenv').config();

const crypto = require('crypto');
const { spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  generateDependencyReport,
  joinVoiceChannel,
} = require('@discordjs/voice');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  ModalBuilder,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const prism = require('prism-media');
const play = require('play-dl');
const ytdlp = require('youtube-dl-exec');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;

const MAX_QUEUE_LENGTH = clamp(toNumber(process.env.MAX_QUEUE_LENGTH, 100), 1, 9999);
const MAX_SPOTIFY_TRACKS = clamp(toNumber(process.env.MAX_SPOTIFY_TRACKS, 25), 1, 9999);
const MAX_YOUTUBE_PLAYLIST_TRACKS = clamp(
  toNumber(process.env.MAX_YOUTUBE_PLAYLIST_TRACKS, 30),
  1,
  9999,
);
const SPOTIFY_SEARCH_CONCURRENCY = clamp(toNumber(process.env.SPOTIFY_SEARCH_CONCURRENCY, 6), 1, 20);
const SPOTIFY_PROGRESS_EVERY = clamp(toNumber(process.env.SPOTIFY_PROGRESS_EVERY, 25), 1, 500);
const SPOTIFY_PROGRESS_MIN_INTERVAL_MS = Math.max(
  500,
  toNumber(process.env.SPOTIFY_PROGRESS_MIN_INTERVAL_MS, 2000),
);
const DEFAULT_VOLUME_PERCENT = toNumber(process.env.DEFAULT_VOLUME_PERCENT, 80);
const STATUS_UPDATE_INTERVAL_MS = toNumber(process.env.STATUS_UPDATE_INTERVAL_MS, 5000);
const STATUS_UPDATE_DURATION_MS = toNumber(process.env.STATUS_UPDATE_DURATION_MS, 120000);
const UPCOMING_TRACK_LIMIT = clamp(toNumber(process.env.UPCOMING_TRACK_LIMIT, 10), 1, 10);
const ENABLE_AUDIO_NORMALIZER = toBoolean(process.env.ENABLE_AUDIO_NORMALIZER, true);
const AUDIO_FILTER_CHAIN =
  process.env.AUDIO_FILTER_CHAIN ||
  'dynaudnorm=f=250:g=13:m=15:s=10,alimiter=limit=0.95';
const SPOTIFY_REDIRECT_URI =
  process.env.SPOTIFY_REDIRECT_URI || 'http://127.0.0.1:8787/spotify/callback';
const SPOTIFY_OAUTH_SCOPES =
  process.env.SPOTIFY_OAUTH_SCOPES || 'playlist-read-private playlist-read-collaborative';
const SPOTIFY_USER_TOKEN_FILE =
  process.env.SPOTIFY_USER_TOKEN_FILE || path.join(__dirname, 'spotify-user-tokens.json');
const YTDLP_COOKIES_FILE = String(process.env.YTDLP_COOKIES_FILE || '').trim();

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in .env');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

let spotifyResolver;
let spotifyOAuthManager;

const UI_IDS = {
  panelPlay: 'music:panel:play',
  panelStatus: 'music:panel:status',
  panelSkip: 'music:panel:skip',
  panelPause: 'music:panel:pause',
  panelResume: 'music:panel:resume',
  panelQueue: 'music:panel:queue',
  panelClearUpcoming: 'music:panel:clear_upcoming',
  panelStop: 'music:panel:stop',
  panelLeave: 'music:panel:leave',
  playModal: 'music:modal:play',
  playInput: 'music:modal:play:query',
  listRefresh: 'music:list:refresh',
  listClearUpcoming: 'music:list:clear_upcoming',
};

const sessions = new Map();
const listUpdateTimers = new Map();

function getSession(guildId) {
  if (!sessions.has(guildId)) {
    sessions.set(guildId, new GuildMusicSession(guildId));
  }
  return sessions.get(guildId);
}

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    if (spotifyOAuthManager?.enabled) {
      try {
        await spotifyOAuthManager.startCallbackServer();
      } catch (error) {
        console.error('Spotify OAuth callback server failed to start:', error);
      }
    }
    await registerCommands();
  } catch (error) {
    console.error('Failed to register commands:', error);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.guildId) {
    return;
  }

  const session = getSession(interaction.guildId);

  try {
    if (interaction.isChatInputCommand()) {
      const command = interaction.commandName;

      if (command === 'play') {
        const query = interaction.options.getString('query', true).trim();
        await handlePlayRequest(interaction, session, query);
        return;
      }

      if (command === 'diag') {
        const text = buildRuntimeDiagnosticsText();
        await interaction.reply({
          content: text,
          ephemeral: true,
        });
        return;
      }

      if (command === 'spotifylogin') {
        if (!spotifyOAuthManager?.enabled) {
          await interaction.reply(
            '\u5c1a\u672a\u555f\u7528 Spotify OAuth\u3002\u8acb\u5148\u8a2d\u5b9a SPOTIFY_CLIENT_ID\u3001SPOTIFY_CLIENT_SECRET\u3001SPOTIFY_REDIRECT_URI\u3002',
          );
          return;
        }

        const authUrl = spotifyOAuthManager.createAuthorizationUrl(interaction.user.id);
        await interaction.reply({
          content:
            '\u8acb\u9ede\u64ca\u4ee5\u4e0b\u9023\u7d50\u6388\u6b0a Spotify\uff0c\u5b8c\u6210\u5f8c\u518d\u56de Discord \u4f7f\u7528 /play\uff1a\n' +
            '\n1) \u4efb\u4f55\u88dd\u7f6e\u90fd\u80fd\u958b\u9019\u500b\u9023\u7d50\u6388\u6b0a\n' +
            '2) \u6388\u6b0a\u5f8c\u700f\u89bd\u5668\u82e5\u986f\u793a 127.0.0.1 \u7121\u6cd5\u9023\u7dda\u662f\u6b63\u5e38\u7684\n' +
            '3) \u8acb\u628a\u7576\u4e0b\u5740\u5217\u5b8c\u6574 URL \u8cbc\u5230 /spotifycallback \u7684 callback_url \u53c3\u6578\n\n' +
            authUrl,
          ephemeral: true,
        });
        return;
      }

      if (command === 'spotifycallback') {
        if (!spotifyOAuthManager?.enabled) {
          await interaction.reply(
            '\u5c1a\u672a\u555f\u7528 Spotify OAuth\u3002\u8acb\u5148\u8a2d\u5b9a SPOTIFY_CLIENT_ID\u3001SPOTIFY_CLIENT_SECRET\u3001SPOTIFY_REDIRECT_URI\u3002',
          );
          return;
        }

        const callbackUrl = interaction.options.getString('callback_url', true).trim();
        await spotifyOAuthManager.completeAuthorizationFromCallbackUrl(callbackUrl, {
          actingDiscordUserId: interaction.user.id,
        });
        await interaction.reply({
          content:
            '\u2705 Spotify \u6388\u6b0a\u6210\u529f\uff01\u5df2\u7d81\u5b9a\u4f60\u7684 Discord \u5e33\u865f\uff0c\u73fe\u5728\u53ef\u4ee5\u7528 /play \u64ad\u653e Spotify \u6b4c\u55ae\u3002',
          ephemeral: true,
        });
        return;
      }

      if (command === 'spotifylogout') {
        const removed = spotifyOAuthManager?.clearUserToken(interaction.user.id) ?? false;
        await interaction.reply(
          removed
            ? '\u5df2\u79fb\u9664\u4f60\u7684 Spotify \u6388\u6b0a\u8cc7\u6599\u3002'
            : '\u76ee\u524d\u6c92\u6709\u4f60\u7684 Spotify \u6388\u6b0a\u8cc7\u6599\u3002',
        );
        return;
      }

      if (command === 'skip') {
        if (!session.currentTrack) {
          await interaction.reply('目前沒有正在播放的歌曲。');
          return;
        }
        session.skip();
        await interaction.reply('已跳過目前歌曲。');
        return;
      }

      if (command === 'pause') {
        const paused = session.pause();
        await interaction.reply(paused ? '已暫停播放。' : '目前無法暫停播放。');
        return;
      }

      if (command === 'resume') {
        const resumed = session.resume();
        await interaction.reply(resumed ? '已繼續播放。' : '目前沒有可繼續的暫停歌曲。');
        return;
      }
      if (command === 'queue') {
        const lines = session.getQueueLines();
        if (!lines.length) {
          await interaction.reply('\u76ee\u524d\u4f47\u5217\u662f\u7a7a\u7684\u3002');
          return;
        }
        await interaction.reply(lines.join('\n').slice(0, 1900));
        return;
      }

      if (command === 'clearupcoming') {
        const removedCount = session.clearUpcoming();
        if (removedCount <= 0) {
          await interaction.reply('\u76ee\u524d\u6c92\u6709\u5f85\u64ad\u6b4c\u66f2\u53ef\u4ee5\u6e05\u9664\u3002');
          return;
        }
        await interaction.reply(`\u5df2\u6e05\u9664 ${removedCount} \u9996\u5f85\u64ad\u6b4c\u66f2\u3002`);
        return;
      }

      if (command === 'list') {
        await sendOrRefreshListMessage(interaction, session, { startAutoUpdate: true });
        return;
      }

      if (command === 'stop') {
        session.stopAndClear();
        await interaction.reply('已停止播放並清空佇列。');
        return;
      }

      if (command === 'leave') {
        session.disconnect();
        await interaction.reply('已離開語音頻道。');
        return;
      }

      if (command === 'panel') {
        await interaction.reply({
          content: '音樂控制面板。請先加入語音頻道，再使用下方按鈕。',
          components: createMusicPanelComponents(),
        });
        return;
      }
    }

    if (interaction.isButton()) {
      await handlePanelButton(interaction, session);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId === UI_IDS.playModal) {
      const query = interaction.fields.getTextInputValue(UI_IDS.playInput).trim();
      await handlePlayRequest(interaction, session, query, { ephemeral: true });
      return;
    }
  } catch (error) {
    const id = interaction.isChatInputCommand() ? interaction.commandName : interaction.customId;
    console.error(`[${id}] error:`, error);
    const message = formatUserError(error);

    await replyToInteraction(interaction, message, { ephemeral: true }).catch(() => null);
  }
});

client.login(DISCORD_TOKEN);

function createMusicPanelComponents() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(UI_IDS.panelPlay)
      .setLabel('播放')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(UI_IDS.panelSkip)
      .setLabel('跳過')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(UI_IDS.panelPause)
      .setLabel('暫停')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(UI_IDS.panelResume)
      .setLabel('繼續')
      .setStyle(ButtonStyle.Secondary),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(UI_IDS.panelStatus)
      .setLabel('進度')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(UI_IDS.panelQueue)
      .setLabel('佇列')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(UI_IDS.panelClearUpcoming)
      .setLabel('\u6e05\u7a7a\u5f85\u64ad')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(UI_IDS.panelStop)
      .setLabel('停止')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(UI_IDS.panelLeave)
      .setLabel('離開')
      .setStyle(ButtonStyle.Danger),
  );

  return [row1, row2];
}

async function handlePanelButton(interaction, session) {
  const { customId } = interaction;
  const allowedIds = new Set(Object.values(UI_IDS));
  if (!allowedIds.has(customId) || customId === UI_IDS.playModal || customId === UI_IDS.playInput) {
    return;
  }

  if (customId === UI_IDS.panelPlay) {
    const modal = new ModalBuilder()
      .setCustomId(UI_IDS.playModal)
      .setTitle('播放音樂');

    const input = new TextInputBuilder()
      .setCustomId(UI_IDS.playInput)
      .setLabel('歌名或連結')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setPlaceholder('例如：Never Gonna Give You Up');

    modal.addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);
    return;
  }

  if (customId === UI_IDS.panelStatus) {
    await sendOrRefreshListMessage(interaction, session, { startAutoUpdate: true, ephemeral: true });
    return;
  }
  if (customId === UI_IDS.listRefresh) {
    const payload = buildListMessagePayload(session, { showRefreshButton: true });
    await interaction.update(payload);
    scheduleListAutoUpdate(interaction.message, interaction.guildId);
    return;
  }

  if (customId === UI_IDS.listClearUpcoming || customId === UI_IDS.panelClearUpcoming) {
    const removedCount = session.clearUpcoming();
    const message =
      removedCount > 0
        ? `\u5df2\u6e05\u9664 ${removedCount} \u9996\u5f85\u64ad\u6b4c\u66f2\u3002`
        : '\u76ee\u524d\u6c92\u6709\u5f85\u64ad\u6b4c\u66f2\u53ef\u4ee5\u6e05\u9664\u3002';

    if (customId === UI_IDS.listClearUpcoming) {
      const payload = buildListMessagePayload(session, { showRefreshButton: true });
      await interaction.update(payload);
      scheduleListAutoUpdate(interaction.message, interaction.guildId);
      await interaction.followUp({
        content: message,
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      content: message,
      ephemeral: true,
    });
    return;
  }

  if (customId === UI_IDS.panelSkip) {
    if (!session.currentTrack) {
      await interaction.reply({ content: '目前沒有正在播放的歌曲。', ephemeral: true });
      return;
    }
    session.skip();
    await interaction.reply({ content: '已跳過目前歌曲。', ephemeral: true });
    return;
  }

  if (customId === UI_IDS.panelPause) {
    const paused = session.pause();
    await interaction.reply({
      content: paused ? '已暫停播放。' : '目前無法暫停播放。',
      ephemeral: true,
    });
    return;
  }

  if (customId === UI_IDS.panelResume) {
    const resumed = session.resume();
    await interaction.reply({
      content: resumed ? '已繼續播放。' : '目前沒有可繼續的暫停歌曲。',
      ephemeral: true,
    });
    return;
  }

  if (customId === UI_IDS.panelQueue) {
    const lines = session.getQueueLines();
    if (!lines.length) {
      await interaction.reply({ content: '目前佇列是空的。', ephemeral: true });
      return;
    }
    await interaction.reply({
      content: lines.join('\n').slice(0, 1900),
      ephemeral: true,
    });
    return;
  }

  if (customId === UI_IDS.panelStop) {
    session.stopAndClear();
    await interaction.reply({ content: '已停止播放並清空佇列。', ephemeral: true });
    return;
  }

  if (customId === UI_IDS.panelLeave) {
    session.disconnect();
    await interaction.reply({ content: '已離開語音頻道。', ephemeral: true });
  }
}

async function handlePlayRequest(interaction, session, query, { ephemeral = false } = {}) {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    await replyToInteraction(interaction, '請輸入歌名或連結。', { ephemeral: true });
    return;
  }

  const member = await interaction.guild.members.fetch(interaction.user.id);
  const voiceChannel = member.voice?.channel;

  if (!voiceChannel) {
    await replyToInteraction(interaction, '請先加入語音頻道再操作。', { ephemeral: true });
    return;
  }

  const missingPerms = await getMissingVoicePermissions(interaction.guild, voiceChannel);
  if (missingPerms.length > 0) {
    await replyToInteraction(
      interaction,
      `我無法使用這個語音頻道，缺少權限：${missingPerms.join('、')}`,
      { ephemeral: true },
    );
    return;
  }

  const me = interaction.guild.members.me ?? (await interaction.guild.members.fetchMe());
  const channelIsFull = voiceChannel.userLimit > 0 && voiceChannel.members.size >= voiceChannel.userLimit;
  if (channelIsFull && !voiceChannel.members.has(me.id)) {
    await replyToInteraction(
      interaction,
      '這個語音頻道已滿，請換一個頻道再試。',
      { ephemeral: true },
    );
    return;
  }

  if (session.queue.length >= MAX_QUEUE_LENGTH) {
    await replyToInteraction(
      interaction,
      `佇列已滿（${MAX_QUEUE_LENGTH} 首），請先跳過或停止部分歌曲。`,
      { ephemeral: true },
    );
    return;
  }

  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply(ephemeral ? { ephemeral: true } : undefined);
  }

  session.setTextChannel(interaction.channelId);
  await session.connect(voiceChannel);
  const reportProgress = createInteractionProgressReporter(interaction);

  const tracks = await resolveTracks(trimmedQuery, {
    requestedBy: interaction.user.username,
    requestedByUserId: interaction.user.id,
    onProgress: reportProgress,
  });
  const skippedTitles = Array.isArray(tracks?.skippedTitles) ? tracks.skippedTitles : [];
  const dedupedTitles = Array.isArray(tracks?.dedupedTitles) ? tracks.dedupedTitles : [];

  if (!tracks.length) {
    if (skippedTitles.length > 0 || dedupedTitles.length > 0) {
      const details = [];
      if (skippedTitles.length > 0) {
        const preview = skippedTitles
          .slice(0, 5)
          .map((title, index) => `${index + 1}. ${title}`)
          .join('\n');
        const more = skippedTitles.length > 5 ? `\n...\u9084\u6709 ${skippedTitles.length - 5} \u9996` : '';
        details.push(
          `\u627e\u4e0d\u5230 YouTube \u5c0d\u61c9\u4f86\u6e90 ${skippedTitles.length} \u9996\uff1a\n${preview}${more}`,
        );
      }
      if (dedupedTitles.length > 0) {
        details.push(`\u5df2\u53bb\u91cd ${dedupedTitles.length} \u9996\uff08\u907f\u514d\u91cd\u8907\u64ad\u653e\u540c\u4e00\u90e8 YouTube \u5f71\u7247\uff09`);
      }
      await interaction.editReply(`\u9019\u6b21\u6c92\u6709\u53ef\u52a0\u5165\u4f47\u5217\u7684\u6b4c\u66f2\u3002\n${details.join('\n')}`);
    } else {
      await interaction.editReply('\u627e\u4e0d\u5230\u53ef\u64ad\u653e\u7684\u7d50\u679c\uff0c\u8acb\u63db\u95dc\u9375\u5b57\u6216\u9023\u7d50\u3002');
    }
    return;
  }

  const availableSlots = MAX_QUEUE_LENGTH - session.queue.length;
  const tracksToAdd = tracks.slice(0, Math.max(availableSlots, 0));
  if (!tracksToAdd.length) {
    const skipNote =
      skippedTitles.length > 0
        ? `\n\u53e6\u5916\u5df2\u8df3\u904e ${skippedTitles.length} \u9996\u7121\u6cd5\u5c0d\u61c9 YouTube \u7684\u6b4c\u66f2\u3002`
        : '';
    await interaction.editReply(`\u4f47\u5217\u5df2\u6eff\uff08${MAX_QUEUE_LENGTH} \u9996\uff09\u3002${skipNote}`);
    return;
  }

  session.enqueue(tracksToAdd);
  await session.playIfIdle();

  const first = tracksToAdd[0];
  const suffix = tracksToAdd.length > 1 ? `\uFF0C\u53E6\u5916\u52A0\u5165 ${tracksToAdd.length - 1} \u9996` : '';
  const droppedByQueue = Math.max(0, tracks.length - tracksToAdd.length);
  const notes = [];
  if (skippedTitles.length > 0) {
    notes.push(`\u8DF3\u904E ${skippedTitles.length} \u9996\u7121\u6CD5\u5C0D\u61C9 YouTube \u7684\u6B4C\u66F2`);
  }
  if (dedupedTitles.length > 0) {
    notes.push(`\u53bb\u91cd ${dedupedTitles.length} \u9996\u91cd\u8907\u7684 YouTube \u7d50\u679c`);
  }
  if (droppedByQueue > 0) {
    notes.push(`\u4F47\u5217\u4E0A\u9650\u672A\u52A0\u5165 ${droppedByQueue} \u9996`);
  }

  let message = `\u5DF2\u52A0\u5165\u4F47\u5217\uFF1A**${first.title}**\uFF08${formatDuration(first.durationSec)}\uFF09${suffix}`;
  if (notes.length > 0) {
    message += `\n${notes.join('\n')}`;
  }
  if (skippedTitles.length > 0) {
    const preview = skippedTitles
      .slice(0, 3)
      .map((title, index) => `${index + 1}. ${title}`)
      .join('\n');
    if (preview) {
      message += `\n\u8DF3\u904E\u7BC4\u4F8B\uFF1A\n${preview}`;
    }
  }

  await interaction.editReply(message.slice(0, 1900));
}

async function getMissingVoicePermissions(guild, voiceChannel) {
  const me = guild.members.me ?? (await guild.members.fetchMe());
  const perms = voiceChannel.permissionsFor(me);
  const missing = [];

  if (!perms?.has(PermissionFlagsBits.ViewChannel)) {
    missing.push('查看頻道(ViewChannel)');
  }
  if (!perms?.has(PermissionFlagsBits.Connect)) {
    missing.push('連線(Connect)');
  }
  if (!perms?.has(PermissionFlagsBits.Speak)) {
    missing.push('說話(Speak)');
  }

  return missing;
}

async function replyToInteraction(interaction, content, { ephemeral = false } = {}) {
  if (interaction.deferred) {
    return interaction.editReply(content);
  }

  if (interaction.replied) {
    return interaction.followUp({ content, ephemeral });
  }

  return interaction.reply({ content, ephemeral });
}

function createInteractionProgressReporter(interaction) {
  let lastUpdatedAt = 0;
  let lastText = '';

  return async (progress) => {
    if (!interaction?.deferred && !interaction?.replied) {
      return;
    }

    const text = formatSpotifyImportProgress(progress);
    if (!text || text === lastText) {
      return;
    }

    const now = Date.now();
    const force = Boolean(progress?.force);
    if (!force && now - lastUpdatedAt < SPOTIFY_PROGRESS_MIN_INTERVAL_MS) {
      return;
    }

    lastUpdatedAt = now;
    lastText = text;
    await interaction.editReply(text).catch(() => null);
  };
}

function formatSpotifyImportProgress(progress) {
  const stage = String(progress?.stage || '');

  if (stage === 'spotify_fetch') {
    return '正在讀取 Spotify 歌單內容...';
  }

  if (stage === 'spotify_search') {
    const total = Math.max(0, numberOrZero(progress?.total));
    const processed = clamp(numberOrZero(progress?.processed), 0, total || 999999);
    const added = Math.max(0, numberOrZero(progress?.added));
    const skipped = Math.max(0, numberOrZero(progress?.skipped));
    const deduped = Math.max(0, numberOrZero(progress?.deduped));
    const percent = total > 0 ? Math.min(100, Math.floor((processed / total) * 100)) : 0;

    return [
      `正在轉換 Spotify -> YouTube：${processed}/${total}（${percent}%）`,
      `已加入 ${added} 首，略過 ${skipped} 首，去重 ${deduped} 首。`,
    ].join('\n');
  }

  return '';
}

async function sendOrRefreshListMessage(
  interaction,
  session,
  { startAutoUpdate = false, ephemeral = false } = {},
) {
  const payload = buildListMessagePayload(session, { showRefreshButton: !ephemeral });
  let responseMessage = null;

  if (interaction.deferred) {
    await interaction.editReply(payload);
    if (!ephemeral) {
      responseMessage = await interaction.fetchReply().catch(() => null);
    }
  } else if (interaction.replied) {
    responseMessage = await interaction.followUp({ ...payload, ephemeral });
  } else {
    await interaction.reply(ephemeral ? { ...payload, ephemeral: true } : payload);
    if (!ephemeral) {
      responseMessage = await interaction.fetchReply().catch(() => null);
    }
  }

  if (startAutoUpdate && responseMessage && interaction.guildId) {
    scheduleListAutoUpdate(responseMessage, interaction.guildId);
  }
}

function buildListMessagePayload(session, { showRefreshButton = true } = {}) {
  const upcomingLimit = Math.min(10, Math.max(1, UPCOMING_TRACK_LIMIT));
  const totalUpcoming = session.queue.length;
  const shownUpcoming = Math.min(totalUpcoming, upcomingLimit);

  const embed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle('播放清單')
    .setDescription(buildNowPlayingBlock(session))
    .addFields({
      name: `接下來歌曲（顯示 ${shownUpcoming}/${totalUpcoming} 首）`,
      value: buildUpcomingBlock(session),
    })
    .setFooter({
      text: showRefreshButton
        ? `每 ${Math.floor(STATUS_UPDATE_INTERVAL_MS / 1000)} 秒自動更新一次，可按「重新整理」手動更新 | 最後更新 ${formatTimeHms(new Date())}`
        : `使用 /list 可查看可自動更新的播放清單 | 最後更新 ${formatTimeHms(new Date())}`,
    })
    .setTimestamp();

  const components = showRefreshButton ? [createListRefreshComponents()] : [];
  return { embeds: [embed], components };
}

function buildNowPlayingBlock(session) {
  if (!session.currentTrack) {
    return '目前沒有正在播放的歌曲。';
  }

  const elapsed = session.getElapsedSec();
  const total = numberOrZero(session.currentTrack.durationSec);
  const playerStatus = session.player.state?.status || 'idle';
  const statusText = mapPlayerStatusLabel(playerStatus);
  const progressLine = createProgressLine(elapsed, total);

  return [
    `狀態：${statusText}`,
    `歌曲：**${session.currentTrack.title}**`,
    progressLine,
  ].join('\n');
}

function buildUpcomingBlock(session) {
  const upcomingLimit = Math.min(10, Math.max(1, UPCOMING_TRACK_LIMIT));
  const totalUpcoming = session.queue.length;
  const upcoming = session.queue.slice(0, upcomingLimit);
  if (!upcoming.length) {
    return '沒有待播歌曲。';
  }

  const lines = upcoming.map(
    (track, idx) => `${idx + 1}. ${track.title}（${formatDuration(track.durationSec)}）`,
  );
  const remaining = Math.max(0, totalUpcoming - upcoming.length);
  if (remaining > 0) {
    lines.push(`...還有 ${remaining} 首未顯示`);
  }
  const text = lines.join('\n');
  return text.length > 1000 ? `${text.slice(0, 997)}...` : text;
}

function createProgressLine(elapsedSec, totalSec) {
  const barLength = 18;
  const safeElapsed = Math.max(0, numberOrZero(elapsedSec));
  const safeTotal = numberOrZero(totalSec);

  if (safeTotal <= 0) {
    const moving = safeElapsed % barLength;
    const bar = '▰'.repeat(moving) + '▱'.repeat(Math.max(0, barLength - moving));
    return `${bar}  ${formatClockDuration(safeElapsed)} / LIVE`;
  }

  const clamped = Math.min(safeElapsed, safeTotal);
  const ratio = safeTotal > 0 ? clamped / safeTotal : 0;
  const filled = Math.min(barLength, Math.max(0, Math.round(ratio * barLength)));
  const bar = '█'.repeat(filled) + '░'.repeat(Math.max(0, barLength - filled));
  return `${bar}  ${formatClockDuration(clamped)} / ${formatDuration(safeTotal)}`;
}

function createListRefreshComponents() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(UI_IDS.listRefresh)
      .setLabel('重新整理')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(UI_IDS.listClearUpcoming)
      .setLabel('\u6e05\u7a7a\u5f85\u64ad')
      .setStyle(ButtonStyle.Danger),
  );
}

function mapPlayerStatusLabel(status) {
  if (status === AudioPlayerStatus.Playing) {
    return '播放中';
  }
  if (status === AudioPlayerStatus.Paused || status === AudioPlayerStatus.AutoPaused) {
    return '暫停中';
  }
  if (status === AudioPlayerStatus.Buffering) {
    return '緩衝中';
  }
  return '待機中';
}

function scheduleListAutoUpdate(message, guildId) {
  if (!message?.id || !guildId) {
    return;
  }

  clearListAutoUpdate(message.id);

  const interval = setInterval(async () => {
    try {
      await updateListMessage(message, guildId, { keepComponents: true });
    } catch (error) {
      console.error('List auto update failed:', error);
      clearListAutoUpdate(message.id);
    }
  }, Math.max(2000, STATUS_UPDATE_INTERVAL_MS));

  const timeout = setTimeout(() => {
    clearListAutoUpdate(message.id);
  }, Math.max(10000, STATUS_UPDATE_DURATION_MS));

  listUpdateTimers.set(message.id, { interval, timeout });
}

function clearListAutoUpdate(messageId) {
  const timer = listUpdateTimers.get(messageId);
  if (!timer) {
    return;
  }
  clearInterval(timer.interval);
  clearTimeout(timer.timeout);
  listUpdateTimers.delete(messageId);
}

async function updateListMessage(message, guildId, { keepComponents = true } = {}) {
  const session = getSession(guildId);
  const payload = buildListMessagePayload(session, { showRefreshButton: keepComponents });
  await message.edit(payload);
}

function formatUserError(error) {
  const raw = String(error?.message || '').trim();
  if (error?.code === 'ABORT_ERR' || /operation was aborted/i.test(raw)) {
    return '\u8a9e\u97f3\u9023\u7dda\u5931\u6557\uff0c\u8acb\u78ba\u8a8d\u8a72\u983b\u9053\u5df2\u7d66\u6a5f\u5668\u4eba ViewChannel\u3001Connect\u3001Speak \u6b0a\u9650\u5f8c\u518d\u8a66\u3002';
  }
  if (/spotify api/i.test(raw) && /valid user authentication required/i.test(raw)) {
    return '\u9019\u662f Spotify \u6b0a\u9650\u9650\u5236\uff1a\u76ee\u524d\u6a5f\u5668\u4eba\u4f7f\u7528\u7684\u662f\u300c\u61c9\u7528\u7a0b\u5f0f\u6191\u8b49\u300d\uff0c\u53ef\u4ee5\u8b80\u55ae\u66f2/\u5c08\u8f2f\uff0c\u4f46 Spotify \u6b4c\u55ae\u9700\u8981\u4f7f\u7528\u8005\u6388\u6b0a\u624d\u80fd\u8b80\u53d6\u3002\u8acb\u6539\u7528 YouTube \u6b4c\u55ae\uff0c\u6216\u6211\u53ef\u4ee5\u5e6b\u4f60\u52a0\u4e0a Spotify OAuth \u6388\u6b0a\u6d41\u7a0b\u3002';
  }
  if (isSpotifyUserNotRegisteredError(error)) {
    return 'Spotify 開發模式限制：此 Spotify 帳號尚未加入這個 App 的 Users and Access。請到 Spotify Developer Dashboard -> 你的 App -> Users and Access 新增此帳號，再重新 /spotifylogin + /spotifycallback。';
  }
  if (isSpotifyForbiddenError(error)) {
    return 'Spotify \u56de\u50b3 403 Forbidden\uff1a\u76ee\u524d\u6388\u6b0a\u5e33\u865f\u6c92\u6709\u8b80\u53d6\u9019\u4efd\u6b4c\u55ae\u7684\u6b0a\u9650\u3002\u8acb\u6539\u6210\u516c\u958b\u6b4c\u55ae\uff0c\u6216\u4f7f\u7528\u6709\u6b0a\u9650\u7684 Spotify \u5e33\u865f\u91cd\u65b0 /spotifylogin \u5f8c\uff0c\u628a\u56de\u547c URL \u8cbc\u5230 /spotifycallback\u3002';
  }
  return raw || '\u6307\u4ee4\u57f7\u884c\u5931\u6557\uff0c\u8acb\u7a0d\u5f8c\u518d\u8a66\u3002';
}


function buildRuntimeDiagnosticsText() {
  const lines = ['\u7cfb\u7d71\u8a3a\u65b7\uff08\u50c5\u4f60\u53ef\u898b\uff09'];

  const ffmpegProbe = probeFfmpeg();
  if (ffmpegProbe.ok) {
    lines.push(`FFmpeg\uff1aOK (${ffmpegProbe.command})`);
    if (ffmpegProbe.version) {
      lines.push(`FFmpeg \u7248\u672c\uff1a${ffmpegProbe.version}`);
    }
  } else {
    lines.push(`FFmpeg\uff1a\u5931\u6557\uff08${ffmpegProbe.error}\uff09`);
    lines.push('\u5efa\u8b70\uff1aLinux \u5148\u57f7\u884c `apt install -y ffmpeg`');
  }

  const ytdlpProbe = probeYtDlp();
  if (ytdlpProbe.ok) {
    lines.push(`yt-dlp\uff1aOK (${ytdlpProbe.command})`);
    if (ytdlpProbe.version) {
      lines.push(`yt-dlp \u7248\u672c\uff1a${ytdlpProbe.version}`);
    }
  } else {
    lines.push(`yt-dlp\uff1a\u5931\u6557\uff08${ytdlpProbe.error}\uff09`);
    lines.push('\u5efa\u8b70\uff1aLinux \u5148\u57f7\u884c `apt install -y yt-dlp`');
  }

  lines.push(`YouTube Cookies\uff1a${getYtDlpCookiesStatus()}`);

  const depSummary = summarizeDependencyReport(generateDependencyReport());
  for (const item of depSummary) {
    lines.push(item);
  }

  return lines.join('\n').slice(0, 1900);
}

function probeFfmpeg() {
  try {
    const info = prism.FFmpeg.getInfo(true);
    return {
      ok: true,
      command: info.command,
      version: String(info.version || '').trim(),
    };
  } catch (error) {
    return {
      ok: false,
      error: compactErrorText(error),
    };
  }
}

function resolveYtDlpCookiesFilePath() {
  if (!YTDLP_COOKIES_FILE) {
    return '';
  }
  return path.isAbsolute(YTDLP_COOKIES_FILE)
    ? YTDLP_COOKIES_FILE
    : path.join(__dirname, YTDLP_COOKIES_FILE);
}

function getYtDlpRuntimeOptions(options = {}) {
  const cookieFile = resolveYtDlpCookiesFilePath();
  if (!cookieFile) {
    return options;
  }
  return {
    ...options,
    cookies: cookieFile,
  };
}

function getYtDlpCookiesStatus() {
  const cookieFile = resolveYtDlpCookiesFilePath();
  if (!cookieFile) {
    return '\u672a\u8a2d\u5b9a\uff08YTDLP_COOKIES_FILE\uff09';
  }
  if (fs.existsSync(cookieFile)) {
    return `\u5df2\u5957\u7528\uff08${cookieFile}\uff09`;
  }
  return `\u627e\u4e0d\u5230\u6a94\u6848\uff08${cookieFile}\uff09`;
}

function probeYtDlp() {
  const candidates = [];
  if (process.env.YTDLP_BINARY) {
    candidates.push(process.env.YTDLP_BINARY.trim());
  }
  if (ytdlp?.constants?.YOUTUBE_DL_PATH) {
    candidates.push(String(ytdlp.constants.YOUTUBE_DL_PATH).trim());
  }
  candidates.push('yt-dlp');
  candidates.push('youtube-dl');

  const uniq = Array.from(new Set(candidates.filter(Boolean)));
  const errors = [];

  for (const candidate of uniq) {
    const result = spawnSync(candidate, ['--version'], {
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
    });

    if (!result.error && result.status === 0) {
      return {
        ok: true,
        command: candidate,
        version: String(result.stdout || '').trim().split(/\r?\n/)[0] || '',
      };
    }

    const detail = result.error
      ? compactErrorText(result.error)
      : `exit=${typeof result.status === 'number' ? result.status : 'unknown'}`;
    errors.push(`${candidate}: ${detail}`);
  }

  return {
    ok: false,
    error: errors[0] || 'unknown',
  };
}

function summarizeDependencyReport(report) {
  const lines = String(report || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const summary = [];
  const pick = (prefix, label) => {
    const hit = lines.find((line) => line.startsWith(prefix));
    if (hit) {
      summary.push(`${label}${hit.replace(/^-+\s*/, '')}`);
    }
  };

  pick('- @discordjs/opus:', 'Opus \u539f\u751f\uff1a');
  pick('- opusscript:', 'Opus \u7d14 JS\uff1a');
  pick('- native crypto support for aes-256-gcm:', 'AES-GCM\uff1a');
  pick('- libopus:', 'FFmpeg libopus\uff1a');

  return summary;
}

function compactErrorText(error) {
  const raw =
    (error && typeof error === 'object'
      ? error.stderr || error.stdout || error.message || String(error)
      : String(error || 'unknown')) || 'unknown';
  return raw.replace(/\s+/g, ' ').trim().slice(0, 180);
}

function formatPlaybackErrorReason(error) {
  const raw = compactErrorText(error).toLowerCase();

  if (raw.includes('ffmpeg/avconv not found') || (raw.includes('ffmpeg') && raw.includes('enoent'))) {
    return '\u627e\u4e0d\u5230 FFmpeg\uff0c\u8acb\u5148\u5b89\u88dd\uff08Linux\uff1a`apt install -y ffmpeg`\uff09\u3002';
  }
  if (
    (raw.includes('yt-dlp') || raw.includes('youtube-dl')) &&
    (raw.includes('enoent') || raw.includes('permission denied') || raw.includes('not found'))
  ) {
    return 'yt-dlp \u7121\u6cd5\u57f7\u884c\uff0c\u8acb\u5b89\u88dd\u6216\u4fee\u6b63\u57f7\u884c\u6b0a\u9650\uff08Linux\uff1a`apt install -y yt-dlp`\uff09\u3002';
  }
  if (
    raw.includes('opusscript') ||
    raw.includes('@discordjs/opus') ||
    raw.includes('cannot play audio') ||
    raw.includes('encoder')
  ) {
    return 'Opus \u7de8\u78bc\u5668\u4e0d\u53ef\u7528\uff0c\u8acb\u5728\u5c08\u6848\u76ee\u9304\u91cd\u65b0\u57f7\u884c `npm install`\u3002';
  }
  if (raw.includes("sign in to confirm you're not a bot") || raw.includes('--cookies-from-browser')) {
    return 'YouTube \u89f8\u767c\u4eba\u6a5f\u9a57\u8b49\uff0c\u8acb\u8a2d\u5b9a YTDLP_COOKIES_FILE \u4e26\u653e\u5165\u6709\u6548 cookies.txt \u5f8c\u518d\u8a66\u3002';
  }
  if (raw.includes('403 forbidden') || raw.includes('http error 403')) {
    return '\u5f71\u7247\u4f86\u6e90\u62d2\u7d55\u4e32\u6d41\uff08403\uff09\uff0c\u8acb\u6539\u64ad\u53e6\u4e00\u500b\u7248\u672c\u3002';
  }
  if (raw.includes('video unavailable')) {
    return '\u5f71\u7247\u76ee\u524d\u4e0d\u53ef\u7528\uff0c\u8acb\u63db\u4e00\u9996\u3002';
  }
  if (raw.includes('certificate') || raw.includes('ssl') || raw.includes('tls')) {
    return 'TLS/\u6191\u8b49\u9023\u7dda\u5931\u6557\uff0c\u8acb\u78ba\u8a8d\u4e3b\u6a5f\u53ef\u6b63\u5e38\u9023\u5916\u4e26\u5df2\u5b89\u88dd\u6191\u8b49\u3002';
  }
  return compactErrorText(error);
}

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('play')
      .setDescription('播放音樂（支援歌名、YouTube 連結、Spotify 連結）')
      .addStringOption((option) =>
        option
          .setName('query')
          .setDescription('歌名或連結')
          .setRequired(true),
      ),
    new SlashCommandBuilder()
      .setName('diag')
      .setDescription('\u6aa2\u67e5 ffmpeg / yt-dlp / \u8a9e\u97f3\u4f9d\u8cf4\u662f\u5426\u6b63\u5e38'),
    new SlashCommandBuilder().setName('skip').setDescription('跳過目前歌曲'),
    new SlashCommandBuilder().setName('pause').setDescription('暫停播放'),
    new SlashCommandBuilder().setName('resume').setDescription('繼續播放'),
    new SlashCommandBuilder().setName('queue').setDescription('查看目前佇列'),
    new SlashCommandBuilder()
      .setName('clearupcoming')
      .setDescription('\u6e05\u9664\u6240\u6709\u5f85\u64ad\u6b4c\u66f2\uff08\u4e0d\u5f71\u97ff\u76ee\u524d\u64ad\u653e\uff09'),
    new SlashCommandBuilder()
      .setName('spotifylogin')
      .setDescription('\u6388\u6b0a Spotify\uff08\u4f9b Spotify \u6b4c\u55ae\u89e3\u6790\u4f7f\u7528\uff09'),
    new SlashCommandBuilder()
      .setName('spotifycallback')
      .setDescription('\u8cbc\u4e0a Spotify \u56de\u547c URL \u4ee5\u5b8c\u6210\u6388\u6b0a')
      .addStringOption((option) =>
        option
          .setName('callback_url')
          .setDescription('Spotify \u6388\u6b0a\u5f8c\u700f\u89bd\u5668\u5740\u5217\u7684\u5b8c\u6574 URL')
          .setRequired(true),
      ),
    new SlashCommandBuilder()
      .setName('spotifylogout')
      .setDescription('\u79fb\u9664\u4f60\u7684 Spotify \u6388\u6b0a'),
    new SlashCommandBuilder().setName('list').setDescription('顯示播放進度條與接下來歌曲清單'),
    new SlashCommandBuilder().setName('stop').setDescription('停止播放並清空佇列'),
    new SlashCommandBuilder().setName('leave').setDescription('讓機器人離開語音頻道'),
    new SlashCommandBuilder().setName('panel').setDescription('送出可點按的音樂控制面板'),
  ].map((x) => x.toJSON());

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  const explicitGuildIds = parseGuildIdList(
    process.env.DISCORD_GUILD_IDS || process.env.DISCORD_GUILD_ID || '',
  );
  const guildIds =
    explicitGuildIds.length > 0 ? explicitGuildIds : Array.from(client.guilds.cache.keys());

  if (guildIds.length > 0) {
    for (const guildId of guildIds) {
      await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, guildId), {
        body: commands,
      });
      console.log(`Registered guild commands for guild ${guildId}`);
    }

    // Prevent duplicate command entries when global commands were previously registered.
    await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: [] });
    console.log('Cleared global commands to avoid duplicate entries.');
    return;
  }

  await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: commands });
  console.log('No guild detected, registered global commands instead.');
}

function parseGuildIdList(raw) {
  return String(raw)
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter((x) => /^\d+$/.test(x));
}

class GuildMusicSession {
  constructor(guildId) {
    this.guildId = guildId;
    this.connection = null;
    this.currentTrack = null;
    this.currentTrackStartedAt = 0;
    this.currentTrackPausedAt = 0;
    this.currentTrackPausedTotalMs = 0;
    this.queue = [];
    this.textChannelId = null;
    this.playingLock = false;

    this.player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Pause,
      },
    });

    this.player.on(AudioPlayerStatus.Idle, () => {
      this.currentTrack = null;
      this.resetTrackClock();
      this.playIfIdle().catch((error) => {
        console.error('playIfIdle error:', error);
      });
    });

    this.player.on('error', (error) => {
      console.error('Audio player error:', error);
      this.currentTrack = null;
      this.resetTrackClock();
      this.playIfIdle().catch((err) => {
        console.error('Playback recovery failed:', err);
      });
    });

    this.player.on('stateChange', (oldState, newState) => {
      if (!this.currentTrack) {
        return;
      }

      const toPaused =
        newState.status === AudioPlayerStatus.Paused ||
        newState.status === AudioPlayerStatus.AutoPaused;
      const toPlaying = newState.status === AudioPlayerStatus.Playing;

      if (toPaused && !this.currentTrackPausedAt) {
        this.currentTrackPausedAt = Date.now();
      }

      if (toPlaying && this.currentTrackPausedAt) {
        this.currentTrackPausedTotalMs += Date.now() - this.currentTrackPausedAt;
        this.currentTrackPausedAt = 0;
      }
    });
  }

  setTextChannel(channelId) {
    this.textChannelId = channelId;
  }

  async connect(voiceChannel) {
    if (
      this.connection &&
      this.connection.joinConfig.guildId === voiceChannel.guild.id &&
      this.connection.joinConfig.channelId === voiceChannel.id
    ) {
      return;
    }

    this.disconnect();

    this.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: true,
    });

    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000);
      } catch {
        this.disconnect();
      }
    });

    await entersState(this.connection, VoiceConnectionStatus.Ready, 15_000);
    this.connection.subscribe(this.player);
  }

  disconnect() {
    if (this.connection) {
      this.connection.destroy();
      this.connection = null;
    }
  }

  enqueue(tracks) {
    this.queue.push(...tracks);
  }

  skip() {
    this.player.stop(true);
  }

  pause() {
    const paused = this.player.pause();
    if (paused && this.currentTrack && !this.currentTrackPausedAt) {
      this.currentTrackPausedAt = Date.now();
    }
    return paused;
  }

  resume() {
    const resumed = this.player.unpause();
    if (resumed && this.currentTrackPausedAt) {
      this.currentTrackPausedTotalMs += Date.now() - this.currentTrackPausedAt;
      this.currentTrackPausedAt = 0;
    }
    return resumed;
  }

  stopAndClear() {
    this.queue = [];
    this.currentTrack = null;
    this.resetTrackClock();
    this.player.stop(true);
  }

  clearUpcoming() {
    const removedCount = this.queue.length;
    this.queue = [];
    return removedCount;
  }

  resetTrackClock() {
    this.currentTrackStartedAt = 0;
    this.currentTrackPausedAt = 0;
    this.currentTrackPausedTotalMs = 0;
  }

  startTrackClock() {
    this.currentTrackStartedAt = Date.now();
    this.currentTrackPausedAt = 0;
    this.currentTrackPausedTotalMs = 0;
  }

  getElapsedSec() {
    if (!this.currentTrack) {
      return 0;
    }

    if (!this.currentTrackStartedAt) {
      this.startTrackClock();
      return 0;
    }

    const now = Date.now();
    const activePauseMs = this.currentTrackPausedAt ? now - this.currentTrackPausedAt : 0;
    const rawMs =
      now - this.currentTrackStartedAt - this.currentTrackPausedTotalMs - activePauseMs;
    return Math.max(0, Math.floor(rawMs / 1000));
  }

  async playIfIdle() {
    if (this.playingLock || this.currentTrack || !this.connection || !this.queue.length) {
      return;
    }

    this.playingLock = true;

    try {
      while (!this.currentTrack && this.queue.length) {
        const next = this.queue.shift();
        if (!next) {
          break;
        }

        try {
          const resource = await createPlaybackResource(next);

          if (resource.volume) {
            resource.volume.setVolume(Math.max(0, Math.min(1, DEFAULT_VOLUME_PERCENT / 100)));
          }

          this.currentTrack = next;
          this.startTrackClock();
          this.player.play(resource);

          await this.sendNowPlaying(next);
        } catch (error) {
          console.error('Track stream failed:', next.url, error);
          const reason = formatPlaybackErrorReason(error);
          await this.sendText(`\u64ad\u653e\u5931\u6557\uff0c\u5df2\u8df3\u904e\uff1a${next.title}\n\u539f\u56e0\uff1a${reason}`);
          this.currentTrack = null;
        }
      }
    } finally {
      this.playingLock = false;
    }
  }

  getQueueLines() {
    const lines = [];

    if (this.currentTrack) {
      lines.push(`正在播放：${this.currentTrack.title}（${formatDuration(this.currentTrack.durationSec)}）`);
    }

    if (this.queue.length) {
      lines.push('待播清單：');
      this.queue.slice(0, 10).forEach((track, index) => {
        lines.push(`${index + 1}. ${track.title} (${formatDuration(track.durationSec)})`);
      });

      if (this.queue.length > 10) {
        lines.push(`...還有 ${this.queue.length - 10} 首`);
      }
    }

    return lines;
  }

  async sendNowPlaying(track) {
    await this.sendText(`正在播放：**${track.title}**（${formatDuration(track.durationSec)}）`);
  }

  async sendText(message) {
    if (!this.textChannelId) {
      return;
    }

    try {
      const channel = await client.channels.fetch(this.textChannelId);
      if (channel?.isTextBased()) {
        await channel.send(message);
      }
    } catch (error) {
      console.error('sendText failed:', error);
    }
  }
}

async function resolveTracks(query, { requestedBy, requestedByUserId, onProgress = null }) {
  const trimmed = query.trim();

  if (!trimmed) {
    return [];
  }

  const normalizedInput = normalizeYouTubeInputUrl(trimmed);
  const normalizedSpotifyInput = await normalizeSpotifyInputUrl(normalizedInput);
  const spotifyType = parseSpotifyType(normalizedSpotifyInput);
  if (spotifyType) {
    if (!spotifyResolver.enabled) {
      throw new Error(
        '偵測到 Spotify 連結，但尚未設定 Spotify 金鑰。請在 .env 填入 SPOTIFY_CLIENT_ID 與 SPOTIFY_CLIENT_SECRET。',
      );
    }

    await onProgress?.({
      stage: 'spotify_fetch',
      force: true,
    });

    const spotifyTracks = await resolveSpotifySourceTracksWithAuthFallback({
      inputUrl: normalizedSpotifyInput,
      spotifyType,
      requestedByUserId,
    });

    return resolveSpotifyTracksToYoutube(spotifyTracks, {
      requestedBy,
      onProgress,
    });
  }

  const ytType = play.yt_validate(normalizedInput);

  if (ytType === 'video') {
    try {
      const info = await play.video_basic_info(normalizedInput);
      const video = info.video_details;
      return [
        {
          title: video.title,
          url: video.url,
          durationSec: numberOrZero(video.durationInSec),
          requestedBy,
          source: 'youtube',
        },
      ];
    } catch (error) {
      console.warn('play-dl video_basic_info failed, fallback to yt-dlp:', error?.message || error);
    }
  }

  if (ytType === 'playlist') {
    try {
      const playlist = await play.playlist_info(normalizedInput, { incomplete: true });
      const videos = await playlist.all_videos();
      const tracks = videos.slice(0, MAX_YOUTUBE_PLAYLIST_TRACKS).map((video) => ({
        title: video.title,
        url: video.url,
        durationSec: numberOrZero(video.durationInSec),
        requestedBy,
        source: 'youtube',
      }));

      if (tracks.length > 0) {
        return tracks;
      }
    } catch (error) {
      console.warn('play-dl playlist_info failed, fallback to yt-dlp:', error?.message || error);
    }
  }

  if (isYouTubeLikeUrl(normalizedInput)) {
    const youtubeTracks = await resolveYouTubeUrlWithYtDlp(normalizedInput, {
      requestedBy,
      maxTracks: MAX_YOUTUBE_PLAYLIST_TRACKS,
    }).catch(() => []);

    if (youtubeTracks.length > 0) {
      return youtubeTracks;
    }
  }

  const direct = await searchYouTubeTrack(trimmed);
  return direct
    ? [
        {
          ...direct,
          requestedBy,
          source: 'youtube',
        },
      ]
    : [];
}

async function searchYouTubeTrack(input) {
  try {
    const results = await play.search(input, {
      limit: 1,
      source: {
        youtube: 'video',
      },
    });

    const first = results?.[0];
    if (first) {
      return {
        title: first.title,
        url: first.url,
        durationSec: numberOrZero(first.durationInSec),
      };
    }
  } catch (error) {
    console.warn('play-dl search failed, fallback to yt-dlp:', error?.message || error);
  }

  try {
    const info = await ytdlp(`ytsearch1:${input}`, getYtDlpRuntimeOptions({
      dumpSingleJson: true,
      skipDownload: true,
      noWarnings: true,
      noCheckCertificates: true,
      noCallHome: true,
      preferFreeFormats: true,
      youtubeSkipDashManifest: true,
    }));

    const entry =
      Array.isArray(info?.entries) && info.entries.length > 0
        ? info.entries[0]
        : info && typeof info === 'object'
          ? info
          : null;
    if (!entry) {
      return null;
    }

    const url = entry.webpage_url || (entry.id ? `https://www.youtube.com/watch?v=${entry.id}` : null);
    if (!url) {
      return null;
    }

    return {
      title: entry.title || input,
      url: normalizeYouTubeInputUrl(url),
      durationSec: numberOrZero(entry.duration),
    };
  } catch {
    return null;
  }
}

async function resolveSpotifySourceTracksWithAuthFallback({ inputUrl, spotifyType, requestedByUserId }) {
  try {
    return await spotifyResolver.resolve(inputUrl, MAX_SPOTIFY_TRACKS);
  } catch (baseError) {
    const canUseUserToken =
      spotifyType === 'playlist' &&
      spotifyOAuthManager?.enabled &&
      isSpotifyUserTokenFallbackError(baseError);
    if (!canUseUserToken) {
      throw baseError;
    }

    const tokenCandidates = [];
    const seenTokens = new Set();
    const requestedUserToken = await spotifyOAuthManager.getUserAccessToken(requestedByUserId);
    if (requestedUserToken) {
      tokenCandidates.push({ label: 'requester', userId: String(requestedByUserId), token: requestedUserToken });
      seenTokens.add(requestedUserToken);
    }

    const otherUserTokens = await spotifyOAuthManager.getAllUserAccessTokens({
      excludeUserIds: [requestedByUserId],
    });
    for (const row of otherUserTokens) {
      if (!row?.token || seenTokens.has(row.token)) {
        continue;
      }
      seenTokens.add(row.token);
      tokenCandidates.push({ label: 'shared', userId: row.userId, token: row.token });
    }

    if (!tokenCandidates.length) {
      throw new Error(
        '這個 Spotify 歌單需要使用者授權。請先執行 /spotifylogin，授權後若瀏覽器停在 127.0.0.1，請把完整網址貼到 /spotifycallback 完成綁定。',
      );
    }

    let lastTokenError = baseError;
    const tokenErrors = [];
    for (const candidate of tokenCandidates) {
      try {
        return await spotifyResolver.resolve(inputUrl, MAX_SPOTIFY_TRACKS, {
          accessTokenOverride: candidate.token,
        });
      } catch (tokenError) {
        lastTokenError = tokenError;
        tokenErrors.push(tokenError);
      }
    }

    if (tokenErrors.some((error) => isSpotifyUserNotRegisteredError(error))) {
      throw new Error(
        'Spotify 開發模式限制：其中一個授權帳號尚未加入此 App 的 Users and Access。請到 Spotify Developer Dashboard -> 你的 App -> Users and Access 加入該帳號，然後重新 /spotifylogin + /spotifycallback。',
      );
    }

    if (isSpotifyForbiddenError(lastTokenError)) {
      throw new Error(
        `Spotify 回傳 403 Forbidden：已嘗試 ${tokenCandidates.length} 個授權帳號，皆無法讀取此歌單。請改成公開歌單，或用有權限的帳號執行 /spotifylogin + /spotifycallback 後再試。`,
      );
    }

    throw lastTokenError;
  }
}

async function resolveSpotifyTracksToYoutube(spotifyTracks, { requestedBy, onProgress = null }) {
  const total = Math.max(0, spotifyTracks.length);
  const resolved = [];
  const skippedTitles = [];
  const dedupedTitles = [];

  if (!total) {
    resolved.skippedTitles = skippedTitles;
    resolved.dedupedTitles = dedupedTitles;
    return resolved;
  }

  let processed = 0;
  let added = 0;
  let skipped = 0;
  let deduped = 0;
  let nextIndex = 0;
  const workerCount = Math.min(SPOTIFY_SEARCH_CONCURRENCY, total);
  const candidateResults = new Array(total);

  const maybeReport = async (force = false) => {
    if (!onProgress) {
      return;
    }
    if (!force && processed % SPOTIFY_PROGRESS_EVERY !== 0) {
      return;
    }

    await onProgress({
      stage: 'spotify_search',
      total,
      processed,
      added,
      skipped,
      deduped,
      force,
    });
  };

  await maybeReport(true);

  const workers = Array.from({ length: workerCount }, () =>
    (async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= total) {
          break;
        }

        const item = spotifyTracks[index];
        const fallbackTitle = buildSpotifyFallbackTitle(item);
        const queryCandidates = [
          `${fallbackTitle} audio`,
          `${fallbackTitle} official audio`,
          `${fallbackTitle}`,
        ];

        let yt = null;
        for (const candidate of queryCandidates) {
          yt = await searchYouTubeTrack(candidate).catch(() => null);
          if (yt) {
            break;
          }
        }
        candidateResults[index] = {
          fallbackTitle,
          yt,
        };

        processed += 1;
        await maybeReport(processed >= total);
      }
    })(),
  );

  await Promise.all(workers);

  const seenResolvedKeys = new Set();
  for (const candidate of candidateResults) {
    if (!candidate?.yt) {
      skipped += 1;
      if (candidate?.fallbackTitle) {
        skippedTitles.push(candidate.fallbackTitle);
      }
      continue;
    }

    const dedupKey = createTrackDedupKey(candidate.yt);
    if (dedupKey && seenResolvedKeys.has(dedupKey)) {
      deduped += 1;
      if (candidate.fallbackTitle) {
        dedupedTitles.push(candidate.fallbackTitle);
      }
      continue;
    }

    if (dedupKey) {
      seenResolvedKeys.add(dedupKey);
    }

    added += 1;
    resolved.push({
      ...candidate.yt,
      requestedBy,
      source: 'spotify->youtube',
    });
  }

  await maybeReport(true);

  resolved.skippedTitles = skippedTitles;
  resolved.dedupedTitles = dedupedTitles;
  return resolved;
}

function buildSpotifyFallbackTitle(item) {
  const artistText = Array.isArray(item?.artists) && item.artists.length > 0 ? item.artists.join(', ') : '';
  return artistText ? `${artistText} - ${item.name}` : item.name;
}

async function createPlaybackResource(track) {
  const playableUrl = await resolvePlayableAudioUrl(track);
  const filterArgs = ENABLE_AUDIO_NORMALIZER ? ['-af', AUDIO_FILTER_CHAIN] : [];
  const ffmpeg = new prism.FFmpeg({
    args: [
      '-reconnect',
      '1',
      '-reconnect_streamed',
      '1',
      '-reconnect_delay_max',
      '5',
      '-i',
      playableUrl,
      '-analyzeduration',
      '0',
      '-loglevel',
      '0',
      '-vn',
      ...filterArgs,
      '-f',
      's16le',
      '-ar',
      '48000',
      '-ac',
      '2',
    ],
  });

  return createAudioResource(ffmpeg, {
    inputType: StreamType.Raw,
    inlineVolume: true,
  });
}

async function resolvePlayableAudioUrl(track) {
  try {
    return await extractAudioUrl(track.url);
  } catch (firstError) {
    const fallbackResults = await play
      .search(`${track.title} audio`, {
        limit: 5,
        source: {
          youtube: 'video',
        },
      })
      .catch(() => []);

    const visited = new Set([track.url]);

    for (const candidate of fallbackResults) {
      if (!candidate?.url || visited.has(candidate.url)) {
        continue;
      }
      visited.add(candidate.url);

      try {
        return await extractAudioUrl(candidate.url);
      } catch {
        // Try next fallback candidate.
      }
    }

    throw firstError;
  }
}

async function extractAudioUrl(videoUrl) {
  const info = await ytdlp(videoUrl, getYtDlpRuntimeOptions({
    dumpSingleJson: true,
    noWarnings: true,
    noCallHome: true,
    noCheckCertificates: true,
    noPlaylist: true,
    preferFreeFormats: true,
    youtubeSkipDashManifest: true,
    format: 'bestaudio/best',
  }));

  if (typeof info?.url === 'string' && info.url.startsWith('http')) {
    return info.url;
  }

  const fallbackFormat = (info?.formats || []).find(
    (item) =>
      typeof item?.url === 'string' &&
      item.url.startsWith('http') &&
      typeof item?.acodec === 'string' &&
      item.acodec !== 'none',
  );

  if (fallbackFormat?.url) {
    return fallbackFormat.url;
  }

  throw new Error('這首歌找不到可播放的音訊來源。');
}

function normalizeYouTubeInputUrl(input) {
  const raw = input.trim();
  if (!raw) {
    return raw;
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    return raw;
  }

  const hostname = url.hostname.toLowerCase();
  const youtubeHosts = new Set([
    'youtube.com',
    'www.youtube.com',
    'm.youtube.com',
    'music.youtube.com',
    'youtu.be',
    'www.youtu.be',
  ]);

  if (!youtubeHosts.has(hostname)) {
    return raw;
  }

  url.protocol = 'https:';
  url.searchParams.delete('si');
  url.searchParams.delete('feature');
  url.searchParams.delete('pp');

  const buildWatchUrl = (videoId) => {
    const next = new URL('https://www.youtube.com/watch');
    next.searchParams.set('v', videoId);
    for (const key of ['list', 'index', 'start', 't']) {
      const value = url.searchParams.get(key);
      if (value) {
        next.searchParams.set(key, value);
      }
    }
    return next.toString();
  };

  if (hostname === 'youtu.be' || hostname === 'www.youtu.be') {
    const videoId = url.pathname.split('/').filter(Boolean)[0];
    return videoId ? buildWatchUrl(videoId) : raw;
  }

  const path = url.pathname.split('/').filter(Boolean);
  if (path[0] === 'shorts' || path[0] === 'live') {
    const videoId = path[1];
    return videoId ? buildWatchUrl(videoId) : raw;
  }

  url.hostname = 'www.youtube.com';

  if (url.pathname === '/watch' && !url.searchParams.get('v') && url.searchParams.get('list')) {
    url.pathname = '/playlist';
  }

  return url.toString();
}

function createTrackDedupKey(track) {
  const rawUrl = typeof track?.url === 'string' ? track.url.trim() : '';
  if (!rawUrl) {
    return '';
  }

  const normalizedUrl = normalizeYouTubeInputUrl(rawUrl);
  try {
    const url = new URL(normalizedUrl);
    const host = url.hostname.toLowerCase();

    if (host === 'youtu.be' || host === 'www.youtu.be') {
      const shortId = url.pathname.split('/').filter(Boolean)[0];
      if (shortId) {
        return `yt:${shortId}`;
      }
    }

    if (new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']).has(host)) {
      const watchId = url.searchParams.get('v');
      if (watchId) {
        return `yt:${watchId}`;
      }

      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length >= 2 && new Set(['shorts', 'live', 'embed']).has(parts[0])) {
        return `yt:${parts[1]}`;
      }
    }
  } catch {}

  return `url:${normalizedUrl}`;
}

async function normalizeSpotifyInputUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) {
    return raw;
  }

  const parsed = parseSpotifyResource(raw);
  if (parsed) {
    return toCanonicalSpotifyInput(parsed);
  }

  const candidateUrl = extractFirstHttpUrl(raw);
  const expanded = await resolveSpotifyShortUrl(candidateUrl);
  if (!expanded) {
    return raw;
  }

  const parsedExpanded = parseSpotifyResource(expanded);
  if (!parsedExpanded) {
    return raw;
  }

  return toCanonicalSpotifyInput(parsedExpanded);
}

function toCanonicalSpotifyInput(parsed) {
  // Keep URI form for backward compatibility with parse flow and logs.
  if (parsed.raw.startsWith('spotify:')) {
    return parsed.raw;
  }
  return `https://open.spotify.com/${parsed.kind}/${parsed.id}`;
}

async function resolveSpotifyShortUrl(candidateUrl) {
  if (!candidateUrl) {
    return null;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(candidateUrl);
  } catch {
    return null;
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return null;
  }

  const shortHosts = new Set(['spotify.link', 'www.spotify.link', 'spoti.fi', 'www.spoti.fi']);
  if (!shortHosts.has(parsedUrl.hostname.toLowerCase())) {
    return null;
  }

  try {
    const res = await fetch(parsedUrl.toString(), {
      method: 'GET',
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (res?.url && parseSpotifyResource(res.url)) {
      return res.url;
    }
  } catch {}

  try {
    const oembedUrl = new URL('https://open.spotify.com/oembed');
    oembedUrl.searchParams.set('url', parsedUrl.toString());

    const res = await fetch(oembedUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      return null;
    }

    const data = await res.json();
    const html = typeof data?.html === 'string' ? data.html : '';
    const embedMatch = html.match(/https:\/\/open\.spotify\.com\/embed\/(track|album|playlist)\/([A-Za-z0-9]{8,})/i);
    if (!embedMatch) {
      return null;
    }
    return `https://open.spotify.com/${embedMatch[1].toLowerCase()}/${embedMatch[2]}`;
  } catch {
    return null;
  }
}

function isYouTubeLikeUrl(input) {
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    return false;
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    return false;
  }

  const hostname = url.hostname.toLowerCase();
  return new Set([
    'youtube.com',
    'www.youtube.com',
    'm.youtube.com',
    'music.youtube.com',
    'youtu.be',
    'www.youtu.be',
  ]).has(hostname);
}

async function resolveYouTubeUrlWithYtDlp(input, { requestedBy, maxTracks }) {
  const limit = clamp(numberOrZero(maxTracks) || MAX_YOUTUBE_PLAYLIST_TRACKS, 1, 9999);
  const info = await ytdlp(input, getYtDlpRuntimeOptions({
    dumpSingleJson: true,
    skipDownload: true,
    noWarnings: true,
    noCallHome: true,
    noCheckCertificates: true,
    preferFreeFormats: true,
    youtubeSkipDashManifest: true,
    flatPlaylist: true,
    extractorRetries: 2,
    retries: 2,
  }));

  const mapEntryToTrack = (entry) => {
    if (!entry || typeof entry !== 'object') {
      return null;
    }

    const videoId =
      typeof entry.id === 'string'
        ? entry.id
        : typeof entry.url === 'string' && /^[A-Za-z0-9_-]{8,}$/.test(entry.url)
          ? entry.url
          : null;

    const rawUrl = [entry.webpage_url, entry.original_url, entry.url].find(
      (value) => typeof value === 'string' && value.length > 0,
    );

    let url = null;
    if (rawUrl && /^https?:\/\//i.test(rawUrl)) {
      url = normalizeYouTubeInputUrl(rawUrl);
    } else if (videoId) {
      url = `https://www.youtube.com/watch?v=${videoId}`;
    }

    if (!url) {
      return null;
    }

    const title =
      typeof entry.title === 'string' && entry.title.trim()
        ? entry.title.trim()
        : videoId
          ? `YouTube - ${videoId}`
          : 'YouTube';

    return {
      title,
      url,
      durationSec: numberOrZero(entry.duration ?? entry.durationInSec),
      requestedBy,
      source: 'youtube',
    };
  };

  if (Array.isArray(info?.entries) && info.entries.length > 0) {
    const tracks = [];

    for (const entry of info.entries) {
      if (tracks.length >= limit) {
        break;
      }

      const track = mapEntryToTrack(entry);
      if (track) {
        tracks.push(track);
      }
    }

    return tracks;
  }

  const singleTrack = mapEntryToTrack(info);
  return singleTrack ? [singleTrack] : [];
}

function parseSpotifyType(input) {
  const parsed = parseSpotifyResource(input);
  return parsed?.kind || null;
}

function parseSpotifyResource(input) {
  const rawInput = String(input || '').trim();
  if (!rawInput) {
    return null;
  }

  const unwrapped = rawInput.replace(/^<(.+)>$/, '$1').trim();

  const uriMatch = unwrapped.match(/spotify:(track|album|playlist):([A-Za-z0-9]{8,})/i);
  if (uriMatch) {
    return {
      kind: uriMatch[1].toLowerCase(),
      id: uriMatch[2],
      raw: unwrapped,
    };
  }

  const candidateUrl = extractFirstHttpUrl(unwrapped);
  if (!candidateUrl) {
    return null;
  }

  let url;
  try {
    url = new URL(candidateUrl);
  } catch {
    return null;
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    return null;
  }

  const host = url.hostname.toLowerCase();
  if (!new Set(['open.spotify.com', 'play.spotify.com']).has(host)) {
    return null;
  }

  const pathParts = url.pathname.split('/').filter(Boolean);
  if (!pathParts.length) {
    return null;
  }

  // Spotify localized links often include /intl-xx/ prefix.
  if (/^intl-[a-z]{2}(?:-[a-z]{2})?$/i.test(pathParts[0])) {
    pathParts.shift();
  }

  if (pathParts[0] === 'embed') {
    pathParts.shift();
  }

  if (!pathParts.length) {
    return null;
  }

  const directKind = pathParts[0]?.toLowerCase();
  const directId = pathParts[1];
  if (new Set(['track', 'album', 'playlist']).has(directKind) && /^[A-Za-z0-9]{8,}$/.test(directId || '')) {
    return {
      kind: directKind,
      id: directId,
      raw: unwrapped,
    };
  }

  const legacyUserPlaylistMatch = pathParts.join('/').match(
    /^user\/[^/]+\/playlist\/([A-Za-z0-9]{8,})$/i,
  );
  if (legacyUserPlaylistMatch) {
    return {
      kind: 'playlist',
      id: legacyUserPlaylistMatch[1],
      raw: unwrapped,
    };
  }

  return null;
}

function extractFirstHttpUrl(text) {
  const match = String(text).match(/https?:\/\/[^\s)>\]}]+/i);
  return match ? match[0] : null;
}

function isSpotifyUserAuthRequiredError(error) {
  const text = String(error?.message || '');
  return /spotify api/i.test(text) && /valid user authentication required/i.test(text);
}

function parseSpotifyApiStatusCode(error) {
  const text = String(error?.message || '');
  const match =
    text.match(/spotify api.*?[（(]\s*(\d{3})\s*[)）]/i) ||
    text.match(/spotify api[\s\S]*?\b(\d{3})\b/i);
  if (!match) {
    return 0;
  }
  return numberOrZero(match[1]);
}

function isSpotifyForbiddenError(error) {
  const text = String(error?.message || '');
  return parseSpotifyApiStatusCode(error) === 403 || (/spotify api/i.test(text) && /forbidden/i.test(text));
}

function isSpotifyUserNotRegisteredError(error) {
  const text = String(error?.message || '');
  return /not registered for this application/i.test(text);
}

function isSpotifyUserTokenFallbackError(error) {
  return isSpotifyUserAuthRequiredError(error) || isSpotifyForbiddenError(error);
}

class SpotifyUserTokenStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { users: {} };
    this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) {
        return;
      }
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = {
        users: typeof parsed?.users === 'object' && parsed.users ? parsed.users : {},
      };
    } catch (error) {
      console.warn('Failed to load Spotify user token store:', error?.message || error);
      this.data = { users: {} };
    }
  }

  save() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
  }

  get(discordUserId) {
    return this.data.users[String(discordUserId)] || null;
  }

  getFirstUserId() {
    const keys = Object.keys(this.data.users || {});
    return keys.length > 0 ? keys[0] : null;
  }

  getAllUserIds() {
    return Object.keys(this.data.users || {});
  }

  set(discordUserId, payload) {
    this.data.users[String(discordUserId)] = payload;
    this.save();
  }

  clear(discordUserId) {
    const key = String(discordUserId);
    const exists = Boolean(this.data.users[key]);
    if (exists) {
      delete this.data.users[key];
      this.save();
    }
    return exists;
  }
}

class SpotifyOAuthManager {
  constructor({ clientId, clientSecret, redirectUri, scopes, tokenStore }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;
    this.scopes = scopes;
    this.tokenStore = tokenStore;
    this.pendingStates = new Map();
    this.server = null;
  }

  get enabled() {
    return Boolean(this.clientId && this.clientSecret && this.redirectUri);
  }

  createAuthorizationUrl(discordUserId) {
    if (!this.enabled) {
      throw new Error('Spotify OAuth is not configured.');
    }

    const state = crypto.randomBytes(24).toString('hex');
    this.pendingStates.set(state, {
      discordUserId: String(discordUserId),
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    const url = new URL('https://accounts.spotify.com/authorize');
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', this.redirectUri);
    url.searchParams.set('scope', this.scopes);
    url.searchParams.set('state', state);
    url.searchParams.set('show_dialog', 'true');
    return url.toString();
  }

  clearUserToken(discordUserId) {
    return this.tokenStore.clear(discordUserId);
  }

  async completeAuthorizationFromCallbackUrl(callbackUrl, { actingDiscordUserId = null } = {}) {
    if (!this.enabled) {
      throw new Error('Spotify OAuth is not configured.');
    }

    const rawInput = String(callbackUrl || '').trim();
    if (!rawInput) {
      throw new Error('\u8acb\u63d0\u4f9b\u5b8c\u6574\u7684 callback URL\u3002');
    }

    const candidate = extractFirstHttpUrl(rawInput) || rawInput.replace(/^<(.+)>$/, '$1').trim();
    let incoming;
    try {
      incoming = new URL(candidate);
    } catch {
      throw new Error('\u7121\u6cd5\u89e3\u6790 callback URL\uff0c\u8acb\u78ba\u8a8d\u4f60\u8cbc\u7684\u662f\u700f\u89bd\u5668\u5740\u5217\u5b8c\u6574\u9023\u7d50\u3002');
    }

    const expected = new URL(this.redirectUri);
    if (incoming.pathname !== expected.pathname) {
      throw new Error('\u9019\u4e0d\u662f\u6b64\u6a5f\u5668\u4eba\u7684 Spotify callback \u8def\u5f91\uff0c\u8acb\u91cd\u65b0\u57f7\u884c /spotifylogin \u5f8c\u518d\u8a66\u3002');
    }

    const error = incoming.searchParams.get('error');
    if (error) {
      throw new Error(`Spotify \u6388\u6b0a\u5931\u6557\uff1a${error}`);
    }

    const code = incoming.searchParams.get('code');
    const state = incoming.searchParams.get('state');
    const pending = this.consumePendingState(state);
    if (!code || !pending) {
      throw new Error('\u6388\u6b0a\u9023\u7d50\u5df2\u904e\u671f\u6216 state \u4e0d\u7b26\uff0c\u8acb\u91cd\u65b0\u57f7\u884c /spotifylogin\u3002');
    }

    if (actingDiscordUserId && String(actingDiscordUserId) !== String(pending.discordUserId)) {
      throw new Error('\u9019\u500b\u6388\u6b0a\u9023\u7d50\u662f\u7d66\u5176\u4ed6 Discord \u5e33\u865f\u7684\uff0c\u8acb\u7528\u540c\u4e00\u500b\u5e33\u865f\u91cd\u65b0 /spotifylogin\u3002');
    }

    const token = await this.requestToken({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
    });

    this.saveUserToken(pending.discordUserId, token);
    return pending.discordUserId;
  }

  async getUserAccessToken(discordUserId) {
    const record = this.tokenStore.get(discordUserId);
    if (!record) {
      return null;
    }

    const now = Date.now();
    if (record.accessToken && now < Number(record.expiresAt || 0) - 60_000) {
      return record.accessToken;
    }

    if (!record.refreshToken) {
      return null;
    }

    try {
      const refreshed = await this.requestToken({
        grant_type: 'refresh_token',
        refresh_token: record.refreshToken,
      });
      this.saveUserToken(discordUserId, refreshed, {
        fallbackRefreshToken: record.refreshToken,
        fallbackScope: record.scope || this.scopes,
      });
      return refreshed.access_token;
    } catch (error) {
      console.warn('Failed to refresh Spotify user token:', error?.message || error);
      return null;
    }
  }

  async getAnyUserAccessToken() {
    const userId = this.tokenStore.getFirstUserId();
    if (!userId) {
      return null;
    }
    return this.getUserAccessToken(userId);
  }

  async getAllUserAccessTokens({ excludeUserIds = [] } = {}) {
    const excluded = new Set((excludeUserIds || []).map((x) => String(x)));
    const userIds = this.tokenStore.getAllUserIds();
    const results = [];

    for (const userId of userIds) {
      if (excluded.has(String(userId))) {
        continue;
      }
      const token = await this.getUserAccessToken(userId);
      if (!token) {
        continue;
      }
      results.push({ userId: String(userId), token });
    }

    return results;
  }

  saveUserToken(discordUserId, token, { fallbackRefreshToken = null, fallbackScope = null } = {}) {
    this.tokenStore.set(discordUserId, {
      accessToken: token.access_token,
      refreshToken: token.refresh_token || fallbackRefreshToken || null,
      expiresAt: Date.now() + Math.max((token.expires_in || 3600) - 30, 60) * 1000,
      scope: token.scope || fallbackScope || this.scopes,
      updatedAt: new Date().toISOString(),
    });
  }

  async startCallbackServer() {
    if (!this.enabled || this.server) {
      return;
    }

    const redirectUrl = new URL(this.redirectUri);
    if (redirectUrl.protocol !== 'http:') {
      console.warn('Spotify OAuth callback server only supports http redirect URI.');
      return;
    }

    const host = redirectUrl.hostname || '127.0.0.1';
    const port = Number(redirectUrl.port || 80);
    const callbackPath = redirectUrl.pathname || '/';

    this.server = http.createServer(async (req, res) => {
      try {
        if (!req.url) {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Bad request');
          return;
        }

        const incoming = new URL(req.url, `${redirectUrl.protocol}//${req.headers.host}`);
        if (incoming.pathname !== callbackPath) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not found');
          return;
        }

        const error = incoming.searchParams.get('error');
        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h2>Spotify authorization failed.</h2><p>You can close this page.</p>');
          return;
        }

        const code = incoming.searchParams.get('code');
        const state = incoming.searchParams.get('state');
        const pending = this.consumePendingState(state);
        if (!code || !pending) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h2>Invalid authorization state.</h2><p>Please retry /spotifylogin.</p>');
          return;
        }

        const token = await this.requestToken({
          grant_type: 'authorization_code',
          code,
          redirect_uri: this.redirectUri,
        });

        this.saveUserToken(pending.discordUserId, token);

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          '<h2>Spotify authorization success.</h2><p>Return to Discord and use /play with a Spotify playlist URL.</p>',
        );
      } catch (serverError) {
        console.error('Spotify OAuth callback error:', serverError);
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h2>Internal error.</h2><p>Please retry /spotifylogin.</p>');
      }
    });

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });

    console.log(`Spotify OAuth callback server listening at ${this.redirectUri}`);
  }

  consumePendingState(state) {
    if (!state) {
      return null;
    }
    const pending = this.pendingStates.get(state);
    this.pendingStates.delete(state);
    if (!pending) {
      return null;
    }
    if (Date.now() > pending.expiresAt) {
      return null;
    }
    return pending;
  }

  async requestToken(formPayload) {
    const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const body = new URLSearchParams(formPayload);

    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await safeText(res);
      throw new Error(`Spotify OAuth token failed (${res.status}): ${text}`);
    }

    return res.json();
  }
}

class SpotifyMetadataResolver {
  constructor({ clientId, clientSecret, market }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.market = market;
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  get enabled() {
    return Boolean(this.clientId && this.clientSecret);
  }

  async resolve(url, limit, { accessTokenOverride = null } = {}) {
    const parsed = this.parseSpotifyUrl(url);
    if (!parsed) {
      throw new Error('Spotify 連結格式不正確。');
    }

    if (parsed.kind === 'track') {
      const track = await this.fetchTrack(parsed.id, accessTokenOverride);
      return [track];
    }

    if (parsed.kind === 'album') {
      return this.fetchAlbumTracks(parsed.id, limit, accessTokenOverride);
    }

    if (parsed.kind === 'playlist') {
      return this.fetchPlaylistTracks(parsed.id, limit, accessTokenOverride);
    }

    return [];
  }

  parseSpotifyUrl(raw) {
    const parsed = parseSpotifyResource(raw);
    if (!parsed) {
      return null;
    }
    return { kind: parsed.kind, id: parsed.id };
  }

  async fetchTrack(id, accessTokenOverride = null) {
    const data = await this.api(`/tracks/${id}`, {}, accessTokenOverride);
    return {
      name: data.name,
      artists: (data.artists || []).map((x) => x.name).filter(Boolean),
    };
  }

  async fetchAlbumTracks(id, limit, accessTokenOverride = null) {
    const tracks = [];
    let offset = 0;

    while (tracks.length < limit) {
      const data = await this.api(
        `/albums/${id}/tracks`,
        {
          limit: Math.min(50, limit - tracks.length),
          offset,
        },
        accessTokenOverride,
      );

      const items = data.items || [];
      for (const item of items) {
        tracks.push({
          name: item.name,
          artists: (item.artists || []).map((x) => x.name).filter(Boolean),
        });
      }

      if (!data.next || !items.length) {
        break;
      }
      offset += items.length;
    }

    return tracks;
  }

  async fetchPlaylistTracks(id, limit, accessTokenOverride = null) {
    const tracks = [];
    let offset = 0;

    while (tracks.length < limit) {
      const data = await this.api(
        `/playlists/${id}/items`,
        {
          market: this.market,
          additional_types: 'track',
          limit: Math.min(50, limit - tracks.length),
          offset,
        },
        accessTokenOverride,
      );

      const items = data.items || [];
      for (const row of items) {
        // Spotify Web API may return track rows as `row.track` (legacy)
        // or as `row.item` on newer playlist items responses.
        const item = row?.track || row?.item;
        if (!item) {
          continue;
        }

        const itemType = String(item.type || '').toLowerCase();
        const isTrackLike = itemType === 'track' || item.track === true;
        if (!isTrackLike) {
          continue;
        }

        tracks.push({
          name: item.name,
          artists: (item.artists || []).map((x) => x.name).filter(Boolean),
        });
      }

      if (!data.next || !items.length) {
        break;
      }
      offset += items.length;
    }

    return tracks;
  }

  async api(path, query = {}, accessTokenOverride = null) {
    if (!this.enabled) {
      throw new Error('尚未設定 Spotify 憑證。');
    }

    const token = accessTokenOverride || (await this.getAccessToken());
    const url = new URL(`https://api.spotify.com/v1${path}`);

    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, String(value));
    }

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!res.ok) {
      const text = await safeText(res);
      throw new Error(`Spotify API 失敗（${res.status}）：${text}`);
    }

    return res.json();
  }

  async getAccessToken() {
    const now = Date.now();
    if (this.token && now < this.tokenExpiresAt) {
      return this.token;
    }

    const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    if (!res.ok) {
      const text = await safeText(res);
      throw new Error(`Spotify token 取得失敗（${res.status}）：${text}`);
    }

    const data = await res.json();
    this.token = data.access_token;
    this.tokenExpiresAt = Date.now() + Math.max((data.expires_in || 3600) - 60, 60) * 1000;
    return this.token;
  }
}

spotifyResolver = new SpotifyMetadataResolver({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  market: process.env.SPOTIFY_MARKET || 'US',
});

spotifyOAuthManager = new SpotifyOAuthManager({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  redirectUri: SPOTIFY_REDIRECT_URI,
  scopes: SPOTIFY_OAUTH_SCOPES,
  tokenStore: new SpotifyUserTokenStore(SPOTIFY_USER_TOKEN_FILE),
});

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return '未知錯誤';
  }
}

function toNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toBoolean(value, fallback) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(v)) {
      return true;
    }
    if (['0', 'false', 'no', 'off'].includes(v)) {
      return false;
    }
  }
  return fallback;
}

function numberOrZero(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function formatDuration(seconds) {
  const sec = numberOrZero(seconds);

  if (sec <= 0) {
    return 'LIVE/未知長度';
  }

  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;

  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatClockDuration(seconds) {
  const sec = Math.max(0, numberOrZero(seconds));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;

  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatTimeHms(date) {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

