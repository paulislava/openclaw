import type { Command } from "commander";

type MessageCliHelpers = {
  withMessageBase: (command: Command, target?: "required") => Command;
  runMessageAction: (action: string, opts: Record<string, unknown>) => Promise<void>;
};

/** Keep the fork's CLI names while routing through the current send owner. */
export function registerMessageLocationCommands(message: Command, helpers: MessageCliHelpers) {
  const coordinates = (command: Command) =>
    command
      .requiredOption("--latitude <number>", "Latitude (-90 to 90)", Number)
      .requiredOption("--longitude <number>", "Longitude (-180 to 180)", Number);
  coordinates(helpers.withMessageBase(message.command("sendLocation"), "required"))
    .description("Send a Telegram location pin")
    .option("--horizontal-accuracy <metres>", "Uncertainty radius in metres", Number)
    .action(async (opts) => {
      const { latitude, longitude, horizontalAccuracy, ...rest } = opts;
      await helpers.runMessageAction("send", {
        ...rest,
        location: {
          latitude,
          longitude,
          ...(horizontalAccuracy !== undefined ? { accuracy: horizontalAccuracy } : {}),
        },
      });
    });
  coordinates(helpers.withMessageBase(message.command("sendVenue"), "required"))
    .description("Send a Telegram venue card")
    .requiredOption("--title <name>", "Venue name")
    .requiredOption("--address <address>", "Venue address")
    .option("--foursquare-id <id>", "Foursquare venue ID")
    .option("--google-place-id <id>", "Google Places ID")
    .action(async (opts) => {
      const { latitude, longitude, title, address, ...rest } = opts;
      await helpers.runMessageAction("send", {
        ...rest,
        location: { latitude, longitude, name: title, address },
      });
    });
  helpers
    .withMessageBase(message.command("sendVideoNote"), "required")
    .description("Send a round Telegram video note")
    .requiredOption("--media <path-or-url>", "Square MP4 video URL or local path")
    .action(async (opts) => {
      const { media, ...rest } = opts;
      await helpers.runMessageAction("send", { ...rest, mediaUrls: [media], asVideoNote: true });
    });
}
