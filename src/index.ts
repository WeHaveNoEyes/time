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
import { Readable } from "stream";
import { readdir } from "fs/promises";
import { join } from "path";
import { createReadStream, existsSync } from "fs";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const INTERVAL_MINUTES = Math.max(1, parseInt(process.env.ANNOUNCE_INTERVAL_MINUTES || "15", 10)) || 15;

if (!DISCORD_TOKEN || !GUILD_ID || !VOICE_CHANNEL_ID || !ELEVENLABS_API_KEY) {
  console.error(
    "Missing required environment variables: DISCORD_TOKEN, GUILD_ID, VOICE_CHANNEL_ID, ELEVENLABS_API_KEY"
  );
  console.error("Copy .env.example to .env and fill in the values.");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

// ---------------------------------------------------------------------------
// Voice styles — ElevenLabs pre-made voice IDs
// ---------------------------------------------------------------------------
const VOICE_STYLES = [
  { voiceId: "21m00Tcm4TlvDq8ikWAM", label: "Rachel" },
  { voiceId: "2EiwWnXFnvU5JabPnv8n", label: "Clyde" },
  { voiceId: "AZnzlk1XvdvUeBnXmlld", label: "Domi" },
  { voiceId: "EXAVITQu4vr4xnSDxMaL", label: "Bella" },
  { voiceId: "ErXwobaYiN019PkySvjV", label: "Antoni" },
  { voiceId: "IKne3meq5aSn9XLyUdCD", label: "Charlie" },
  { voiceId: "MF3mGyEYCl7XYWbV9V6O", label: "Elli" },
  { voiceId: "TxGEqnHWrfWFTfGW9XjX", label: "Josh" },
  { voiceId: "VR6AewLTigWG4xSOukaG", label: "Arnold" },
  { voiceId: "XrExE9yKIg1WjnnlVkGX", label: "Matilda" },
  { voiceId: "pNInz6obpgDQGcFmaJgB", label: "Adam" },
  { voiceId: "yoZ06aMxZJJ28mfd3POQ", label: "Sam" },
  { voiceId: "JBFqnCBsd6RMkjVDRZzb", label: "George" },
  { voiceId: "ThT5KcBeYPX3keUQqHPh", label: "Dorothy" },
  { voiceId: "SOYHLrjzK2X1ezoPC6cr", label: "Harry" },
  { voiceId: "XB0fDUnXU5powFXDhCwa", label: "Charlotte" },
];

// ---------------------------------------------------------------------------
// Funny announcement templates — each is a function that takes the base time
// string (e.g. "3 o'clock P M") and wraps it in something silly.
// ---------------------------------------------------------------------------
const ANNOUNCEMENT_TEMPLATES = [
  (t: string) => `It's ${t}`,
  (t: string) => `Attention please! It's ${t}`,
  (t: string) => `Hear ye, hear ye! The time is ${t}`,
  (t: string) => `Breaking news! It's ${t}`,
  (t: string) => `Ladies and gentlemen, ${t}!`,
  (t: string) => `Oh my god, it's already ${t}`,
  (t: string) => `Bruh. It's ${t}`,
  (t: string) => `Did you know? It's ${t}. Now you know.`,
  (t: string) => `Time check! ${t}. You're welcome.`,
  (t: string) => `Hey! Hey you! It's ${t}!`,
  (t: string) => `Good news everyone! It's ${t}!`,
  (t: string) => `In case you were wondering, it's ${t}`,
  (t: string) => `Ding dong! The time is ${t}`,
  (t: string) => `Plot twist: it's ${t}`,
  (t: string) => `According to my calculations, it is exactly ${t}`,
  (t: string) => `Rise and shine! Just kidding, it's ${t}`,
  (t: string) => `The clock has spoken. It's ${t}`,
  (t: string) => `Sponsored by nobody, it's ${t}`,
  (t: string) => `This just in: the time is ${t}. More at 11.`,
  (t: string) => `OYEZ! OYEZ! OYEZ! The time is ${t}!`,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

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

/** Format the raw time portion (without the wrapper phrase) */
function formatTimePart(hours: number, minutes: number): string {
  const period = hours >= 12 ? "P M" : "A M";
  const displayHours = hours % 12 || 12;
  if (minutes === 0) {
    return `${displayHours} o'clock ${period}`;
  }
  return `${displayHours} ${minutes.toString().padStart(2, "0")} ${period}`;
}

/** Build the full spoken announcement with a random template */
function formatTimeAnnouncement(hours: number, minutes: number): string {
  const timePart = formatTimePart(hours, minutes);
  return pick(ANNOUNCEMENT_TEMPLATES)(timePart);
}

// ---------------------------------------------------------------------------
// Sound effects — drop .mp3 files into sounds/intro/ and sounds/outro/
// and they'll be randomly played before/after the TTS announcement.
// ---------------------------------------------------------------------------

const SOUNDS_DIR = join(import.meta.dir, "..", "sounds");
const INTRO_DIR = join(SOUNDS_DIR, "intro");
const OUTRO_DIR = join(SOUNDS_DIR, "outro");

/** List all .mp3 files in a directory (returns [] if dir doesn't exist) */
async function listSounds(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const files = await readdir(dir);
  return files
    .filter((f) => f.endsWith(".mp3"))
    .map((f) => join(dir, f));
}

/** Pick a random sound file from a directory, or null if none available */
async function pickSound(dir: string): Promise<string | null> {
  const sounds = await listSounds(dir);
  if (sounds.length === 0) return null;
  return pick(sounds);
}

/** Play a single audio resource on a player and wait for it to finish */
async function playResource(
  player: ReturnType<typeof createAudioPlayer>,
  resource: ReturnType<typeof createAudioResource>
): Promise<void> {
  player.play(resource);
  await entersState(player, AudioPlayerStatus.Idle, 30_000);
}

/** Play an .mp3 file through the given player */
async function playSoundFile(
  player: ReturnType<typeof createAudioPlayer>,
  filePath: string
): Promise<void> {
  const stream = createReadStream(filePath);
  const resource = createAudioResource(stream, {
    inputType: StreamType.Arbitrary,
  });
  await playResource(player, resource);
}

// ---------------------------------------------------------------------------
// Main announcement flow
// ---------------------------------------------------------------------------

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
  const voice = pick(VOICE_STYLES);
  const announcement = formatTimeAnnouncement(hours, minutes);
  console.log(
    `[${new Date().toISOString()}] Announcing: "${announcement}" (voice: ${voice.label})`
  );

  const connection = joinVoiceChannel({
    channelId: VOICE_CHANNEL_ID!,
    guildId: GUILD_ID!,
    adapterCreator: guild.voiceAdapterCreator,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);

    const player = createAudioPlayer();
    connection.subscribe(player);

    // 1) Intro sound effect (if any .mp3 files exist in sounds/intro/)
    const introFile = await pickSound(INTRO_DIR);
    if (introFile) {
      console.log(`  Playing intro: ${introFile}`);
      await playSoundFile(player, introFile);
    }

    // 2) TTS announcement with random voice via ElevenLabs
    const ttsResponse = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voice.voiceId}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY!,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text: announcement,
          model_id: "eleven_multilingual_v2",
        }),
      }
    );
    if (!ttsResponse.ok) {
      throw new Error(
        `ElevenLabs API error: ${ttsResponse.status} ${await ttsResponse.text()}`
      );
    }
    const buffer = Buffer.from(await ttsResponse.arrayBuffer());
    const ttsResource = createAudioResource(Readable.from(buffer), {
      inputType: StreamType.Arbitrary,
    });
    await playResource(player, ttsResource);

    // 3) Outro sound effect (if any .mp3 files exist in sounds/outro/)
    const outroFile = await pickSound(OUTRO_DIR);
    if (outroFile) {
      console.log(`  Playing outro: ${outroFile}`);
      await playSoundFile(player, outroFile);
    }

    console.log("Announcement complete, disconnecting.");
  } catch (err) {
    console.error("Error during announcement:", err);
  } finally {
    connection.destroy();
  }
}

/** Milliseconds until the next interval-aligned minute mark */
function msUntilNextInterval(): number {
  const now = new Date();
  const minutesLeft = INTERVAL_MINUTES - (now.getMinutes() % INTERVAL_MINUTES);
  return minutesLeft * 60_000 - now.getSeconds() * 1000 - now.getMilliseconds();
}

client.once("clientReady", () => {
  console.log(`Logged in as ${client.user?.tag}`);
  console.log(`Guild: ${GUILD_ID} | Voice Channel: ${VOICE_CHANNEL_ID}`);

  // Log sound effect status
  const hasIntro = existsSync(INTRO_DIR);
  const hasOutro = existsSync(OUTRO_DIR);
  console.log(
    `Sound effects: intro=${hasIntro ? "enabled" : "no sounds/intro/ dir"}, ` +
      `outro=${hasOutro ? "enabled" : "no sounds/outro/ dir"}`
  );
  console.log(`Voice styles loaded: ${VOICE_STYLES.length}`);
  console.log(`Announce interval: every ${INTERVAL_MINUTES} minute${INTERVAL_MINUTES === 1 ? "" : "s"}`);

  const delay = msUntilNextInterval();
  const nextAt = new Date(Date.now() + delay);
  console.log(
    `Next announcement at ${nextAt.toLocaleTimeString("en-US", { timeZone: "America/New_York" })} ET ` +
      `(in ${Math.round(delay / 1000)}s)`
  );

  setTimeout(() => {
    announceTime();
    setInterval(announceTime, INTERVAL_MINUTES * 60_000);
  }, delay);
});

client.login(DISCORD_TOKEN);
