const { spawn } = require('node:child_process');
const {
  AudioPlayerStatus,
  entersState,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
} = require('@discordjs/voice');
const play = require('play-dl');
const ffmpegPath = require('ffmpeg-static');
const { PermissionFlagsBits } = require('discord.js');
const { GuildConfig } = require('../../database/models');
const logger = require('../../utils/logger');

const IDLE_DISCONNECT_MS = 60_000;
const CONNECTION_READY_TIMEOUT_MS = 20_000;
const MAX_QUEUE_SIZE = 100;
const MAX_VOLUME = 200;

class MusicError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MusicError';
  }
}

function shuffleTracks(tracks, random = Math.random) {
  const shuffled = [...tracks];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
  }
  return shuffled;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return 'Live';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function createMusicService({
  voice = {
    AudioPlayerStatus,
    entersState,
    joinVoiceChannel,
    NoSubscriberBehavior,
    StreamType,
    VoiceConnectionStatus,
    createAudioPlayer,
    createAudioResource,
  },
  audioSource = play,
  spawnProcess = spawn,
  transcoderPath = ffmpegPath,
  getGuildConfig = (guildId) => GuildConfig.findOne({ guildId }).select('music').lean(),
  logger: serviceLogger = logger,
  random = Math.random,
} = {}) {
  const sessions = new Map();

  function createSession(guildId) {
    const player = voice.createAudioPlayer({
      behaviors: { noSubscriber: voice.NoSubscriberBehavior.Pause },
    });
    const session = {
      guildId,
      player,
      connection: null,
      voiceChannelId: null,
      connectionReady: null,
      queue: [],
      currentTrack: null,
      loopMode: 'off',
      volume: 50,
      starting: false,
      skipCurrent: false,
      destroying: false,
      disconnectTimer: null,
      disconnectGeneration: 0,
      connectionRecovery: null,
      ffmpegProcess: null,
      sourceStream: null,
    };
    sessions.set(guildId, session);

    player.on('stateChange', (previous, current) => {
      if (previous.status === voice.AudioPlayerStatus.Idle
        || current.status !== voice.AudioPlayerStatus.Idle) return;
      finishTrack(session);
    });
    player.on('error', (error) => {
      serviceLogger.error('Music audio player failed', {
        guildId,
        track: session.currentTrack?.title,
        error: error.message,
      });
      session.skipCurrent = true;
      session.player.stop(true);
    });

    return session;
  }

  function getSession(guildId) {
    return sessions.get(guildId) || createSession(guildId);
  }

  function cancelIdleDisconnect(session) {
    session.disconnectGeneration += 1;
    if (session.disconnectTimer) clearTimeout(session.disconnectTimer);
    session.disconnectTimer = null;
  }

  function destroySession(session) {
    if (session.destroying) return;
    cancelIdleDisconnect(session);
    if (sessions.get(session.guildId) === session) sessions.delete(session.guildId);
    session.destroying = true;
    session.skipCurrent = true;
    session.queue.length = 0;
    session.sourceStream?.destroy();
    session.ffmpegProcess?.kill();
    session.player.stop(true);
    const connection = session.connection;
    session.connection = null;
    session.voiceChannelId = null;
    if (connection && connection.state.status !== voice.VoiceConnectionStatus.Destroyed) connection.destroy();
  }

  function scheduleIdleDisconnect(session) {
    cancelIdleDisconnect(session);
    const generation = session.disconnectGeneration;
    session.disconnectTimer = setTimeout(() => {
      if (generation !== session.disconnectGeneration
        || session.queue.length
        || session.currentTrack
        || session.starting
        || session.player.state.status !== voice.AudioPlayerStatus.Idle) return;
      destroySession(session);
    }, IDLE_DISCONNECT_MS);
    session.disconnectTimer.unref?.();
  }

  function finishTrack(session) {
    const finishedTrack = session.currentTrack;
    session.currentTrack = null;
    session.sourceStream?.destroy();
    session.sourceStream = null;
    session.ffmpegProcess?.kill();
    session.ffmpegProcess = null;
    if (session.destroying) return;
    if (finishedTrack && !session.skipCurrent) {
      if (session.loopMode === 'track') session.queue.unshift(finishedTrack);
      else if (session.loopMode === 'queue') session.queue.push(finishedTrack);
    }
    session.skipCurrent = false;

    if (session.queue.length) {
      void startNext(session);
    } else if (!session.starting) {
      scheduleIdleDisconnect(session);
    }
  }

  function connectVoiceEvents(session, connection) {
    connection.on('stateChange', (previous, current) => {
      if (current.status === voice.VoiceConnectionStatus.Ready) {
        if (session.disconnectTimer) cancelIdleDisconnect(session);
        session.connectionRecovery = null;
      } else if (current.status === voice.VoiceConnectionStatus.Disconnected
        && !session.connectionRecovery) {
        session.connectionRecovery = voice.entersState(
          connection,
          voice.VoiceConnectionStatus.Ready,
          15_000,
        )
          .catch(() => {
            if (session.connection === connection) destroySession(session);
          })
          .finally(() => {
            session.connectionRecovery = null;
          });
      } else if (current.status === voice.VoiceConnectionStatus.Destroyed
        && session.connection === connection) {
        destroySession(session);
      }
    });
    connection.on('error', (error) => {
      serviceLogger.error('Music voice connection failed', {
        guildId: session.guildId,
        error: error.message,
      });
    });
  }

  async function ensureVoiceConnection(interaction, session) {
    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) throw new MusicError('Join a voice channel first.');
    const botMember = interaction.guild.members.me || await interaction.guild.members.fetchMe();
    const permissions = voiceChannel.permissionsFor(botMember);
    if (!permissions?.has([PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
      throw new MusicError('I need Connect and Speak permissions in your voice channel.');
    }

    if (session.connection?.state.status === voice.VoiceConnectionStatus.Destroyed) {
      session.connection = null;
      session.voiceChannelId = null;
      session.connectionReady = null;
    }
    if (session.connection && session.voiceChannelId !== voiceChannel.id) {
      if (session.currentTrack || session.queue.length || session.starting) {
        throw new MusicError('I am already playing music in another voice channel.');
      }
      const previousConnection = session.connection;
      session.connection = null;
      session.voiceChannelId = null;
      session.connectionReady = null;
      previousConnection.destroy();
    }
    if (session.connection) {
      if (session.connectionReady) await session.connectionReady;
      cancelIdleDisconnect(session);
      return;
    }

    const connection = voice.joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: interaction.guildId,
      adapterCreator: interaction.guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    session.connection = connection;
    session.voiceChannelId = voiceChannel.id;
    connectVoiceEvents(session, connection);
    connection.subscribe(session.player);
    const ready = voice.entersState(connection, voice.VoiceConnectionStatus.Ready, CONNECTION_READY_TIMEOUT_MS)
      .then(() => cancelIdleDisconnect(session))
      .catch(() => {
        if (session.connection === connection) destroySession(session);
        throw new MusicError('I could not connect to that voice channel. Check my voice permissions and try again.');
      })
      .finally(() => {
        if (session.connectionReady === ready) session.connectionReady = null;
      });
    session.connectionReady = ready;
    await ready;
  }

  function assertController(interaction, session) {
    if (!interaction.guildId || !interaction.guild) throw new MusicError('This command can only be used in a server.');
    if (!session.connection || !session.voiceChannelId) throw new MusicError('I am not connected to a voice channel.');
    if (interaction.member?.voice?.channelId !== session.voiceChannelId) {
      throw new MusicError('Join my voice channel to control music.');
    }
  }

  function normalizeTrack(video, requestedById) {
    return {
      title: String(video.title || video.name || 'Untitled track').slice(0, 256),
      url: video.url || video.permalink,
      duration: video.durationInSec,
      thumbnail: video.thumbnails?.[0]?.url || video.thumbnail || null,
      requestedById,
    };
  }

  async function resolveTrack(query, requestedById) {
    const input = query.trim();
    if (!input || input.length > 200) throw new MusicError('Provide a search term or a supported YouTube/SoundCloud track URL.');
    const type = await audioSource.validate(input);
    if (type === 'yt_video') {
      const info = await audioSource.video_info(input);
      const details = info.video_details;
      return normalizeTrack({
        title: details.title,
        url: details.url,
        durationInSec: details.durationInSec,
        thumbnails: details.thumbnails,
      }, requestedById);
    }
    if (type === 'so_track') {
      const track = await audioSource.soundcloud(input);
      if (track.type !== 'track') throw new MusicError('Only individual SoundCloud tracks can be played.');
      return normalizeTrack(track, requestedById);
    }
    if (type !== 'search' && type !== false) {
      throw new MusicError('Playlists and this URL type are not supported. Use a YouTube or SoundCloud track URL.');
    }

    const results = await audioSource.search(input, { limit: 1, source: { youtube: 'video' } });
    if (!results.length) throw new MusicError('No matching tracks were found.');
    return normalizeTrack(results[0], requestedById);
  }

  async function startNext(session) {
    if (session.starting || !session.connection || session.player.state.status !== voice.AudioPlayerStatus.Idle) return;
    cancelIdleDisconnect(session);
    session.starting = true;
    try {
      while (session.queue.length && session.connection) {
        const track = session.queue.shift();
        session.currentTrack = track;
        try {
          if (!transcoderPath) throw new Error('The bundled FFmpeg transcoder is unavailable.');
          const source = await audioSource.stream(track.url, { quality: 2, discordPlayerCompatibility: true });
          session.sourceStream = source.stream;
          const transcoder = spawnProcess(transcoderPath, [
            '-hide_banner',
            '-loglevel', 'error',
            '-i', 'pipe:0',
            '-vn',
            '-ac', '2',
            '-ar', '48000',
            '-f', 's16le',
            'pipe:1',
          ], { stdio: ['pipe', 'pipe', 'pipe'] });
          session.ffmpegProcess = transcoder;
          source.stream.on('error', (error) => {
            serviceLogger.warn('Music source stream failed', { guildId: session.guildId, error: error.message });
            if (session.currentTrack === track) {
              session.skipCurrent = true;
              session.player.stop(true);
            }
          });
          transcoder.stdin.on('error', (error) => {
            if (error.code !== 'EPIPE') {
              serviceLogger.warn('Music transcoder input failed', { guildId: session.guildId, error: error.message });
            }
          });
          transcoder.once('error', (error) => {
            serviceLogger.error('Music transcoder could not start', { guildId: session.guildId, error: error.message });
            if (session.currentTrack === track) {
              session.skipCurrent = true;
              session.player.stop(true);
            }
          });
          transcoder.once('close', (code) => {
            if (session.ffmpegProcess === transcoder) session.ffmpegProcess = null;
            if (code !== 0 && session.currentTrack === track
              && session.player.state.status !== voice.AudioPlayerStatus.Idle) {
              serviceLogger.error('Music transcoder exited unexpectedly', { guildId: session.guildId, code });
              session.skipCurrent = true;
              session.player.stop(true);
            }
          });
          source.stream.pipe(transcoder.stdin);
          const resource = voice.createAudioResource(transcoder.stdout, {
            inputType: voice.StreamType.Raw,
            inlineVolume: true,
            metadata: track,
          });
          resource.volume.setVolume(session.volume / 100);

          if (session.skipCurrent || !session.connection) {
            session.skipCurrent = false;
            session.currentTrack = null;
            source.stream.destroy();
            transcoder.kill();
            continue;
          }
          session.player.play(resource);
          session.starting = false;
          return;
        } catch (error) {
          session.sourceStream?.destroy();
          session.sourceStream = null;
          session.ffmpegProcess?.kill();
          session.ffmpegProcess = null;
          session.currentTrack = null;
          session.skipCurrent = false;
          serviceLogger.error('Music track could not be played', {
            guildId: session.guildId,
            url: track.url,
            error: error.message,
          });
        }
      }
    } finally {
      session.starting = false;
      if (!session.currentTrack && !session.queue.length && session.connection) scheduleIdleDisconnect(session);
    }
  }

  async function enqueue(interaction, query) {
    if (!interaction.guildId || !interaction.guild) throw new MusicError('This command can only be used in a server.');
    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) throw new MusicError('Join a voice channel before requesting a track.');
    const guildConfig = await getGuildConfig(interaction.guildId);
    const maxQueueSize = guildConfig?.music?.maxQueueSize ?? MAX_QUEUE_SIZE;
    const session = getSession(interaction.guildId);
    if (!session.currentTrack && !session.queue.length && !session.starting) {
      session.volume = guildConfig?.music?.defaultVolume ?? session.volume;
    }
    if (session.queue.length >= maxQueueSize) {
      throw new MusicError(`The music queue is full (${maxQueueSize} tracks maximum).`);
    }
    const track = await resolveTrack(query, interaction.user.id);
    await ensureVoiceConnection(interaction, session);
    if (session.queue.length >= maxQueueSize) {
      throw new MusicError(`The music queue is full (${maxQueueSize} tracks maximum).`);
    }
    cancelIdleDisconnect(session);
    const position = session.queue.length + (session.currentTrack || session.starting ? 2 : 1);
    session.queue.push(track);
    if (!session.currentTrack && !session.starting) {
      await startNext(session);
      if (!session.currentTrack) throw new MusicError('I could not start that track. Try another URL or search term.');
    }
    return { track, position, queue: getQueueSnapshot(session) };
  }

  function getQueueSnapshot(session) {
    return {
      current: session.currentTrack,
      upcoming: [...session.queue],
      loopMode: session.loopMode,
      volume: session.volume,
    };
  }

  function getQueue(interaction) {
    if (!interaction.guildId) throw new MusicError('This command can only be used in a server.');
    const session = sessions.get(interaction.guildId);
    if (!session) return { current: null, upcoming: [], loopMode: 'off', volume: 50 };
    assertController(interaction, session);
    return getQueueSnapshot(session);
  }

  function pause(interaction) {
    const session = sessions.get(interaction.guildId);
    if (!session) throw new MusicError('Nothing is currently playing.');
    assertController(interaction, session);
    if (session.player.state.status !== voice.AudioPlayerStatus.Playing || !session.player.pause()) {
      throw new MusicError('Nothing is currently playing.');
    }
  }

  function resume(interaction) {
    const session = sessions.get(interaction.guildId);
    if (!session) throw new MusicError('There is no paused track to resume.');
    assertController(interaction, session);
    if (session.player.state.status !== voice.AudioPlayerStatus.Paused || !session.player.unpause()) {
      throw new MusicError('There is no paused track to resume.');
    }
  }

  function skip(interaction) {
    const session = sessions.get(interaction.guildId);
    if (!session?.currentTrack) throw new MusicError('There is no track to skip.');
    assertController(interaction, session);
    session.skipCurrent = true;
    if (session.starting) return;
    if (!session.player.stop(true)) throw new MusicError('The current track could not be skipped.');
  }

  function stop(interaction) {
    const session = sessions.get(interaction.guildId);
    if (!session) throw new MusicError('There is no music session to stop.');
    assertController(interaction, session);
    session.queue.length = 0;
    session.loopMode = 'off';
    session.skipCurrent = true;
    session.sourceStream?.destroy();
    session.ffmpegProcess?.kill();
    if (!session.player.stop(true) && !session.starting) {
      session.currentTrack = null;
      scheduleIdleDisconnect(session);
    }
  }

  function setVolume(interaction, volume) {
    if (!Number.isInteger(volume) || volume < 0 || volume > MAX_VOLUME) {
      throw new MusicError('Volume must be between 0 and 200.');
    }
    const session = sessions.get(interaction.guildId);
    if (!session) throw new MusicError('There is no active music session.');
    assertController(interaction, session);
    session.volume = volume;
    const resource = session.player.state.resource;
    if (resource.volume) resource.volume.setVolume(volume / 100);
    return volume;
  }

  function setLoop(interaction, mode) {
    if (!['off', 'track', 'queue'].includes(mode)) throw new MusicError('Choose off, track, or queue repeat.');
    const session = sessions.get(interaction.guildId);
    if (!session) throw new MusicError('There is no active music session.');
    assertController(interaction, session);
    session.loopMode = mode;
    return mode;
  }

  function shuffle(interaction) {
    const session = sessions.get(interaction.guildId);
    if (!session) throw new MusicError('There is no active music session.');
    assertController(interaction, session);
    if (session.queue.length < 2) throw new MusicError('Add at least two upcoming tracks before shuffling.');
    session.queue = shuffleTracks(session.queue, random);
    return session.queue.length;
  }

  function nowPlaying(interaction) {
    const session = sessions.get(interaction.guildId);
    if (!session?.currentTrack) throw new MusicError('Nothing is currently playing.');
    assertController(interaction, session);
    return { track: session.currentTrack, volume: session.volume, loopMode: session.loopMode };
  }

  function getDashboardState(guildId) {
    const session = sessions.get(guildId);
    if (!session) return { current: null, upcoming: [], loopMode: 'off', volume: 50, status: 'idle' };
    return {
      ...getQueueSnapshot(session),
      status: session.player.state.status,
      voiceChannelId: session.voiceChannelId,
    };
  }

  async function cleanup() {
    for (const session of sessions.values()) destroySession(session);
  }

  return {
    enqueue,
    getQueue,
    pause,
    resume,
    skip,
    stop,
    setVolume,
    setLoop,
    shuffle,
    nowPlaying,
    getDashboardState,
    cleanup,
    getSessionCount: () => sessions.size,
  };
}

const musicService = createMusicService();

module.exports = {
  IDLE_DISCONNECT_MS,
  MAX_QUEUE_SIZE,
  MAX_VOLUME,
  MusicError,
  createMusicService,
  formatDuration,
  musicService,
  shuffleTracks,
};
