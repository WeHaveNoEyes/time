import { Client, GatewayIntentBits } from "discord.js";
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  StreamType,
} from "@discordjs/voice";
import googleTTS from "google-tts-api";
import { Readable } from "stream";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID;

if (!DISCORD_TOKEN || !GUILD_ID || !VOICE_CHANNEL_ID) {
  console.error(
    "Missing required environment variables: DISCORD_TOKEN, GUILD_ID, VOICE_CHANNEL_ID"
  );
  console.error("Copy .env.example to .env and fill in the values.");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

/** Get the current time interpreted as Eastern Time */
function getEasternTime(): { hours: number; minutes: number } {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const hours = parseInt(parts.find((p) => p.type === "hour")!.value, 10);
  const minutes = parseInt(parts.find((p) => p.type === "minute")!.value, 10);
  return { hours, minutes };
}

/** Format a spoken time announcement string */
function formatTimeAnnouncement(hours: number, minutes: number): string {
  const period = hours >= 12 ? "P M" : "A M";
  const displayHours = hours % 12 || 12;

  if (minutes === 0) {
    return `It's ${displayHours} o'clock ${period}`;
  }
  return `It's ${displayHours} ${minutes.toString().padStart(2, "0")} ${period}`;
}

/** Join voice channel, play the time announcement, then disconnect */
async function announceTime(): Promise<void> {
  const guild = client.guilds.cache.get(GUILD_ID!);
  if (!guild) {
    console.error(`Guild ${GUILD_ID} not found — is the bot in the server?`);
    return;
  }

  const channel = guild.channels.cache.get(VOICE_CHANNEL_ID!);
  if (!channel?.isVoiceBased()) {
    console.error(`Voice channel ${VOICE_CHANNEL_ID} not found`);
    return;
  }

  const { hours, minutes } = getEasternTime();
  const announcement = formatTimeAnnouncement(hours, minutes);
  console.log(`[${new Date().toISOString()}] Announcing: "${announcement}"`);

  const connection = joinVoiceChannel({
    channelId: VOICE_CHANNEL_ID!,
    guildId: GUILD_ID!,
    adapterCreator: guild.voiceAdapterCreator,
  });

  try {
    // Wait for the voice connection to be ready
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);

    // Generate TTS audio (returns base64-encoded MP3)
    const base64Audio = await googleTTS.getAudioBase64(announcement, {
      lang: "en",
      slow: false,
    });

    const buffer = Buffer.from(base64Audio, "base64");
    const stream = Readable.from(buffer);

    const resource = createAudioResource(stream, {
      inputType: StreamType.Arbitrary,
    });

    const player = createAudioPlayer();
    connection.subscribe(player);
    player.play(resource);

    // Wait for playback to finish
    await entersState(player, AudioPlayerStatus.Idle, 30_000);
    console.log("Announcement complete, disconnecting.");
  } catch (err) {
    console.error("Error during announcement:", err);
  } finally {
    connection.destroy();
  }
}

/** Milliseconds until the next :00 / :15 / :30 / :45 mark */
function msUntilNext15Min(): number {
  const now = new Date();
  const minutesLeft = 15 - (now.getMinutes() % 15);
  return minutesLeft * 60_000 - now.getSeconds() * 1000 - now.getMilliseconds();
}

client.once("ready", () => {
  console.log(`Logged in as ${client.user?.tag}`);
  console.log(`Guild: ${GUILD_ID} | Voice Channel: ${VOICE_CHANNEL_ID}`);

  const delay = msUntilNext15Min();
  const nextAt = new Date(Date.now() + delay);
  console.log(
    `Next announcement at ${nextAt.toLocaleTimeString("en-US", { timeZone: "America/New_York" })} ET ` +
      `(in ${Math.round(delay / 1000)}s)`
  );

  setTimeout(() => {
    announceTime();
    setInterval(announceTime, 15 * 60_000);
  }, delay);
});

client.login(DISCORD_TOKEN);
