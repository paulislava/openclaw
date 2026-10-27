import { sendLocationTelegram } from "./send-location.js";
import type { TelegramLocationSendOpts, TelegramSendOpts } from "./send-message-types.js";
import { sendMessageTelegram } from "./send-message.js";

export function sendLegacyLocationTelegram(
  to: string,
  location: { latitude: number; longitude: number; horizontalAccuracy?: number },
  opts: TelegramLocationSendOpts,
) {
  return sendLocationTelegram(
    to,
    {
      latitude: location.latitude,
      longitude: location.longitude,
      ...(location.horizontalAccuracy !== undefined
        ? { accuracy: location.horizontalAccuracy }
        : {}),
    },
    opts,
  );
}

export function sendVenueTelegram(
  to: string,
  venue: {
    latitude: number;
    longitude: number;
    title: string;
    address: string;
    foursquareId?: string;
    googlePlaceId?: string;
  },
  opts: TelegramLocationSendOpts,
) {
  return sendLocationTelegram(
    to,
    {
      latitude: venue.latitude,
      longitude: venue.longitude,
      name: venue.title,
      address: venue.address,
    },
    { ...opts, foursquareId: venue.foursquareId, googlePlaceId: venue.googlePlaceId },
  );
}

export async function sendVideoNoteTelegram(to: string, mediaUrl: string, opts: TelegramSendOpts) {
  if (!mediaUrl.trim()) {
    throw new Error("mediaUrl is required");
  }
  return await sendMessageTelegram(to, "", { ...opts, mediaUrl, asVideoNote: true });
}
